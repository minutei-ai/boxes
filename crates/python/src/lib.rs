use rustpython_vm::builtins::{PyBaseException, PyCoroutine, PyDictRef};
use rustpython_vm::scope::Scope;
use rustpython_vm::{AsObject, Interpreter, PyObjectRef, VirtualMachine, compiler, py_serde};
use serde::Serialize;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::mem::ManuallyDrop;
use wasm_bindgen::prelude::*;
include!(concat!(env!("OUT_DIR"), "/bootstrap.rs"));

const TOOLS: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(
    source = "class _Request:\n def __init__(self, action):\n  self.action = action\n def __await__(self):\n  response = yield self.action\n  return response\nclass _Tools:\n def call(self, action):\n  return _Request(action)\ntools = _Tools()\n",
    module_name = "__cirro_tools"
);

#[rustpython_vm::pymodule(name = "os")]
mod environment {
    use rustpython_vm::{
        PyObjectRef, PyResult, VirtualMachine,
        builtins::{PyDictRef, PyStrRef},
        function::OptionalArg,
    };

    #[pyattr]
    fn environ(vm: &VirtualMachine) -> PyDictRef {
        vm.ctx.new_dict()
    }

    #[pyfunction]
    fn getenv(key: PyStrRef, default: OptionalArg<PyObjectRef>, vm: &VirtualMachine) -> PyResult {
        let module = vm.import("os", 0)?;
        let environ = module.get_attr("environ", vm)?;
        let environ: PyDictRef = environ.try_into_value(vm)?;
        Ok(environ
            .get_item_opt(&*key, vm)?
            .unwrap_or_else(|| default.unwrap_or_else(|| vm.ctx.none())))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    stdout: String,
    stderr: String,
    result: Value,
    exit_code: i32,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Step {
    Request { action: String },
    Done { output: String },
}
struct State {
    interpreter: Interpreter,
    scope: Scope,
    environment: PyDictRef,
    source: Option<String>,
    path: String,
    evaluate: bool,
    coroutine: Option<PyObjectRef>,
    response: Option<PyObjectRef>,
    rejected: bool,
    stdout: PyObjectRef,
    stderr: PyObjectRef,
    max_output: usize,
    done: Option<String>,
}
thread_local! {
    static PARKED_CONTEXTS: RefCell<BTreeMap<u32, PythonGuest>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT_CONTEXT: Cell<u32> = const { Cell::new(1) };
    static CREATED_GUESTS: Cell<u32> = const { Cell::new(0) };
}

fn environment_values(
    source: &str,
    max_output: usize,
    environment: &str,
) -> Result<BTreeMap<String, String>, JsValue> {
    if source.len() > 1_048_576 || max_output == 0 || max_output > 1_048_576 {
        return Err(JsValue::from_str("Invalid Python limits"));
    }
    if environment.len() > 65_536 {
        return Err(JsValue::from_str("Python environment exceeds its limit"));
    }
    let environment: BTreeMap<String, String> =
        serde_json::from_str(environment).map_err(|error| JsValue::from_str(&error.to_string()))?;
    if environment.len() > 128
        || environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.encode_utf16().count() > 128
                || key.contains(['=', '\0'])
                || value.len() > 4096
                || value.contains('\0')
        })
    {
        return Err(JsValue::from_str("Invalid Python environment"));
    }
    Ok(environment)
}

