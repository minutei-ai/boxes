use rquickjs::function::This;
use rquickjs::{Context, Ctx, Exception, Function, Module, Persistent, Runtime};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

mod modules;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostError {
    error: String,
    message: String,
}

enum RequestKind {
    Action(String),
    Module { base: String, specifier: String },
}

struct Request {
    kind: RequestKind,
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Step<'a> {
    Request {
        action: &'a str,
    },
    Module {
        base: &'a str,
        specifier: &'a str,
        known: Vec<&'a str>,
    },
    Done {
        output: &'a str,
    },
}

#[wasm_bindgen]
pub struct Guest {
    pending: Rc<RefCell<VecDeque<Request>>>,
    active: Option<Request>,
    output: Rc<RefCell<Option<String>>>,
    capture: Persistent<Function<'static>>,
    registry: Rc<RefCell<modules::Registry>>,
    context: Context,
    runtime: Runtime,
    fuel: Rc<Cell<usize>>,
    jobs: usize,
    max_output: usize,
}

fn failure(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        return format!("Guest exception: {:?}", ctx.catch());
    }
    error.to_string()
}

impl Guest {
    fn create(
        program: &str,
        memory: usize,
        ticks: usize,
        max_output: usize,
    ) -> Result<Self, String> {
        if program.len() > 18_000_000
            || !(4_194_304..=33_554_432).contains(&memory)
            || ticks == 0
            || ticks > 100_000
        {
            return Err("Invalid execution limits".into());
        }
        let program: modules::Program =
            serde_json::from_str(program).map_err(|error| error.to_string())?;
        let registry = Rc::new(RefCell::new(modules::Registry::new(program)?));
        let runtime = Runtime::new().map_err(|error| error.to_string())?;
        runtime.set_memory_limit(memory);
        runtime.set_max_stack_size(512 * 1024);
        runtime.set_loader(
            modules::Modules(Rc::clone(&registry)),
            modules::Modules(Rc::clone(&registry)),
        );
        let fuel = Rc::new(Cell::new(ticks));
        let counter = Rc::clone(&fuel);
        runtime.set_interrupt_handler(Some(Box::new(move || match counter.get().checked_sub(1) {
            Some(left) => {
                counter.set(left);
                false
            }
            None => true,
        })));
        let context = Context::full(&runtime).map_err(|error| error.to_string())?;
        let pending = Rc::new(RefCell::new(VecDeque::new()));
        let output = Rc::new(RefCell::new(None));
        let queue = Rc::downgrade(&pending);
        let completed = Rc::downgrade(&output);
        let requests = Rc::new(Cell::new(0usize));
        let module_requests = Rc::clone(&requests);
        let module_queue = Rc::downgrade(&pending);
        let module_registry = Rc::downgrade(&registry);
        let capture = context.with(|ctx| {
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
                    kind: RequestKind::Action(action),
                    resolve: Persistent::save(&ctx, resolve),
                    reject: Persistent::save(&ctx, reject),
                });
                Ok(Persistent::save(&ctx, promise))
            })
            .map_err(|error| failure(&ctx, error))?;
            let module_call = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>, base: String, specifier: String| {
                    if base.len() > 4096 || specifier.len() > 4096 || module_requests.get() >= 256 {
                        return Err(Exception::throw_message(
                            &ctx,
                            "Module request budget exceeded",
                        ));
                    }
                    module_requests.set(module_requests.get() + 1);
                    let registry = module_registry
                        .upgrade()
                        .ok_or_else(|| Exception::throw_message(&ctx, "Guest disposed"))?;
                    let cached = registry.borrow().cached(&base, &specifier);
                    if let Some(target) = cached {
                        return Module::import(&ctx, target)
                            .map(|promise| Persistent::save(&ctx, promise));
                    }
                    let queue = module_queue
                        .upgrade()
                        .ok_or_else(|| Exception::throw_message(&ctx, "Guest disposed"))?;
                    let (promise, resolve, reject) = ctx.promise()?;
                    queue.borrow_mut().push_back(Request {
                        kind: RequestKind::Module { base, specifier },
                        resolve: Persistent::save(&ctx, resolve),
                        reject: Persistent::save(&ctx, reject),
                    });
                    Ok(Persistent::save(&ctx, promise))
                },
            )
            .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .set("__moduleRequest", module_call)
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
            ctx.globals()
                .set("__mode", registry.borrow().mode().name())
                .map_err(|error| failure(&ctx, error))?;
            Module::evaluate(
                ctx.clone(),
                "entry",
                include_str!(concat!(env!("OUT_DIR"), "/bootstrap.js")),
            )
            .map_err(|error| failure(&ctx, error))?;
            let capture = ctx
                .globals()
                .get::<_, Function>("__capture")
                .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .remove("__capture")
                .map_err(|error| failure(&ctx, error))?;
            Ok::<_, String>(Persistent::save(&ctx, capture))
        })?;
        Ok(Self {
            pending,
            active: None,
            output,
            capture,
            registry,
            context,
            runtime,
            fuel,
            jobs: 0,
            max_output,
        })
    }

    fn advance(&mut self) -> Result<String, String> {
        if self.active.is_some() {
            return Err("Respond to the pending capability before advancing".into());
        }
        loop {
            if self.fuel.get() == 0 {
                return Err("Execution interrupt budget exhausted".into());
            }
            if let Some(value) = self.output.borrow().as_ref() {
                return serde_json::to_string(&Step::Done { output: value })
                    .map_err(|error| error.to_string());
            }
            let request = self.pending.borrow_mut().pop_front();
            if let Some(request) = request {
                if let RequestKind::Module { base, specifier } = &request.kind {
                    let target = self.registry.borrow().cached(base, specifier);
                    if let Some(target) = target {
                        self.context
                            .with(|ctx| finish_import(&ctx, request, target))?;
                        continue;
                    }
                }
                let registry = self.registry.borrow();
                let event = match &request.kind {
                    RequestKind::Action(action) => Step::Request { action },
                    RequestKind::Module { base, specifier } => Step::Module {
                        base,
                        specifier,
                        known: registry.names(),
                    },
                };
                let value = serde_json::to_string(&event).map_err(|error| error.to_string())?;
                drop(registry);
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
            if rejected && matches!(request.kind, RequestKind::Module { .. }) {
                return reject_import(&ctx, request, value);
            }
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
    fn settle_module(&mut self, value: &str) -> Result<(), String> {
        if value.len() > 8_388_608 {
            return Err("Module response byte budget exceeded".into());
        }
        let batch: modules::Batch =
            serde_json::from_str(value).map_err(|error| error.to_string())?;
        let request = self.active.take().ok_or("No pending module request")?;
        let target = match &request.kind {
            RequestKind::Module { base, specifier } => {
                self.registry.borrow_mut().install(base, specifier, batch)
            }
            RequestKind::Action(_) => Err("Pending request is not a module import".into()),
        };
        self.context.with(|ctx| match target {
            Ok(target) => finish_import(&ctx, request, target),
            Err(message) => {
                let value = serde_json::json!({"error":"EFBIG","message":message}).to_string();
                reject_import(&ctx, request, &value)
            }
        })
    }
}

fn reject_import(ctx: &Ctx<'_>, request: Request, value: &str) -> Result<(), String> {
    let data: HostError = serde_json::from_str(value).map_err(|error| error.to_string())?;
    let error =
        Exception::from_message(ctx.clone(), &data.message).map_err(|error| failure(ctx, error))?;
    error
        .as_object()
        .set("code", data.error)
        .map_err(|error| failure(ctx, error))?;
    request
        .reject
        .restore(ctx)
        .and_then(|callback| callback.call::<_, ()>((error,)))
        .map_err(|error| failure(ctx, error))
}

fn finish_import(ctx: &Ctx<'_>, request: Request, target: String) -> Result<(), String> {
    let resolve = request
        .resolve
        .restore(ctx)
        .map_err(|error| failure(ctx, error))?;
    let reject = request
        .reject
        .restore(ctx)
        .map_err(|error| failure(ctx, error))?;
    let promise = Module::import(ctx, target).map_err(|error| failure(ctx, error))?;
    promise
        .then()
        .and_then(|then| then.call::<_, ()>((This(promise.clone()), resolve, reject)))
        .map_err(|error| failure(ctx, error))
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

    pub fn respond_module(&mut self, value: &str) -> Result<(), JsValue> {
        self.settle_module(value)
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn stdio(&self) -> Result<String, JsValue> {
        let value = self.context.with(|ctx| {
            self.capture
                .clone()
                .restore(&ctx)
                .and_then(|capture| capture.call::<_, String>(()))
                .map_err(|error| JsValue::from_str(&failure(&ctx, error)))
        })?;
        if value.len() > self.max_output {
            return Err(JsValue::from_str(
                "Serialized standard output budget exceeded",
            ));
        }
        Ok(value)
    }

    pub fn program(&self) -> Result<String, JsValue> {
        self.registry
            .borrow()
            .program()
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn revision(&self) -> usize {
        self.registry.borrow().revision
    }

    pub fn respond(&mut self, value: &str, rejected: bool) -> Result<(), JsValue> {
        self.settle(value, rejected)
            .map_err(|error| JsValue::from_str(&error))
    }
    pub fn respond_undefined(&mut self) -> Result<(), JsValue> {
        let request = self
            .active
            .take()
            .ok_or_else(|| JsValue::from_str("No pending capability request"))?;
        if !matches!(request.kind, RequestKind::Action(_)) {
            return Err(JsValue::from_str(
                "Undefined response requires a capability request",
            ));
        }
        self.context.with(|ctx| {
            request
                .resolve
                .restore(&ctx)
                .and_then(|callback| callback.call::<_, ()>((rquickjs::Undefined,)))
                .map_err(|error| JsValue::from_str(&failure(&ctx, error)))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(source: &str) -> String {
        serde_json::json!({"language":"javascript","entry":"/main.js","mode":"function","modules":[{"name":"/main.js","source":source,"imports":[]}]}).to_string()
    }

    #[test]
    fn computes_and_captures_output() {
        let mut guest = Guest::create(
            &fixture("export default ({console}) => {console.log('ok'); return 42;}"),
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        assert!(guest.advance().unwrap().contains("42"));
    }

    #[test]
    fn bridges_promises_without_host_globals() {
        let mut guest = Guest::create(&fixture("export default async ({tools}) => { const value = await tools.call({op:'filesystem.exists',path:'/'}); return [value.exists,typeof process,typeof fetch]; }"), 8_388_608, 1000, 4096).unwrap();
        assert!(guest.advance().unwrap().contains("filesystem.exists"));
        guest.settle("{\"exists\":true}", false).unwrap();
        assert!(guest.advance().unwrap().contains("undefined"));
    }
    #[test]
    fn undefined_host_values_remain_undefined_inside_the_guest() {
        let mut guest = Guest::create(&fixture("export default async ({tools}) => (await tools.call({op:'host.call',name:'empty'})) === undefined;"), 8_388_608, 1000, 4096).unwrap();
        assert!(guest.advance().unwrap().contains("host.call"));
        guest.respond_undefined().unwrap();
        assert!(guest.advance().unwrap().contains("\\\"result\\\":true"));
    }

    #[test]
    fn interrupts_unbounded_computation() {
        let mut guest = Guest::create(
            &fixture("export default () => {while(true){}}"),
            8_388_608,
            2,
            4096,
        )
        .unwrap();
        assert!(guest.advance().is_err());
    }

    #[test]
    fn denies_platform_imports() {
        let mut guest = Guest::create(
            &fixture("import {env} from 'cloudflare:workers'; export default () => env"),
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        assert!(guest.advance().unwrap().contains("cloudflare:workers"));
    }
}
