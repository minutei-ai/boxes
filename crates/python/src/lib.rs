use rustpython_vm::builtins::{PyBaseException, PyCoroutine};
use rustpython_vm::{AsObject, Interpreter, PyObjectRef, VirtualMachine, compiler, py_serde};
use serde::Serialize;
use serde_json::Value;
use std::mem::ManuallyDrop;
use wasm_bindgen::prelude::*;
include!(concat!(env!("OUT_DIR"), "/bootstrap.rs"));

const TOOLS: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(
    source = "class _Request:\n def __init__(self, action):\n  self.action = action\n def __await__(self):\n  response = yield self.action\n  return response\nclass _Tools:\n def call(self, action):\n  return _Request(action)\ntools = _Tools()\n",
    module_name = "__cirro_tools"
);

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
    source: Option<String>,
    path: String,
    evaluate: bool,
    coroutine: Option<PyObjectRef>,
    response: Option<PyObjectRef>,
    rejected: bool,
    tools: PyObjectRef,
    stdout: PyObjectRef,
    stderr: PyObjectRef,
    max_output: usize,
    done: Option<String>,
}
#[wasm_bindgen]
pub struct PythonGuest {
    state: ManuallyDrop<State>,
}
#[wasm_bindgen]
impl PythonGuest {
    #[wasm_bindgen(constructor)]
    pub fn new(
        source: &str,
        path: &str,
        evaluate: bool,
        max_output: usize,
    ) -> Result<Self, JsValue> {
        if source.len() > 1_048_576 || max_output == 0 || max_output > 1_048_576 {
            return Err(JsValue::from_str("Invalid Python limits"));
        }
        let interpreter = Interpreter::builder(Default::default())
            .add_frozen_modules(BOOTSTRAP)
            .add_frozen_modules(TOOLS)
            .build();
        let (tools, stdout, stderr) = interpreter
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
                let tools = vm
                    .import("__cirro_tools", 0)
                    .and_then(|module| module.get_attr("tools", vm))
                    .map_err(|_| "Python tools initialization failed")?;
                Ok((tools, stdout, stderr))
            })
            .map_err(|error| JsValue::from_str(&error))?;
        Ok(Self {
            state: ManuallyDrop::new(State {
                interpreter,
                source: Some(source.into()),
                path: path.into(),
                evaluate,
                coroutine: None,
                response: None,
                rejected: false,
                tools,
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
                    let scope = vm.new_scope_with_builtins();
                    scope
                        .globals
                        .set_item("tools", state.tools.clone(), vm)
                        .map_err(|_| "Python tools scope failed")?;
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
