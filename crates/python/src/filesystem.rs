use rustpython_vm::{AsObject, PyObjectRef, PyResult, VirtualMachine, py_serde};
use serde_json::Value;

const ERROR_CODES: &[(&str, i32, &str)] = &[
    ("EPERM", 1, "Operation not permitted"),
    ("ENOENT", 2, "No such file or directory"),
    ("EINTR", 4, "Interrupted system call"),
    ("EIO", 5, "Input/output error"),
    ("EBADF", 9, "Bad file descriptor"),
    ("EAGAIN", 11, "Resource temporarily unavailable"),
    ("EACCES", 13, "Permission denied"),
    ("EBUSY", 16, "Device or resource busy"),
    ("EEXIST", 17, "File exists"),
    ("EXDEV", 18, "Invalid cross-device link"),
    ("ENOTDIR", 20, "Not a directory"),
    ("EISDIR", 21, "Is a directory"),
    ("EINVAL", 22, "Invalid argument"),
    ("EMFILE", 24, "Too many open files"),
    ("ETXTBSY", 26, "Text file busy"),
    ("EFBIG", 27, "File too large"),
    ("ENOSPC", 28, "No space left on device"),
    ("ESPIPE", 29, "Illegal seek"),
    ("EROFS", 30, "Read-only file system"),
    ("EPIPE", 32, "Broken pipe"),
    ("ENAMETOOLONG", 36, "File name too long"),
    ("ENOTEMPTY", 39, "Directory not empty"),
    ("ELOOP", 40, "Too many levels of symbolic links"),
    ("ENOTSUP", 95, "Operation not supported"),
    ("ETIMEDOUT", 110, "Connection timed out"),
    ("ESTALE", 116, "Stale file handle"),
];

pub(crate) fn strerror(code: i32) -> String {
    ERROR_CODES
        .iter()
        .find(|entry| entry.1 == code)
        .map(|entry| entry.2.to_owned())
        .unwrap_or_else(|| format!("Unknown error {code}"))
}

#[rustpython_vm::pymodule(name = "errno")]
pub mod errno {
    use super::ERROR_CODES;
    use rustpython_vm::{Py, PyResult, VirtualMachine, builtins::PyModule};

    pub(crate) fn module_exec(vm: &VirtualMachine, module: &Py<PyModule>) -> PyResult<()> {
        __module_exec(vm, module);
        let errorcode = vm.ctx.new_dict();
        for &(name, value, _) in ERROR_CODES {
            module.set_attr(name, vm.ctx.new_int(value), vm)?;
            let number = vm.new_pyobj(value);
            errorcode.set_item(&*number, vm.ctx.new_str(name).into(), vm)?;
        }
        module.set_attr("errorcode", errorcode, vm)?;
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "boxes_python")]
unsafe extern "C" {
    fn request(pointer: *const u8, length: usize) -> i32;
    fn response(pointer: *mut u8, length: usize) -> i32;
}

pub(crate) fn exchange(vm: &VirtualMachine, action: &Value) -> PyResult<Value> {
    let input =
        serde_json::to_vec(action).map_err(|error| vm.new_runtime_error(error.to_string()))?;
    if input.len() > 1_048_576 {
        return Err(vm.new_value_error("Python filesystem request exceeds its bound"));
    }
    #[cfg(not(target_arch = "wasm32"))]
    let signed_length = 0i32;
    #[cfg(target_arch = "wasm32")]
    let signed_length = unsafe { request(input.as_ptr(), input.len()) };
    let length = signed_length.unsigned_abs() as usize;
    if length == 0 || length > 25_165_824 {
        return Err(
            vm.new_runtime_error("Python filesystem host response is unavailable or oversized")
        );
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|error| vm.new_runtime_error(error.to_string()))?;
    bytes.resize(length, 0);
    #[cfg(not(target_arch = "wasm32"))]
    let copied = -1;
    #[cfg(target_arch = "wasm32")]
    let copied = unsafe { response(bytes.as_mut_ptr(), length) };
    if copied != 0 {
        return Err(vm.new_runtime_error("Python filesystem response copy failed"));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| vm.new_runtime_error(error.to_string()))?;
    if signed_length >= 0 {
        return Ok(value);
    }
    let code = value
        .get("error")
        .and_then(Value::as_str)
        .ok_or_else(|| vm.new_runtime_error("Python filesystem fault has no code"))?;
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| vm.new_runtime_error("Python filesystem fault has no message"))?;
    Err(fault(vm, code, message)?)
}

