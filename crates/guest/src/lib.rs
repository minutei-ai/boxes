use rquickjs::loader::{BuiltinLoader, BuiltinResolver};
use rquickjs::{Context, Ctx, Exception, Function, Module, Persistent, Runtime};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use wasm_bindgen::prelude::*;

mod binary;

struct Request {
    action: String,
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Step<'a> {
    Request { action: &'a str },
    Done { output: &'a str },
}

#[wasm_bindgen]
pub struct Guest {
    pending: Rc<RefCell<VecDeque<Request>>>,
    active: Option<Request>,
    output: Rc<RefCell<Option<String>>>,
    context: Context,
    runtime: Runtime,
    fuel: Arc<AtomicUsize>,
    jobs: usize,
}

fn failure(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        return format!("Guest exception: {:?}", ctx.catch());
    }
    error.to_string()
}

impl Guest {
    fn create(
        source: &str,
        memory: usize,
        ticks: usize,
        max_output: usize,
    ) -> Result<Self, String> {
        if source.len() > 1_048_576
            || !(4_194_304..=33_554_432).contains(&memory)
            || ticks == 0
            || ticks > 100_000
        {
            return Err("Invalid execution limits".into());
        }
        let runtime = Runtime::new().map_err(|error| error.to_string())?;
        runtime.set_memory_limit(memory);
        runtime.set_max_stack_size(512 * 1024);
        runtime.set_loader(
            BuiltinResolver::default().with_module("program"),
            BuiltinLoader::default().with_module("program", source),
        );
        let fuel = Arc::new(AtomicUsize::new(ticks));
        let counter = Arc::clone(&fuel);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            counter
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                    left.checked_sub(1)
                })
                .is_err()
        })));
        let context = Context::full(&runtime).map_err(|error| error.to_string())?;
        let pending = Rc::new(RefCell::new(VecDeque::new()));
        let output = Rc::new(RefCell::new(None));
        let queue = Rc::downgrade(&pending);
        let completed = Rc::downgrade(&output);
        let requests = Rc::new(Cell::new(0usize));
        context.with(|ctx| {
            let call = Function::new(ctx.clone(), move |ctx: Ctx<'_>, action: String| {
                if action.len() > 1_048_576 || requests.get() >= 256 {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Capability request budget exceeded",
                    ));
                }
                let queue = queue
                    .upgrade()
                    .ok_or_else(|| Exception::throw_message(&ctx, "Guest disposed"))?;
                requests.set(requests.get() + 1);
                let (promise, resolve, reject) = ctx.promise()?;
                queue.borrow_mut().push_back(Request {
                    action,
                    resolve: Persistent::save(&ctx, resolve),
                    reject: Persistent::save(&ctx, reject),
                });
                Ok(Persistent::save(&ctx, promise))
            })
            .map_err(|error| failure(&ctx, error))?;
            let finish = Function::new(ctx.clone(), move |ctx: Ctx<'_>, value: String| {
                if value.len() > max_output {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Serialized result budget exceeded",
                    ));
                }
                let output = completed
                    .upgrade()
                    .ok_or_else(|| Exception::throw_message(&ctx, "Guest disposed"))?;
                *output.borrow_mut() = Some(value);
                Ok(())
            })
            .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .set("__call", call)
                .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .set("__finish", finish)
                .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .set("__maxOutput", max_output)
                .map_err(|error| failure(&ctx, error))?;
            Module::evaluate(ctx.clone(), "entry", include_str!("bootstrap.js"))
                .map_err(|error| failure(&ctx, error))?;
            Ok::<_, String>(())
        })?;
        Ok(Self {
            pending,
            active: None,
            output,
            context,
            runtime,
            fuel,
            jobs: 0,
        })
    }

    fn advance(&mut self) -> Result<String, String> {
        if self.active.is_some() {
            return Err("Respond to the pending capability before advancing".into());
        }
        loop {
            if self.fuel.load(Ordering::Relaxed) == 0 {
                return Err("Execution interrupt budget exhausted".into());
            }
            if let Some(value) = self.output.borrow().as_ref() {
                return serde_json::to_string(&Step::Done { output: value })
                    .map_err(|error| error.to_string());
            }
            if let Some(request) = self.pending.borrow_mut().pop_front() {
                let value = serde_json::to_string(&Step::Request {
                    action: &request.action,
                })
                .map_err(|error| error.to_string())?;
                self.active = Some(request);
                return Ok(value);
            }
            self.jobs += 1;
            if self.jobs > 10_000 {
                return Err("Microtask budget exhausted".into());
            }
            match self.runtime.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => {
                    return Err("Guest stalled without an outstanding capability request".into());
                }
                Err(error) => {
                    return Err(error
                        .0
                        .with(|ctx| failure(&ctx, rquickjs::Error::Exception)));
                }
            }
        }
    }

    fn settle(&mut self, value: &str, rejected: bool) -> Result<(), String> {
        if value.len() > 24_000_000 {
            return Err("Host response budget exceeded".into());
        }
        let request = self.active.take().ok_or("No pending capability request")?;
        self.context.with(|ctx| {
            let function = if rejected {
                request.reject
            } else {
                request.resolve
            };
            function
                .restore(&ctx)
                .and_then(|callback| callback.call::<_, ()>((value,)))
                .map_err(|error| failure(&ctx, error))
        })
    }
}

#[wasm_bindgen]
impl Guest {
    #[wasm_bindgen(constructor)]
    pub fn new(
        source: &str,
        memory: usize,
        ticks: usize,
        max_output: usize,
    ) -> Result<Self, JsValue> {
        Self::create(source, memory, ticks, max_output).map_err(|error| JsValue::from_str(&error))
    }

    pub fn step(&mut self) -> Result<String, JsValue> {
        self.advance().map_err(|error| JsValue::from_str(&error))
    }

    pub fn respond(&mut self, value: &str, rejected: bool) -> Result<(), JsValue> {
        self.settle(value, rejected)
            .map_err(|error| JsValue::from_str(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_and_captures_output() {
        let mut guest = Guest::create(
            "export default ({console}) => {console.log('ok'); return 42;}",
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        assert!(guest.advance().unwrap().contains("42"));
    }

    #[test]
    fn bridges_promises_without_host_globals() {
        let mut guest = Guest::create("export default async ({tools}) => { const value = await tools.call({op:'filesystem.exists',path:'/'}); return [value.exists,typeof process,typeof fetch]; }", 8_388_608, 1000, 4096).unwrap();
        assert!(guest.advance().unwrap().contains("filesystem.exists"));
        guest.settle("{\"exists\":true}", false).unwrap();
        assert!(guest.advance().unwrap().contains("undefined"));
    }

    #[test]
    fn interrupts_unbounded_computation() {
        let mut guest =
            Guest::create("export default () => {while(true){}}", 8_388_608, 2, 4096).unwrap();
        assert!(guest.advance().is_err());
    }

    #[test]
    fn denies_platform_imports() {
        assert!(
            Guest::create(
                "import {env} from 'cloudflare:workers'; export default () => env",
                8_388_608,
                1000,
                4096
            )
            .is_err()
        );
    }
}
