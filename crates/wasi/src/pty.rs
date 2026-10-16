use super::{PIPE_BYTES, Pipe};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

const LINE_BYTES: usize = 4096;
const MAX_LINES: usize = 4096;

pub(super) struct Terminal {
    pub input: Rc<Pipe>,
    pub output: Rc<Pipe>,
    pub raw: Cell<bool>,
    line: RefCell<Vec<u8>>,
    lines: RefCell<VecDeque<usize>>,
}

pub(super) struct Side {
    pub terminal: Rc<Terminal>,
    pub master: bool,
}

impl Terminal {
    pub fn new() -> Rc<Self> {
        let pipe = || {
            Rc::new(Pipe {
                bytes: RefCell::new(VecDeque::new()),
                readers: Cell::new(1),
                writers: Cell::new(1),
            })
        };
        Rc::new(Self {
            input: pipe(),
            output: pipe(),
            raw: Cell::new(false),
            line: RefCell::new(Vec::new()),
            lines: RefCell::new(VecDeque::new()),
        })
    }

    pub fn set_raw(&self, enabled: bool) {
        if self.raw.replace(enabled) == enabled {
            return;
        }
        self.lines.borrow_mut().clear();
        if enabled {
            self.input
                .bytes
                .borrow_mut()
                .extend(self.line.borrow_mut().drain(..));
        } else {
            let size = self.input.bytes.borrow().len();
            if size > 0 {
                self.lines.borrow_mut().push_back(size);
            }
        }
    }

    pub fn available(&self) -> usize {
        if self.raw.get() {
            return self.input.bytes.borrow().len();
        }
        self.lines.borrow().front().copied().unwrap_or(0)
    }

    pub fn capacity(&self) -> usize {
        let used = self.input.bytes.borrow().len() + self.line.borrow().len();
        let available = PIPE_BYTES - used;
        if self.raw.get() {
            return available;
        }
        available.min(PIPE_BYTES - self.output.bytes.borrow().len())
    }

    pub fn finish_input(&self) -> bool {
        if self.line.borrow().is_empty() {
            return true;
        }
        if self.lines.borrow().len() >= MAX_LINES {
            return false;
        }
        let size = self.line.borrow().len();
        self.input
            .bytes
            .borrow_mut()
            .extend(self.line.borrow_mut().drain(..));
        self.lines.borrow_mut().push_back(size);
        true
    }

    pub fn ready(&self) -> bool {
        if self.raw.get() {
            return !self.input.bytes.borrow().is_empty();
        }
        !self.lines.borrow().is_empty()
    }

    pub fn consume(&self, length: usize) {
        if self.raw.get() {
            return;
        }
        let mut lines = self.lines.borrow_mut();
        if let Some(first) = lines.front_mut() {
            *first -= length;
            if *first == 0 {
                lines.pop_front();
            }
        }
    }

    fn echo(&self, byte: u8) -> Vec<u8> {
        match byte {
            4 => Vec::new(),
            127 if !self.line.borrow().is_empty() => b"\x08 \x08".to_vec(),
            127 => Vec::new(),
            21 => b"^U\r\n".to_vec(),
            3 | 28 => vec![b'^', byte + 64, b'\r', b'\n'],
            b'\r' | b'\n' => b"\r\n".to_vec(),
            b'\t' => vec![byte],
            0..=31 => vec![b'^', byte + 64],
            _ => vec![byte],
        }
    }

    pub fn writable(&self, master: bool, byte: u8) -> bool {
        if !master {
            let required = if !self.raw.get() && byte == b'\n' {
                2
            } else {
                1
            };
            return self.output.bytes.borrow().len() + required <= PIPE_BYTES;
        }
        if self.raw.get() {
            return self.input.bytes.borrow().len() < PIPE_BYTES;
        }
        let size = self.line.borrow().len();
        if size == LINE_BYTES && !matches!(byte, 3 | 4 | 10 | 13 | 21 | 28 | 127) {
            return true;
        }
        if self.output.bytes.borrow().len() + self.echo(byte).len() > PIPE_BYTES {
            return false;
        }
        if matches!(byte, 4 | 10 | 13) && self.lines.borrow().len() >= MAX_LINES {
            return false;
        }
        if matches!(byte, 3 | 4 | 21 | 28 | 127) {
            return true;
        }
        self.input.bytes.borrow().len() + size < PIPE_BYTES
    }

