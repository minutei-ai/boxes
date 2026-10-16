use super::{PIPE_BYTES, Pipe};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

const LINE_BYTES: usize = 4096;
const MAX_LINES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Termios {
    pub icrnl: bool,
    pub opost: bool,
    pub onlcr: bool,
    pub icanon: bool,
    pub echo: bool,
    pub isig: bool,
    pub cc: [u8; 7],
}

impl Default for Termios {
    fn default() -> Self {
        Self {
            icrnl: true,
            opost: true,
            onlcr: true,
            icanon: true,
            echo: true,
            isig: true,
            cc: [3, 28, 26, 4, 127, 21, 23],
        }
    }
}

impl Termios {
    pub fn decode(bytes: &[u8]) -> Result<Self, i32> {
        let bytes: &[u8; 12] = bytes.try_into().map_err(|_| 28)?;
        let flags = u32::from_le_bytes(bytes[..4].try_into().map_err(|_| 28)?);
        if flags & !63 != 0 || bytes[11] != 0 {
            return Err(28);
        }
        Ok(Self {
            icrnl: flags & 1 != 0,
            opost: flags & 2 != 0,
            onlcr: flags & 4 != 0,
            icanon: flags & 8 != 0,
            echo: flags & 16 != 0,
            isig: flags & 32 != 0,
            cc: bytes[4..11].try_into().map_err(|_| 28)?,
        })
    }

    pub fn encode(self) -> [u8; 12] {
        let flags = u32::from(self.icrnl)
            | (u32::from(self.opost) << 1)
            | (u32::from(self.onlcr) << 2)
            | (u32::from(self.icanon) << 3)
            | (u32::from(self.echo) << 4)
            | (u32::from(self.isig) << 5);
        let mut bytes = [0; 12];
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        bytes[4..11].copy_from_slice(&self.cc);
        bytes
    }

    fn with_raw(self, enabled: bool) -> Self {
        Self {
            icrnl: !enabled,
            opost: !enabled,
            onlcr: !enabled,
            icanon: !enabled,
            echo: !enabled,
            isig: !enabled,
            cc: self.cc,
        }
    }
}

#[derive(Clone, Copy)]
enum Input {
    Signal { number: u32, byte: u8 },
    Eof,
    Erase(usize),
    Line,
    Byte(u8),
}

struct RawLease {
    owner: u32,
    token: u64,
    applied: u64,
    restore: Termios,
}

