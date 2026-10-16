use rquickjs::function::This;
use rquickjs::{Context, Ctx, Exception, Function, Module, Persistent, Runtime};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
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
    start: Persistent<Function<'static>>,
    registry: Rc<RefCell<modules::Registry>>,
    context: Context,
    runtime: Runtime,
    fuel: Rc<Cell<usize>>,
    requests: Rc<Cell<usize>>,
    jobs: usize,
    max_output: usize,
}

thread_local! {
    static PARKED_CONTEXTS: RefCell<BTreeMap<u32, Guest>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT_CONTEXT: Cell<u32> = const { Cell::new(1) };
    static CREATED_GUESTS: Cell<u32> = const { Cell::new(0) };
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
        CREATED_GUESTS.with(|created| created.set(created.get().saturating_add(1)));
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
        let action_requests = Rc::clone(&requests);
        let module_requests = Rc::clone(&requests);
        let module_queue = Rc::downgrade(&pending);
        let module_registry = Rc::downgrade(&registry);
        let (capture, start) = context.with(|ctx| {
            let call = Function::new(ctx.clone(), move |ctx: Ctx<'_>, action: String| {
                if action.len() > 1_048_576 || action_requests.get() >= 256 {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Capability request budget exceeded",
                    ));
                }
                let queue = queue
                    .upgrade()
                    .ok_or_else(|| Exception::throw_message(&ctx, "Guest disposed"))?;
                action_requests.set(action_requests.get() + 1);
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
            let environment = serde_json::to_string(registry.borrow().environment())
                .map_err(|error| error.to_string())?;
            let environment = ctx
                .json_parse(environment)
                .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .set("__environment", environment)
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
            let start = ctx
                .globals()
                .get::<_, Function>("__start")
                .map_err(|error| failure(&ctx, error))?;
            ctx.globals()
                .remove("__start")
                .map_err(|error| failure(&ctx, error))?;
            Ok::<_, String>((
                Persistent::save(&ctx, capture),
                Persistent::save(&ctx, start),
            ))
        })?;
        Ok(Self {
            pending,
            active: None,
            output,
            capture,
            start,
            registry,
            context,
            runtime,
            fuel,
            requests,
            jobs: 0,
            max_output,
        })
    }

    fn begin_program(&mut self, program: &str, ticks: usize) -> Result<(), String> {
        if program.len() > 18_000_000 || ticks == 0 || ticks > 100_000 {
            return Err("Invalid execution limits".into());
        }
        if self.output.borrow().is_none()
            || self.active.is_some()
            || !self.pending.borrow().is_empty()
            || self.runtime.is_job_pending()
        {
            return Err("Previous execution is not quiescent".into());
        }
        let program = serde_json::from_str(program).map_err(|error| error.to_string())?;
        self.registry.borrow_mut().begin(program)?;
        let registry = self.registry.borrow();
        let mode = registry.mode().name();
        let environment =
            serde_json::to_string(registry.environment()).map_err(|error| error.to_string())?;
        self.fuel.set(ticks);
        self.jobs = 0;
        self.requests.set(0);
        self.output.borrow_mut().take();
        self.context.with(|ctx| {
            let environment = ctx
                .json_parse(environment)
                .map_err(|error| failure(&ctx, error))?;
            self.start
                .clone()
                .restore(&ctx)
                .and_then(|start| start.call::<_, ()>(("program", mode, environment)))
                .map_err(|error| failure(&ctx, error))
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
    pub fn park(self) -> Result<u32, JsValue> {
        if !CREATED_GUESTS.with(|created| created.get() == 1) {
            return Err(JsValue::from_str(
                "Context snapshot requires a fresh isolated runtime",
            ));
        }
        PARKED_CONTEXTS.with(|contexts| {
            let mut contexts = contexts.borrow_mut();
            if !contexts.is_empty() {
                return Err(JsValue::from_str("An isolated context is already parked"));
            }
            let handle = NEXT_CONTEXT
                .with(|next| {
                    let handle = next.get();
                    let following = handle.checked_add(1).ok_or("Context handle exhausted")?;
                    next.set(following);
                    Ok::<_, &str>(handle)
                })
                .map_err(JsValue::from_str)?;
            contexts.insert(handle, self);
            Ok(handle)
        })
    }

    pub fn resume(handle: u32) -> Result<Guest, JsValue> {
        PARKED_CONTEXTS.with(|contexts| {
            contexts
                .borrow_mut()
                .remove(&handle)
                .ok_or_else(|| JsValue::from_str("Context handle does not exist"))
        })
    }

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

    pub fn begin(&mut self, program: &str, ticks: usize) -> Result<(), JsValue> {
        self.begin_program(program, ticks)
            .map_err(|error| JsValue::from_str(&error))
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
        serde_json::json!({"env":{},"language":"javascript","entry":"/main.js","mode":"function","modules":[{"name":"/main.js","source":source,"imports":[]}]}).to_string()
    }

    fn retained_program(entry: &str, source: &str, round: &str) -> String {
        serde_json::json!({"env":{"ROUND":round,"__proto__":"literal"},"language":"javascript","entry":entry,"mode":"function","modules":[{"name":entry,"source":source,"imports":[]}]}).to_string()
    }

    fn completed(guest: &mut Guest) -> serde_json::Value {
        let step: serde_json::Value = serde_json::from_str(&guest.advance().unwrap()).unwrap();
        assert_eq!(step["kind"], "done");
        serde_json::from_str(step["output"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn reentry_preserves_closures_but_renews_output_and_environment() {
        let first = retained_program(
            "/one.js",
            "export default ({console}) => { let value = 40; globalThis.bump = () => { console.log(process.env.ROUND); return ++value; }; console.log('first'); return process.env.__proto__; }",
            "one",
        );
        let mut guest = Guest::create(&first, 8_388_608, 1000, 4096).unwrap();
        let output = completed(&mut guest);
        assert_eq!(output["stdout"], "first\n");
        assert_eq!(output["result"], "literal");
        let second = retained_program("/two.js", "export default () => globalThis.bump()", "two");
        guest.begin_program(&second, 1000).unwrap();
        let output = completed(&mut guest);
        assert_eq!(output["stdout"], "two\n");
        assert_eq!(output["result"], 41);
        assert_eq!(output["exitCode"], 0);
        guest.begin_program(&second, 1000).unwrap();
        let repeated = completed(&mut guest);
        assert_eq!(repeated["stdout"], "two\n");
        assert_eq!(repeated["result"], 42);
        let third = retained_program(
            "/three.js",
            "export default () => globalThis.bump()",
            "three",
        );
        guest.begin_program(&third, 1000).unwrap();
        let output = completed(&mut guest);
        assert_eq!(output["stdout"], "three\n");
        assert_eq!(output["result"], 43);
    }

    #[test]
    fn repeated_entry_keeps_its_logical_filename_and_url() {
        let path = "/tmp/café #one.mjs";
        let program = retained_program(
            path,
            "export default () => { globalThis.calls = (globalThis.calls || 0) + 1; return {calls:globalThis.calls,filename:import.meta.filename,url:import.meta.url}; }",
            "one",
        );
        let mut guest = Guest::create(&program, 8_388_608, 1000, 4096).unwrap();
        for expected in 1..=3 {
            if expected > 1 {
                guest.begin_program(&program, 1000).unwrap();
            }
            let output = completed(&mut guest);
            assert_eq!(output["result"]["calls"], expected);
            assert_eq!(output["result"]["filename"], path);
            assert_eq!(
                output["result"]["url"],
                "file:///tmp/caf%C3%A9%20%23one.mjs"
            );
        }
        let captured: serde_json::Value =
            serde_json::from_str(&guest.registry.borrow().program().unwrap()).unwrap();
        assert_ne!(captured["entry"], path);
        assert_eq!(captured["modules"][2]["filePath"], path);
        assert_eq!(captured["modules"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn repeated_entry_uses_new_source_and_preserves_old_dynamic_import_closures() {
        let path = "/tmp/main.mjs";
        let first = retained_program(
            path,
            "export default async () => { globalThis.oldImport = () => import.meta.__cirroImport('/tmp/main.mjs','./dep.js'); return (await globalThis.oldImport()).value; }",
            "one",
        );
        let mut guest = Guest::create(&first, 8_388_608, 1000, 4096).unwrap();
        let request: serde_json::Value = serde_json::from_str(&guest.advance().unwrap()).unwrap();
        assert_eq!(request["kind"], "module");
        assert_eq!(request["base"], path);
        guest.settle_module(&serde_json::json!({"entry":"/tmp/dep-one.js","modules":[{"name":"/tmp/dep-one.js","source":"export const value=1;","imports":[]}]}).to_string()).unwrap();
        assert_eq!(completed(&mut guest)["result"], 1);
        let second = retained_program(
            path,
            "export default async () => (await import.meta.__cirroImport('/tmp/main.mjs','./dep.js')).value;",
            "two",
        );
        guest.begin_program(&second, 1000).unwrap();
        let request: serde_json::Value = serde_json::from_str(&guest.advance().unwrap()).unwrap();
        assert_eq!(request["kind"], "module");
        assert_ne!(request["base"], path);
        assert_eq!(
            request["base"]
                .as_str()
                .unwrap()
                .rsplit_once('/')
                .unwrap()
                .0,
            "/tmp"
        );
        guest.settle_module(&serde_json::json!({"entry":"/tmp/dep-two.js","modules":[{"name":"/tmp/dep-two.js","source":"export const value=2;","imports":[]}]}).to_string()).unwrap();
        assert_eq!(completed(&mut guest)["result"], 2);
        let third = retained_program(
            path,
            "export default async () => (await globalThis.oldImport()).value;",
            "three",
        );
        guest.begin_program(&third, 1000).unwrap();
        assert_eq!(completed(&mut guest)["result"], 1);
    }

    #[test]
    fn repeated_entry_keeps_static_and_dynamic_canonical_imports_on_the_same_cached_module() {
        let first = retained_program(
            "/self.mjs",
            "export const value=1; export default () => value;",
            "one",
        );
        let mut guest = Guest::create(&first, 8_388_608, 1000, 4096).unwrap();
        assert_eq!(completed(&mut guest)["result"], 1);
        let second = serde_json::json!({"env":{},"language":"javascript","entry":"/self.mjs","mode":"function","modules":[{"name":"/self.mjs","source":"import {value as before} from './self.mjs'; export const value=2; export default async () => ({static:before,dynamic:(await import.meta.__cirroImport('/self.mjs','./self.mjs')).value,local:value});","imports":[{"specifier":"./self.mjs","target":"/self.mjs"}]}]}).to_string();
        guest.begin_program(&second, 1000).unwrap();
        assert_eq!(
            completed(&mut guest)["result"],
            serde_json::json!({"static":1,"dynamic":1,"local":2})
        );
    }

    #[test]
    fn repeated_maximum_filename_does_not_truncate_its_identity_or_metadata() {
        let path = format!("/{}", "a".repeat(4095));
        let program = retained_program(
            &path,
            "export default () => import.meta.filename.length;",
            "one",
        );
        let mut guest = Guest::create(&program, 8_388_608, 1000, 4096).unwrap();
        assert_eq!(completed(&mut guest)["result"], 4096);
        guest.begin_program(&program, 1000).unwrap();
        assert_eq!(completed(&mut guest)["result"], 4096);
        assert!(
            guest
                .registry
                .borrow()
                .program()
                .unwrap()
                .contains("#boxes-entry-")
        );
    }

    #[test]
    fn reentry_refuses_an_outstanding_callback_without_losing_it() {
        let first = retained_program(
            "/one.js",
            "export default async ({tools}) => await tools.call({op:'host.call',name:'echo',input:2})",
            "one",
        );
        let mut guest = Guest::create(&first, 8_388_608, 1000, 4096).unwrap();
        assert!(guest.advance().unwrap().contains("host.call"));
        let second = retained_program("/two.js", "export default () => 3", "two");
        assert!(guest.begin_program(&second, 1000).is_err());
        guest.settle("2", false).unwrap();
        assert_eq!(completed(&mut guest)["result"], 2);
        guest.begin_program(&second, 1000).unwrap();
        assert_eq!(completed(&mut guest)["result"], 3);
    }

    #[test]
    fn reentry_renews_the_request_budget_and_enforces_the_new_fuel_budget() {
        let source = "export default async ({tools}) => { for(let i=0;i<200;i++) await tools.call({op:'host.call',name:'echo'}); return 200; }";
        let mut guest = Guest::create(
            &retained_program("/one.js", source, "one"),
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        for entry in ["/one.js", "/two.js"] {
            if entry != "/one.js" {
                guest
                    .begin_program(&retained_program(entry, source, "two"), 1000)
                    .unwrap();
            }
            for _ in 0..200 {
                assert!(guest.advance().unwrap().contains("host.call"));
                guest.settle("null", false).unwrap();
            }
            assert_eq!(completed(&mut guest)["result"], 200);
        }
        guest
            .begin_program(
                &retained_program("/loop.js", "export default () => {while(true){}}", "loop"),
                2,
            )
            .unwrap();
        assert!(guest.advance().is_err());
    }

    #[test]
    fn reentry_keeps_cached_module_state_and_rejects_replacement_atomically() {
        let bundle = |entry: &str, dependency: &str| {
            serde_json::json!({
            "env":{},"language":"javascript","entry":entry,"mode":"function",
            "modules":[
                {"name":entry,"source":"import {increment} from './counter.js'; export default () => increment();","imports":[{"specifier":"./counter.js","target":"/counter.js"}]},
                {"name":"/counter.js","source":dependency,"imports":[]}
            ]
        }).to_string()
        };
        let dependency = "let counter = 0; export const increment = () => ++counter;";
        let mut guest =
            Guest::create(&bundle("/one.js", dependency), 8_388_608, 1000, 4096).unwrap();
        assert_eq!(completed(&mut guest)["result"], 1);
        guest
            .begin_program(&bundle("/one.js", dependency), 1000)
            .unwrap();
        assert_eq!(completed(&mut guest)["result"], 2);
        assert!(
            guest
                .begin_program(
                    &bundle("/one.js", "export const increment = () => 100;"),
                    1000
                )
                .is_err()
        );
        assert_eq!(completed(&mut guest)["result"], 2);
        guest
            .begin_program(&bundle("/one.js", dependency), 1000)
            .unwrap();
        assert_eq!(completed(&mut guest)["result"], 3);
    }

    #[test]
    fn reentry_has_an_independent_output_budget() {
        let source = "export default ({console}) => {console.log('x'.repeat(3000)); return 1;}";
        let mut guest = Guest::create(
            &retained_program("/one.js", source, "one"),
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        assert_eq!(
            completed(&mut guest)["stdout"].as_str().unwrap().len(),
            3001
        );
        guest
            .begin_program(&retained_program("/two.js", source, "two"), 1000)
            .unwrap();
        let output = completed(&mut guest);
        assert_eq!(output["stdout"].as_str().unwrap().len(), 3001);
        assert_eq!(output["exitCode"], 0);
    }

    #[test]
    fn reentry_refuses_microtasks_left_after_completion() {
        let source = "export default () => { let task = Promise.resolve(); for(let i=0;i<100;i++) task = task.then(() => 1); return 1; }";
        let mut guest = Guest::create(
            &retained_program("/one.js", source, "one"),
            8_388_608,
            1000,
            4096,
        )
        .unwrap();
        assert_eq!(completed(&mut guest)["result"], 1);
        assert!(guest.runtime.is_job_pending());
        assert!(
            guest
                .begin_program(
                    &retained_program("/two.js", "export default () => 2", "two"),
                    1000
                )
                .is_err()
        );
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
        let mut guest = Guest::create(&fixture("export default async ({tools}) => { const value = await tools.call({op:'filesystem.exists',path:'/'}); return [value.exists,Object.keys(process),Object.keys(process.env),typeof process.binding,typeof fetch]; }"), 8_388_608, 1000, 4096).unwrap();
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