    pub fn write(&self, master: bool, data: &[u8]) -> Result<usize, i32> {
        let mut count = 0;
        for &byte in data {
            if !self.writable(master, byte) {
                break;
            }
            if !master {
                let mut output = self.output.bytes.borrow_mut();
                if !self.raw.get() && byte == b'\n' {
                    output.push_back(b'\r');
                }
                output.push_back(byte);
            } else if self.raw.get() {
                self.input.bytes.borrow_mut().push_back(byte);
            } else {
                if self.line.borrow().len() == LINE_BYTES
                    && !matches!(byte, 3 | 4 | 10 | 13 | 21 | 28 | 127)
                {
                    if count == 0 {
                        return Err(22);
                    }
                    break;
                }
                self.output.bytes.borrow_mut().extend(self.echo(byte));
                match byte {
                    127 => {
                        self.line.borrow_mut().pop();
                    }
                    3 | 21 | 28 => {
                        self.line.borrow_mut().clear();
                    }
                    4 => {
                        let size = self.line.borrow().len();
                        self.input
                            .bytes
                            .borrow_mut()
                            .extend(self.line.borrow_mut().drain(..));
                        self.lines.borrow_mut().push_back(size);
                    }
                    b'\r' | b'\n' => {
                        self.line.borrow_mut().push(b'\n');
                        let size = self.line.borrow().len();
                        self.input
                            .bytes
                            .borrow_mut()
                            .extend(self.line.borrow_mut().drain(..));
                        self.lines.borrow_mut().push_back(size);
                    }
                    _ => self.line.borrow_mut().push(byte),
                }
            }
            count += 1;
        }
        if count == 0 && !data.is_empty() {
            return Err(6);
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_input_keeps_line_boundaries_and_transient_eof() {
        let tty = Terminal::new();
        assert_eq!(tty.write(true, b"abX\x7fc\r"), Ok(6));
        assert_eq!(tty.available(), 4);
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"abc\n"
        );
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"abX\x08 \x08c\r\n"
        );
        tty.input.bytes.borrow_mut().clear();
        tty.consume(4);
        assert_eq!(tty.write(true, b"\x04next\n"), Ok(6));
        assert!(tty.ready());
        assert_eq!(tty.available(), 0);
        tty.consume(0);
        assert_eq!(tty.available(), 5);
    }

    #[test]
    fn raw_mode_preserves_bytes_and_flushes_uncommitted_input() {
        let tty = Terminal::new();
        tty.write(true, b"partial").unwrap();
        assert!(!tty.ready());
        tty.set_raw(true);
        assert_eq!(tty.available(), 7);
        assert_eq!(tty.write(true, b"\0\x03\x04\r\n\x7f"), Ok(6));
        assert_eq!(tty.write(false, b"a\nb"), Ok(3));
        assert!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>()
                .ends_with(b"a\nb")
        );
        tty.set_raw(false);
        assert_eq!(tty.available(), 13);
    }

    #[test]
    fn buffers_and_line_records_are_bounded_without_dropping_input() {
        let tty = Terminal::new();
        tty.set_raw(true);
        assert_eq!(tty.write(true, &vec![42; PIPE_BYTES + 1]), Ok(PIPE_BYTES));
        assert_eq!(tty.write(true, b"x"), Err(6));
        let cooked = Terminal::new();
        assert_eq!(
            cooked.write(true, &vec![b'x'; LINE_BYTES + 1]),
            Ok(LINE_BYTES)
        );
        assert_eq!(cooked.write(true, b"x"), Err(22));
        assert_eq!(cooked.write(true, b"\n"), Ok(1));
        assert_eq!(cooked.available(), LINE_BYTES + 1);
        let eof = Terminal::new();
        assert_eq!(eof.write(true, &vec![4; MAX_LINES + 1]), Ok(MAX_LINES));
        assert_eq!(eof.write(true, b"\x04"), Err(6));
    }
}