#[wasm_bindgen]
pub struct PythonGuest {
    state: ManuallyDrop<State>,
}
#[wasm_bindgen]
impl PythonGuest {
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
                    next.set(handle.checked_add(1).ok_or("Context handle exhausted")?);
                    Ok::<_, &str>(handle)
                })
                .map_err(JsValue::from_str)?;
            contexts.insert(handle, self);
            Ok(handle)
        })
    }

    pub fn resume(handle: u32) -> Result<PythonGuest, JsValue> {
        PARKED_CONTEXTS.with(|contexts| {
            contexts
                .borrow_mut()
                .remove(&handle)
                .ok_or_else(|| JsValue::from_str("Context handle does not exist"))
        })
    }

    pub fn quiescent(&self) -> bool {
        self.state.done.is_some()
            && self.state.source.is_none()
            && self.state.coroutine.is_none()
            && self.state.response.is_none()
    }

    pub fn begin(
        &mut self,
        source: &str,
        path: &str,
        evaluate: bool,
        environment: &str,
    ) -> Result<(), JsValue> {
        if !self.quiescent() {
            return Err(JsValue::from_str(
                "Previous Python execution is not quiescent",
            ));
        }
        let environment = environment_values(source, self.state.max_output, environment)?;
        let state = &mut *self.state;
        state
            .interpreter
            .enter(|vm| -> Result<(), String> {
                state.environment.clear();
                for (key, value) in &environment {
                    state
                        .environment
                        .set_item(key.as_str(), vm.ctx.new_str(value.as_str()).into(), vm)
                        .map_err(|_| "Python environment initialization failed")?;
                }
                for stream in [&state.stdout, &state.stderr] {
                    vm.call_method(stream, "seek", (0,))
                        .map_err(|_| "Python output reset failed")?;
                    vm.call_method(stream, "truncate", (0,))
                        .map_err(|_| "Python output reset failed")?;
                }
                vm.sys_module
                    .set_attr("stdout", state.stdout.clone(), vm)
                    .map_err(|_| "Python stdout initialization failed")?;
                vm.sys_module
                    .set_attr("stderr", state.stderr.clone(), vm)
                    .map_err(|_| "Python stderr initialization failed")?;
                Ok(())
            })
            .map_err(|error| JsValue::from_str(&error))?;
        state.source = Some(source.into());
        state.path = path.into();
        state.evaluate = evaluate;
        state.rejected = false;
        state.done = None;
        Ok(())
    }

    #[wasm_bindgen(constructor)]
    pub fn new(
        source: &str,
        path: &str,
        evaluate: bool,
        max_output: usize,
        environment: &str,
    ) -> Result<Self, JsValue> {
        let environment = environment_values(source, max_output, environment)?;
        CREATED_GUESTS.with(|created| created.set(created.get().saturating_add(1)));
        let builder = Interpreter::builder(Default::default());
        let environment_module = environment::module_def(&builder.ctx);
        let interpreter = builder
            .add_native_module(environment_module)
            .add_frozen_modules(BOOTSTRAP)
            .add_frozen_modules(TOOLS)
            .build();
        let (stdout, stderr, scope, environment) = interpreter
            .enter(|vm| -> Result<_, String> {
                let io = vm
                    .import("_io", 0)
                    .map_err(|_| "Python I/O module unavailable")?;
                let string_io = io
                    .get_attr("StringIO", vm)
                    .map_err(|_| "Python StringIO unavailable")?;
                let stdout = string_io
                    .call((), vm)
                    .map_err(|_| "Python stdout initialization failed")?;
                let stderr = string_io
                    .call((), vm)
                    .map_err(|_| "Python stderr initialization failed")?;
                vm.sys_module
                    .set_attr("stdout", stdout.clone(), vm)
                    .map_err(|_| "Python stdout initialization failed")?;
                vm.sys_module
                    .set_attr("stderr", stderr.clone(), vm)
                    .map_err(|_| "Python stderr initialization failed")?;
                let module = vm
                    .import("os", 0)
                    .map_err(|_| "Python environment module unavailable")?;
                let values = module
                    .get_attr("environ", vm)
                    .map_err(|_| "Python environment unavailable")?;
                let values: rustpython_vm::builtins::PyDictRef = values
                    .try_into_value(vm)
                    .map_err(|_| "Invalid Python environment mapping")?;
                for (key, value) in &environment {
                    values
                        .set_item(key.as_str(), vm.ctx.new_str(value.as_str()).into(), vm)
                        .map_err(|_| "Python environment initialization failed")?;
                }
                let tools = vm
                    .import("__cirro_tools", 0)
                    .and_then(|module| module.get_attr("tools", vm))
                    .map_err(|_| "Python tools initialization failed")?;
                let scope = vm.new_scope_with_builtins();
                scope
                    .globals
                    .set_item("tools", tools.clone(), vm)
                    .map_err(|_| "Python tools scope failed")?;
                Ok((stdout, stderr, scope, values))
            })
            .map_err(|error| JsValue::from_str(&error))?;
        Ok(Self {
            state: ManuallyDrop::new(State {
                interpreter,
                scope,
                environment,
                source: Some(source.into()),
                path: path.into(),
                evaluate,
                coroutine: None,
                response: None,
                rejected: false,
                stdout,
                stderr,
                max_output,
                done: None,
            }),
        })
    }
    pub fn step(&mut self) -> Result<String, JsValue> {
        let state = &mut *self.state;
        if let Some(done) = &state.done {
            return Ok(done.clone());
        }
        let source = state.source.take();
        let response = state.response.take();
        let rejected = std::mem::take(&mut state.rejected);
        let coroutine = state.coroutine.take();
        let result = state
            .interpreter
            .enter(|vm| -> Result<_, String> {
                let initial = source.is_some();
                let mut continuation = None;
                let result = if let Some(source) = source {
                    let scope = state.scope.clone();
                    let mut opts = vm.compile_opts();
                    opts.allow_top_level_await = true;
                    let mode = if state.evaluate {
                        compiler::Mode::Eval
                    } else {
                        compiler::Mode::BlockExpr
                    };
                    match vm.compile_with_opts(&source, mode, &state.path, opts) {
                        Ok(code) => vm.run_code_obj(code, scope),
                        Err(error) => {
                            return state
                                .exception(vm, &error.into_pyexception(vm, Some(&source)))
                                .map(|step| (None, step));
                        }
                    }
                } else {
                    let coroutine = coroutine.ok_or("Python continuation is missing")?;
                    let response = response.ok_or("Python host response is missing")?;
                    continuation = Some(coroutine.clone());
                    if rejected {
                        vm.call_method(&coroutine, "throw", (response,))
                    } else {
                        vm.call_method(&coroutine, "send", (response,))
                    }
                };
                let result = match result {
                    Ok(value) if !initial => {
                        state.capture(vm)?;
                        let action = py_serde::serialize(vm, &value, serde_json::value::Serializer)
                            .map_err(|error| error.to_string())?;
                        return Ok((
                            continuation,
                            Step::Request {
                                action: serde_json::to_string(&action)
                                    .map_err(|error| error.to_string())?,
                            },
                        ));
                    }
                    Ok(value) if value.downcast_ref::<PyCoroutine>().is_some() => {
                        match vm.call_method(&value, "send", (vm.ctx.none(),)) {
                            Ok(action) => {
                                state.capture(vm)?;
                                let action =
                                    py_serde::serialize(vm, &action, serde_json::value::Serializer)
                                        .map_err(|error| error.to_string())?;
                                return Ok((
                                    Some(value),
                                    Step::Request {
                                        action: serde_json::to_string(&action)
                                            .map_err(|error| error.to_string())?,
                                    },
                                ));
                            }
                            Err(error)
                                if error.fast_isinstance(vm.ctx.exceptions.stop_iteration) =>
                            {
                                error
                                    .as_object()
                                    .get_attr("value", vm)
                                    .map_err(|_| "Python completion is missing")?
                            }
                            Err(error) => {
                                let mut text = String::new();
                                vm.write_exception(&mut text, &error)
                                    .map_err(|error| error.to_string())?;
                                vm.call_method(&state.stderr, "write", (text,))
                                    .map_err(|_| "Python exception capture failed")?;
                                return state.finish(vm, Value::Null, 1).map(|step| (None, step));
                            }
                        }
                    }
                    Ok(value) => value,
                    Err(error) if error.fast_isinstance(vm.ctx.exceptions.stop_iteration) => error
                        .as_object()
                        .get_attr("value", vm)
                        .map_err(|_| "Python completion is missing")?,
                    Err(error) => {
                        return state.exception(vm, &error).map(|step| (None, step));
                    }
                };
                let result = py_serde::serialize(vm, &result, serde_json::value::Serializer)
                    .map_err(|error| error.to_string())?;
                state.finish(vm, result, 0).map(|step| (None, step))
            })
            .map_err(|error| JsValue::from_str(&error))?;
        state.coroutine = result.0;
        let step = serde_json::to_string(&result.1)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if matches!(result.1, Step::Done { .. }) {
            state.done = Some(step.clone());
        }
        Ok(step)
    }
    pub fn stdio(&self) -> Result<String, JsValue> {
        let state = &*self.state;
        state
            .interpreter
            .enter(|vm| {
                let (stdout, stderr) = state.capture(vm)?;
                serde_json::to_string(&serde_json::json!({"stdout":stdout,"stderr":stderr}))
                    .map_err(|error| error.to_string())
            })
            .map_err(|error: String| JsValue::from_str(&error))
    }

    pub fn respond(&mut self, response: &str, rejected: bool) -> Result<(), JsValue> {
        let state = &mut *self.state;
        if state.coroutine.is_none() || state.response.is_some() {
            return Err(JsValue::from_str("Python has no pending host request"));
        }
        let value = state
            .interpreter
            .enter(|vm| {
                if rejected {
                    let value: Value =
                        serde_json::from_str(response).map_err(|error| error.to_string())?;
                    let error = vm.new_runtime_error(value.to_string());
                    for (key, value) in value.as_object().ok_or("Invalid host error")? {
                        let value =
                            py_serde::deserialize(vm, value).map_err(|error| error.to_string())?;
                        error
                            .as_object()
                            .set_attr(&vm.ctx.new_str(key.clone()), value, vm)
                            .map_err(|_| "Python host error attributes failed")?;
                    }
                    Ok(error.as_object().to_owned())
                } else {
                    py_serde::deserialize(vm, &mut serde_json::Deserializer::from_str(response))
                        .map_err(|error| error.to_string())
                }
            })
            .map_err(|error: String| JsValue::from_str(&error))?;
        state.response = Some(value);
        state.rejected = rejected;
        Ok(())
    }
}