pub(super) struct Terminal {
    pub input: Rc<Pipe>,
    pub output: Rc<Pipe>,
    pub termios: Cell<Termios>,
    pub cols: Cell<u16>,
    pub rows: Cell<u16>,
    pub revision: Cell<u32>,
    pub foreground: Cell<u32>,
    pub signals: Cell<u64>,
    line: RefCell<Vec<u8>>,
    lines: RefCell<VecDeque<usize>>,
    raw_leases: RefCell<Vec<RawLease>>,
    attributes_generation: Cell<u64>,
    raw_token: Cell<u64>,
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
            termios: Cell::new(Termios::default()),
            cols: Cell::new(80),
            rows: Cell::new(24),
            revision: Cell::new(0),
            foreground: Cell::new(0),
            signals: Cell::new(0),
            line: RefCell::new(Vec::new()),
            lines: RefCell::new(VecDeque::new()),
            raw_leases: RefCell::new(Vec::new()),
            attributes_generation: Cell::new(0),
            raw_token: Cell::new(0),
        })
    }

    pub fn set_raw(&self, owner: Option<u32>, enabled: bool) -> Result<Option<u64>, i32> {
        let generation = self.attributes_generation.get().checked_add(1).ok_or(29)?;
        if !enabled {
            if let Some(owner) = owner
                && self.release_raw(owner, None)
            {
                return Ok(None);
            }
            self.attributes_generation.set(generation);
            self.apply_attributes(self.termios.get().with_raw(false));
            return Ok(None);
        }
        let Some(owner) = owner else {
            self.attributes_generation.set(generation);
            self.apply_attributes(self.termios.get().with_raw(true));
            return Ok(None);
        };
        let mut leases = self.raw_leases.borrow_mut();
        if let Some(index) = leases.iter().position(|lease| lease.owner == owner)
            && index + 1 == leases.len()
        {
            self.attributes_generation.set(generation);
            self.apply_attributes(self.termios.get().with_raw(true));
            leases[index].applied = generation;
            return Ok(Some(leases[index].token));
        }
        let token = self.raw_token.get().checked_add(1).ok_or(29)?;
        if let Some(index) = leases.iter().position(|lease| lease.owner == owner) {
            let lease = leases.remove(index);
            leases[index].restore = lease.restore;
        }
        leases.push(RawLease {
            owner,
            token,
            applied: generation,
            restore: self.termios.get(),
        });
        self.raw_token.set(token);
        self.attributes_generation.set(generation);
        self.apply_attributes(self.termios.get().with_raw(true));
        Ok(Some(token))
    }

    pub fn release_raw(&self, owner: u32, token: Option<u64>) -> bool {
        let mut leases = self.raw_leases.borrow_mut();
        let Some(index) = leases.iter().position(|lease| {
            lease.owner == owner && token.is_none_or(|token| token == lease.token)
        }) else {
            return false;
        };
        let lease = leases.remove(index);
        if index < leases.len() {
            leases[index].restore = lease.restore;
        } else if lease.applied == self.attributes_generation.get() {
            let generation = self.attributes_generation.get().saturating_add(1);
            self.attributes_generation.set(generation);
            self.apply_attributes(lease.restore);
            if let Some(previous) = leases.last_mut() {
                previous.applied = generation;
            }
        }
        true
    }

    pub fn set_attributes(&self, attributes: Termios) -> Result<(), i32> {
        let generation = self.attributes_generation.get().checked_add(1).ok_or(29)?;
        self.attributes_generation.set(generation);
        self.apply_attributes(attributes);
        Ok(())
    }

    fn apply_attributes(&self, attributes: Termios) {
        let previous = self.termios.replace(attributes);
        if previous.icanon == attributes.icanon {
            return;
        }
        self.lines.borrow_mut().clear();
        if !attributes.icanon {
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
        if !self.termios.get().icanon {
            return self.input.bytes.borrow().len();
        }
        self.lines.borrow().front().copied().unwrap_or(0)
    }

    pub fn capacity(&self) -> usize {
        let used = self.input.bytes.borrow().len() + self.line.borrow().len();
        let available = PIPE_BYTES - used;
        if !self.termios.get().echo {
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
        if !self.termios.get().icanon {
            return !self.input.bytes.borrow().is_empty();
        }
        !self.lines.borrow().is_empty()
    }

    pub fn consume(&self, length: usize) {
        if !self.termios.get().icanon {
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

    fn input(&self, attributes: Termios, mut byte: u8) -> Input {
        if attributes.icrnl && byte == b'\r' {
            byte = b'\n';
        }
        if attributes.isig {
            for (control, number) in attributes.cc[..3].iter().zip([2, 3, 20]) {
                if byte == *control {
                    return Input::Signal { number, byte };
                }
            }
        }
        if attributes.icanon {
            if byte == attributes.cc[3] {
                return Input::Eof;
            }
            let line = self.line.borrow();
            if byte == attributes.cc[4] || byte == 8 {
                return Input::Erase(usize::from(!line.is_empty()));
            }
            if byte == attributes.cc[5] {
                return Input::Erase(line.len());
            }
            if byte == attributes.cc[6] {
                let spaces = line
                    .iter()
                    .rev()
                    .take_while(|&&b| b == b' ' || b == b'\t')
                    .count();
                let word = line
                    .iter()
                    .rev()
                    .skip(spaces)
                    .take_while(|&&b| b != b' ' && b != b'\t')
                    .count();
                return Input::Erase(spaces + word);
            }
            if byte == b'\n' {
                return Input::Line;
            }
        }
        Input::Byte(byte)
    }

    fn displayed(byte: u8) -> ([u8; 2], usize) {
        if byte < 32 {
            return ([b'^', byte + 64], 2);
        }
        if byte == 127 {
            return (*b"^?", 2);
        }
        ([byte, 0], 1)
    }

    fn echo_length(&self, attributes: Termios, input: Input) -> usize {
        if !attributes.echo {
            return 0;
        }
        match input {
            Input::Signal { byte, .. } if self.foreground.get() == 0 => {
                Self::displayed(byte).1 + 2 * usize::from(attributes.icanon)
            }
            Input::Signal { .. } | Input::Eof => 0,
            Input::Erase(count) => self
                .line
                .borrow()
                .iter()
                .rev()
                .take(count)
                .map(|byte| Self::displayed(*byte).1 * 3)
                .sum(),
            Input::Line => 2,
            Input::Byte(byte) if attributes.icanon => Self::displayed(byte).1,
            Input::Byte(_) => 1,
        }
    }

    fn writable_input(&self, attributes: Termios, input: Input) -> bool {
        let length = self.line.borrow().len();
        if attributes.icanon && matches!(input, Input::Byte(_)) && length == LINE_BYTES {
            return true;
        }
        if self.output.bytes.borrow().len() + self.echo_length(attributes, input) > PIPE_BYTES {
            return false;
        }
        let (removed, added, record) = match input {
            Input::Signal { .. } if attributes.icanon => (
                length,
                usize::from(self.foreground.get() == 0),
                self.foreground.get() == 0,
            ),
            Input::Signal { .. } => (0, 0, false),
            Input::Eof => (0, 0, true),
            Input::Line => (0, 1, true),
            Input::Erase(count) => (count, 0, false),
            Input::Byte(_) => (0, 1, false),
        };
        if record && self.lines.borrow().len() >= MAX_LINES {
            return false;
        }
        self.input.bytes.borrow().len() + length - removed + added <= PIPE_BYTES
    }

    pub fn writable(&self, master: bool, byte: u8) -> bool {
        let attributes = self.termios.get();
        if master {
            return self.writable_input(attributes, self.input(attributes, byte));
        }
        let required = 1 + usize::from(attributes.opost && attributes.onlcr && byte == b'\n');
        self.output.bytes.borrow().len() + required <= PIPE_BYTES
    }

    pub fn write(&self, master: bool, data: &[u8]) -> Result<usize, i32> {
        let attributes = self.termios.get();
        if master && !attributes.icanon && !attributes.echo && !attributes.isig && !attributes.icrnl
        {
            let count = data.len().min(PIPE_BYTES - self.input.bytes.borrow().len());
            if count == 0 && !data.is_empty() {
                return Err(6);
            }
            self.input.bytes.borrow_mut().extend(&data[..count]);
            return Ok(count);
        }
        let low_controls = attributes.cc.iter().all(|byte| *byte < 32 || *byte == 127);
        let mut count = 0;
        while count < data.len() {
            if master && attributes.icanon {
                let length = self.line.borrow().len();
                let mut available = (LINE_BYTES - length)
                    .min(PIPE_BYTES - self.input.bytes.borrow().len() - length);
                if attributes.echo {
                    available = available.min(PIPE_BYTES - self.output.bytes.borrow().len());
                }
                let ordinary = data[count..]
                    .iter()
                    .take(available)
                    .take_while(|&&byte| {
                        byte >= 32
                            && byte != 127
                            && (low_controls || !attributes.cc.contains(&byte))
                    })
                    .count();
                if ordinary != 0 {
                    let bytes = &data[count..count + ordinary];
                    self.line.borrow_mut().extend_from_slice(bytes);
                    if attributes.echo {
                        self.output.bytes.borrow_mut().extend(bytes);
                    }
                    count += ordinary;
                    continue;
                }
            }
            let byte = data[count];
            if !master {
                let translated = attributes.opost
                    && attributes.onlcr
                    && byte == b'\n'
                    && (count == 0 || data[count - 1] != b'\r');
                let mut output = self.output.bytes.borrow_mut();
                if output.len() + 1 + usize::from(translated) > PIPE_BYTES {
                    break;
                }
                if translated {
                    output.push_back(b'\r');
                }
                output.push_back(byte);
                count += 1;
                continue;
            }
            let input = self.input(attributes, byte);
            if attributes.icanon
                && matches!(input, Input::Byte(_))
                && self.line.borrow().len() == LINE_BYTES
            {
                if count == 0 {
                    return Err(22);
                }
                break;
            }
            if !self.writable_input(attributes, input) {
                break;
            }
            if attributes.echo {
                let mut output = self.output.bytes.borrow_mut();
                match input {
                    Input::Signal { byte, .. } if self.foreground.get() == 0 => {
                        let (bytes, length) = Self::displayed(byte);
                        output.extend(&bytes[..length]);
                        if attributes.icanon {
                            output.extend(b"\r\n");
                        }
                    }
                    Input::Signal { .. } | Input::Eof => {}
                    Input::Erase(count) => {
                        for byte in self.line.borrow().iter().rev().take(count) {
                            for _ in 0..Self::displayed(*byte).1 {
                                output.extend([8, b' ', 8]);
                            }
                        }
                    }
                    Input::Line => output.extend(b"\r\n"),
                    Input::Byte(byte) if attributes.icanon => {
                        let (bytes, length) = Self::displayed(byte);
                        output.extend(&bytes[..length]);
                    }
                    Input::Byte(byte) => output.push_back(byte),
                }
            }
            match input {
                Input::Signal { number, .. } => {
                    if attributes.icanon {
                        self.line.borrow_mut().clear();
                    }
                    if self.foreground.get() != 0 {
                        self.signals.set(self.signals.get() | (1 << (number - 1)));
                    } else if attributes.icanon {
                        self.input.bytes.borrow_mut().push_back(b'\n');
                        self.lines.borrow_mut().push_back(1);
                    }
                }
                Input::Erase(count) => {
                    let length = self.line.borrow().len();
                    self.line.borrow_mut().truncate(length - count);
                }
                Input::Line | Input::Eof => {
                    if matches!(input, Input::Line) {
                        self.line.borrow_mut().push(b'\n');
                    }
                    let length = self.line.borrow().len();
                    self.input
                        .bytes
                        .borrow_mut()
                        .extend(self.line.borrow_mut().drain(..));
                    self.lines.borrow_mut().push_back(length);
                }
                Input::Byte(byte) if attributes.icanon => self.line.borrow_mut().push(byte),
                Input::Byte(byte) => self.input.bytes.borrow_mut().push_back(byte),
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
    fn attributes_round_trip_every_flag_combination_and_reject_reserved_bits() {
        for flags in 0u8..64 {
            let bytes = [flags, 0, 0, 0, 0, 255, 26, 4, 127, 21, 23, 0];
            assert_eq!(Termios::decode(&bytes).unwrap().encode(), bytes);
        }
        assert_eq!(Termios::decode(&[0; 11]), Err(28));
        let mut bytes = Termios::default().encode();
        bytes[3] = 1;
        assert_eq!(Termios::decode(&bytes), Err(28));
        bytes[3] = 0;
        bytes[11] = 1;
        assert_eq!(Termios::decode(&bytes), Err(28));
        let tty = Terminal::new();
        tty.attributes_generation.set(u64::MAX);
        assert_eq!(
            tty.set_attributes(Termios::default().with_raw(true)),
            Err(29)
        );
        assert_eq!(tty.termios.get(), Termios::default());
    }

    #[test]
    fn canonical_input_translation_echo_and_output_translation_are_independent() {
        let tty = Terminal::new();
        tty.set_attributes(Termios {
            echo: false,
            icrnl: false,
            ..Termios::default()
        })
        .unwrap();
        assert_eq!(tty.write(true, b"a\r"), Ok(2));
        assert!(!tty.ready());
        assert_eq!(tty.write(true, b"\n"), Ok(1));
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"a\r\n"
        );
        assert!(tty.output.bytes.borrow().is_empty());
        for (opost, onlcr, expected) in [
            (false, true, b"a\r\nb\n".as_slice()),
            (true, false, b"a\r\nb\n".as_slice()),
            (true, true, b"a\r\nb\r\n".as_slice()),
        ] {
            tty.set_attributes(Termios {
                opost,
                onlcr,
                ..Termios::default()
            })
            .unwrap();
            tty.output.bytes.borrow_mut().clear();
            assert_eq!(tty.write(false, b"a\r\nb\n"), Ok(5));
            assert_eq!(
                tty.output
                    .bytes
                    .borrow()
                    .iter()
                    .copied()
                    .collect::<Vec<_>>(),
                expected
            );
        }
        let partial = Terminal::new();
        partial.write(true, b"hel").unwrap();
        partial
            .set_attributes(Termios {
                echo: false,
                ..Termios::default()
            })
            .unwrap();
        partial.write(true, b"lo\n").unwrap();
        assert_eq!(
            partial
                .input
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"hello\n"
        );
        assert_eq!(
            partial
                .output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"hel"
        );
        let full = Terminal::new();
        full.output.bytes.borrow_mut().resize(PIPE_BYTES, b'x');
        full.set_attributes(Termios {
            echo: false,
            ..Termios::default()
        })
        .unwrap();
        assert_eq!(full.capacity(), PIPE_BYTES);
        assert_eq!(full.write(true, b"x\n"), Ok(2));
        full.set_attributes(Termios::default()).unwrap();
        assert_eq!(full.capacity(), 0);
        assert_eq!(full.write(true, b"\n"), Err(6));
    }

    #[test]
    fn noncanonical_echo_and_signals_do_not_require_canonical_input() {
        let tty = Terminal::new();
        tty.foreground.set(2);
        tty.set_attributes(Termios {
            icanon: false,
            ..Termios::default()
        })
        .unwrap();
        assert_eq!(tty.write(true, b"A\r\x03\x01"), Ok(4));
        assert_eq!(tty.available(), 3);
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"A\n\x01"
        );
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"A\n\x01"
        );
        assert_eq!(tty.signals.get(), 1 << 1);
        tty.set_attributes(Termios {
            isig: false,
            echo: false,
            icanon: false,
            ..Termios::default()
        })
        .unwrap();
        assert_eq!(tty.write(true, b"\x03\x04\x15"), Ok(3));
        assert!(
            tty.input
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>()
                .ends_with(b"\x03\x04\x15")
        );
    }

    #[test]
    fn custom_controls_edit_words_and_lines_and_erase_caret_echo_width() {
        let tty = Terminal::new();
        tty.foreground.set(2);
        tty.set_attributes(Termios {
            cc: *b"!?~@#%&",
            ..Termios::default()
        })
        .unwrap();
        let input = b"abx#c one  &\x01\x08Z%q@!?~";
        assert_eq!(tty.write(true, input), Ok(input.len()));
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"q"
        );
        assert_eq!(tty.signals.get(), (1 << 1) | (1 << 2) | (1 << 19));
        let mut expected = b"abx\x08 \x08c one  ".to_vec();
        expected.extend(b"\x08 \x08".repeat(5));
        expected.extend(b"^A");
        expected.extend(b"\x08 \x08".repeat(2));
        expected.extend(b"Z");
        expected.extend(b"\x08 \x08".repeat(5));
        expected.extend(b"q");
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            expected
        );
        tty.output.bytes.borrow_mut().clear();
        assert_eq!(tty.write(true, b"a b\t\t&@"), Ok(7));
        let mut expected = b"a b^I^I".to_vec();
        expected.extend(b"\x08 \x08".repeat(5));
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"qa "
        );
    }

    #[test]
    fn erase_and_kill_backpressure_never_partially_changes_the_line_or_echo() {
        let tty = Terminal::new();
        tty.write(true, &vec![1; LINE_BYTES]).unwrap();
        let needed = LINE_BYTES * 6;
        tty.output
            .bytes
            .borrow_mut()
            .resize(PIPE_BYTES - needed + 1, b'x');
        assert_eq!(tty.write(true, &[21]), Err(6));
        assert_eq!(tty.line.borrow().len(), LINE_BYTES);
        assert_eq!(tty.output.bytes.borrow().len(), PIPE_BYTES - needed + 1);
        tty.output.bytes.borrow_mut().pop_back();
        assert_eq!(tty.write(true, &[21]), Ok(1));
        assert!(tty.line.borrow().is_empty());
        assert_eq!(tty.output.bytes.borrow().len(), PIPE_BYTES);
        assert_eq!(tty.write(true, b"a"), Err(6));
        assert!(tty.line.borrow().is_empty());
    }

    #[test]
    fn raw_owner_restores_all_attributes_and_direct_changes_supersede_it() {
        let tty = Terminal::new();
        let original = Termios {
            echo: false,
            onlcr: false,
            cc: *b"!?~@#%&",
            ..Termios::default()
        };
        tty.set_attributes(original).unwrap();
        let first = tty.set_raw(Some(1), true).unwrap().unwrap();
        let second = tty.set_raw(Some(2), true).unwrap().unwrap();
        assert_eq!(tty.termios.get(), original.with_raw(true));
        assert!(tty.release_raw(1, Some(first)));
        assert!(tty.release_raw(2, Some(second)));
        assert_eq!(tty.termios.get(), original);
        let token = tty.set_raw(Some(1), true).unwrap().unwrap();
        let changed = Termios {
            isig: false,
            ..original
        };
        tty.set_attributes(changed).unwrap();
        assert!(tty.release_raw(1, Some(token)));
        assert_eq!(tty.termios.get(), changed);
    }

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
    fn raw_owners_unwind_nested_and_out_of_order_exits() {
        let tty = Terminal::new();
        let first = tty.set_raw(Some(1), true).unwrap().unwrap();
        assert_eq!(tty.set_raw(Some(1), true), Ok(Some(first)));
        let second = tty.set_raw(Some(2), true).unwrap().unwrap();
        assert!(tty.release_raw(1, Some(first)));
        assert!(!tty.termios.get().icanon);
        assert!(tty.release_raw(2, Some(second)));
        assert!(tty.termios.get().icanon);
        assert!(!tty.release_raw(1, Some(first)));

        let first = tty.set_raw(Some(1), true).unwrap().unwrap();
        tty.set_raw(Some(2), true).unwrap();
        tty.set_raw(Some(2), false).unwrap();
        assert!(!tty.termios.get().icanon);
        assert!(tty.release_raw(1, Some(first)));
        assert!(tty.termios.get().icanon);
    }

    #[test]
    fn raw_reacquisition_invalidates_old_tokens_and_preserves_restore_point() {
        let tty = Terminal::new();
        let old = tty.set_raw(Some(1), true).unwrap().unwrap();
        let second = tty.set_raw(Some(2), true).unwrap().unwrap();
        let new = tty.set_raw(Some(1), true).unwrap().unwrap();
        assert_ne!(old, new);
        assert!(!tty.release_raw(1, Some(old)));
        assert!(tty.release_raw(2, Some(second)));
        assert!(!tty.termios.get().icanon);
        assert!(tty.release_raw(1, Some(new)));
        assert!(tty.termios.get().icanon);
    }

    #[test]
    fn raw_cleanup_does_not_override_a_later_unowned_change() {
        let tty = Terminal::new();
        let token = tty.set_raw(Some(1), true).unwrap().unwrap();
        tty.set_raw(None, false).unwrap();
        tty.set_raw(None, true).unwrap();
        assert!(tty.release_raw(1, Some(token)));
        assert!(!tty.termios.get().icanon);
        assert!(tty.raw_leases.borrow().is_empty());
    }

    #[test]
    fn raw_counter_exhaustion_is_atomic_and_cleanup_still_unwinds() {
        let tty = Terminal::new();
        tty.raw_token.set(u64::MAX);
        assert_eq!(tty.set_raw(Some(1), true), Err(29));
        assert!(tty.termios.get().icanon);
        assert_eq!(tty.attributes_generation.get(), 0);
        tty.raw_token.set(0);
        tty.attributes_generation.set(u64::MAX - 2);
        let first = tty.set_raw(Some(1), true).unwrap().unwrap();
        let second = tty.set_raw(Some(2), true).unwrap().unwrap();
        assert_eq!(tty.set_raw(None, false), Err(29));
        assert!(tty.release_raw(2, Some(second)));
        assert!(!tty.termios.get().icanon);
        assert!(tty.release_raw(1, Some(first)));
        assert!(tty.termios.get().icanon);
    }

    #[test]
    fn raw_mode_preserves_bytes_and_flushes_uncommitted_input() {
        let tty = Terminal::new();
        tty.write(true, b"partial").unwrap();
        assert!(!tty.ready());
        tty.set_raw(Some(1), true).unwrap();
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
        tty.set_raw(Some(1), false).unwrap();
        assert_eq!(tty.available(), 13);
    }

    #[test]
    fn buffers_and_line_records_are_bounded_without_dropping_input() {
        let tty = Terminal::new();
        tty.set_raw(Some(1), true).unwrap();
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

    #[test]
    fn cooked_control_keys_target_foreground_without_echo_or_input_bytes() {
        let tty = Terminal::new();
        tty.foreground.set(1);
        assert_eq!(tty.write(true, b"discard\x03\x1c\x1akept\n"), Ok(15));
        assert_eq!(tty.signals.get(), (1 << 1) | (1 << 2) | (1 << 19));
        assert_eq!(tty.available(), 5);
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"kept\n"
        );
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"discardkept\r\n"
        );
        tty.set_raw(Some(1), true).unwrap();
        tty.signals.set(0);
        assert_eq!(tty.write(true, b"\x03\x1c\x1a"), Ok(3));
        assert_eq!(tty.signals.get(), 0);
        assert!(
            tty.input
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>()
                .ends_with(b"\x03\x1c\x1a")
        );
    }

    #[test]
    fn unowned_signal_keys_wake_the_reader_with_a_bounded_empty_line() {
        let tty = Terminal::new();
        assert_eq!(tty.write(true, b"discard\x03\x1c\x1a"), Ok(10));
        assert_eq!(tty.signals.get(), 0);
        assert_eq!(
            tty.input.bytes.borrow().iter().copied().collect::<Vec<_>>(),
            b"\n\n\n"
        );
        assert_eq!(
            tty.output
                .bytes
                .borrow()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"discard^C\r\n^\\\r\n^Z\r\n"
        );
        tty.input.bytes.borrow_mut().resize(PIPE_BYTES, b'x');
        assert_eq!(tty.write(true, b"\x03"), Err(6));
        assert_eq!(tty.input.bytes.borrow().len(), PIPE_BYTES);
    }
}