pub(crate) fn fault(
    vm: &VirtualMachine,
    code: &str,
    message: &str,
) -> PyResult<rustpython_vm::PyRef<rustpython_vm::builtins::PyBaseException>> {
    let exceptions = &vm.ctx.exceptions;
    let name = match code {
        "FORBIDDEN" | "UNAUTHORIZED" => "EACCES",
        _ => code,
    };
    let errno = ERROR_CODES
        .iter()
        .find(|entry| entry.0 == name)
        .map(|entry| entry.1);
    let kind = match name {
        "ENOENT" => exceptions.file_not_found_error,
        "ENOTDIR" => exceptions.not_a_directory_error,
        "EISDIR" => exceptions.is_a_directory_error,
        "EEXIST" => exceptions.file_exists_error,
        "EACCES" | "EPERM" => exceptions.permission_error,
        "ETIMEDOUT" => exceptions.timeout_error,
        "EINTR" => exceptions.interrupted_error,
        "EAGAIN" => exceptions.blocking_io_error,
        "EPIPE" => exceptions.broken_pipe_error,
        _ => exceptions.os_error,
    };
    let error = vm
        .new_os_subtype_error(kind.to_owned(), errno, message)
        .upcast::<rustpython_vm::builtins::PyBaseException>();
    error
        .as_object()
        .set_attr("error", vm.ctx.new_str(code), vm)?;
    Ok(error)
}

#[rustpython_vm::pymodule(name = "_boxes_io")]
pub mod native {
    use super::*;
    use base64::Engine;
    use rustpython_vm::builtins::PyStrRef;

    #[pyfunction]
    fn call(action: PyObjectRef, vm: &VirtualMachine) -> PyResult {
        let action = py_serde::serialize(vm, &action, serde_json::value::Serializer)
            .map_err(|error| vm.new_value_error(error.to_string()))?;
        if action
            .get("op")
            .and_then(Value::as_str)
            .is_some_and(|op| op.starts_with("python.file."))
        {
            return Err(fault(
                vm,
                "FORBIDDEN",
                "Native descriptor requests are private",
            )?);
        }
        let value = exchange(vm, &action)?;
        py_serde::deserialize(vm, &value).map_err(|error| vm.new_runtime_error(error.to_string()))
    }

    #[pyfunction]
    fn raise_fault(code: PyStrRef, message: PyStrRef, vm: &VirtualMachine) -> PyResult {
        let code = code
            .as_utf8()
            .ok_or_else(|| vm.new_value_error("Filesystem fault code must be UTF-8"))?;
        let message = message
            .as_utf8()
            .ok_or_else(|| vm.new_value_error("Filesystem fault message must be UTF-8"))?;
        Err(fault(vm, code.as_str(), message.as_str())?)
    }

    #[pyfunction]
    fn read_source(path: PyStrRef, vm: &VirtualMachine) -> PyResult {
        let path = path
            .as_utf8()
            .ok_or_else(|| vm.new_value_error("Python module path must be UTF-8"))?;
        let value = exchange(
            vm,
            &serde_json::json!({
                "op": "filesystem.readFile", "path": path.as_str(),
                "offset": 0, "length": 1_048_577,
            }),
        )?;
        let encoded = value
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| vm.new_runtime_error("Python source response has no content"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| vm.new_runtime_error(error.to_string()))?;
        if bytes.len() > 1_048_576 {
            return Err(vm.new_value_error("Python module source exceeds one MiB"));
        }
        Ok(vm.ctx.new_bytes(bytes).into())
    }
}