impl State {
    fn exception(
        &self,
        vm: &VirtualMachine,
        error: &rustpython_vm::Py<PyBaseException>,
    ) -> Result<Step, String> {
        let mut text = String::new();
        vm.write_exception(&mut text, error)
            .map_err(|error| error.to_string())?;
        vm.call_method(&self.stderr, "write", (text,))
            .map_err(|_| "Python exception capture failed")?;
        self.finish(vm, Value::Null, 1)
    }

    fn capture(&self, vm: &VirtualMachine) -> Result<(String, String), String> {
        let stdout = vm
            .call_method(&self.stdout, "getvalue", ())
            .and_then(|value| value.str(vm))
            .map_err(|_| "Python stdout capture failed")?
            .to_str()
            .ok_or("Python stdout is not UTF-8")?
            .to_owned();
        let stderr = vm
            .call_method(&self.stderr, "getvalue", ())
            .and_then(|value| value.str(vm))
            .map_err(|_| "Python stderr capture failed")?
            .to_str()
            .ok_or("Python stderr is not UTF-8")?
            .to_owned();
        if stdout.len() + stderr.len() > self.max_output {
            return Err("Python output budget exceeded".into());
        }
        Ok((stdout, stderr))
    }
    fn finish(&self, vm: &VirtualMachine, result: Value, exit_code: i32) -> Result<Step, String> {
        let (stdout, stderr) = self.capture(vm)?;
        let output = serde_json::to_string(&Output {
            stdout,
            stderr,
            result,
            exit_code,
        })
        .map_err(|error| error.to_string())?;
        if output.len() > self.max_output {
            return Err("Python serialized output budget exceeded".into());
        }
        Ok(Step::Done { output })
    }
}