pub const IMPORTS: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(
    source = r#"
import sys as _sys
import _frozen_importlib as _bootstrap
import _boxes_io as _io
import os as _os

class _Spec(_bootstrap.ModuleSpec):
 @property
 def cached(self):
  return None

class _Loader:
 def __init__(self, filename):
  self.filename = filename
 def create_module(self, spec):
  return None
 def exec_module(self, module):
  if self.filename is None:
   return
  source = _io.read_source(self.filename)
  code = compile(source, self.filename, 'exec', dont_inherit=True)
  exec(code, module.__dict__)

def _stat(result):
 if result['stat'] is not None:
  return result['stat']
 if result['code'] in ('ENOENT','ENOTDIR'):
  return None
 _io.raise_fault(result['code'], result['error'])

class _Finder:
 def find_spec(self, fullname, path=None, target=None):
  search = _sys.path if path is None else path
  leaf = fullname.rpartition('.')[2]
  namespaces = []
  for entry in search:
   if not isinstance(entry, str):
    continue
   if not entry.startswith('/'):
    entry = _os.getcwd().rstrip('/') + '/' + entry
   base = entry.rstrip('/') + '/' + leaf
   package, module, directory = _io.call({'op':'filesystem.statFiles','paths':[base+'/__init__.py',base+'.py',base],'follow':True})
   filename = base + '/__init__.py'
   info = _stat(package)
   if info is not None and info['kind'] == 'file':
    spec = _Spec(fullname, _Loader(filename), origin=filename, is_package=True)
    spec.has_location = True
    spec.submodule_search_locations = [base]
    return spec
   filename = base + '.py'
   info = _stat(module)
   if info is not None and info['kind'] == 'file':
    spec = _Spec(fullname, _Loader(filename), origin=filename, is_package=False)
    spec.has_location = True
    return spec
   info = _stat(directory)
   if info is not None and info['kind'] == 'directory':
    namespaces.append(base)
  if namespaces:
   spec = _Spec(fullname, _Loader(None), is_package=True)
   spec.submodule_search_locations = namespaces
   return spec
  return None

def _install_io():
 import _pyio
 import io
 import _io as native
 import builtins
 for name in ('BufferedReader','BufferedWriter','BufferedRandom','BufferedRWPair','TextIOWrapper'):
  setattr(_pyio, name, getattr(native, name))
 io.FileIO = _pyio.FileIO
 native.FileIO = _pyio.FileIO
 io.open = _pyio.open
 native.open = _pyio.open
 builtins.open = _pyio.open
 return _pyio

def _io_attribute(name):
 if name == 'FileIO':
  return _install_io().FileIO
 raise AttributeError(name)

def _os_attribute(name):
 if name in ('PathLike','walk','_walk_symlinks_as_files'):
  import _boxes_paths
  _boxes_paths.PathLike.__module__ = 'os'
  _boxes_paths.walk.__module__ = 'os'
  _os.PathLike = _boxes_paths.PathLike
  _os.walk = _boxes_paths.walk
  _os._walk_symlinks_as_files = _boxes_paths._walk_symlinks_as_files
  return getattr(_boxes_paths,name)
 raise AttributeError(name)

def open(*args, **kwargs):
 return _install_io().open(*args, **kwargs)

def install(filename):
 import builtins
 import _io as native
 import io
 import posixpath
 _os.__getattr__ = _os_attribute
 _os.path = posixpath
 _os.curdir = posixpath.curdir
 _os.supports_follow_symlinks = {_os.stat, _os.link, _os.utime}
 _sys.modules['os.path'] = posixpath
 builtins.open = open
 native.open = open
 native.__getattr__ = _io_attribute
 io.open = open
 del io.FileIO
 io.__getattr__ = _io_attribute
 _sys.meta_path.append(_Finder())
 _sys.path.insert(0, filename.rpartition('/')[0] or '/')
"#,
    module_name = "_boxes_imports"
);
