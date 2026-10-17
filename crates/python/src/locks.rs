#[rustpython_vm::pymodule(name = "_thread")]
pub mod single_thread {
    use core::cell::Cell;
    use rustpython_vm::{
        FromArgs, Py, PyObjectRef, PyPayload, PyResult, VirtualMachine,
        builtins::{PyTupleRef, PyTypeRef},
        function::{FuncArgs, NameExcInfo, PosArgs, TimeoutSeconds},
        pyclass,
    };

    const THREAD_ID: u64 = 1;
    const TIMEOUT_MAX: f64 = (i64::MAX / 1_000_000_000) as f64;

    #[pyfunction]
    fn get_ident() -> u64 {
        THREAD_ID
    }

    #[derive(FromArgs)]
    struct AcquireArgs {
        #[pyarg(any, default = true)]
        blocking: bool,
        #[pyarg(any, default = TimeoutSeconds::new(-1.0))]
        timeout: TimeoutSeconds,
    }

    #[pyattr]
    #[pyclass(module = "_thread", name = "RLock")]
    #[derive(Debug, PyPayload)]
    struct RLock {
        depth: Cell<usize>,
    }

    #[pyclass(flags(BASETYPE, HAS_WEAKREF))]
    impl RLock {
        #[pyslot]
        fn slot_new(cls: PyTypeRef, args: FuncArgs, vm: &VirtualMachine) -> PyResult {
            if !args.args.is_empty() || !args.kwargs.is_empty() {
                return Err(vm.new_type_error("RLock takes no arguments"));
            }
            RLock {
                depth: Cell::new(0),
            }
            .into_ref_with_type(vm, cls)
            .map(Into::into)
        }

        #[pymethod]
        #[pymethod(name = "acquire_lock")]
        fn acquire(zelf: &Py<Self>, args: AcquireArgs, vm: &VirtualMachine) -> PyResult<bool> {
            let timeout = args.timeout.to_secs_f64();
            if !args.blocking && timeout != -1.0 {
                return Err(vm.new_value_error("can't specify a timeout for a non-blocking call"));
            }
            if timeout.is_nan() || (timeout < 0.0 && timeout != -1.0) {
                return Err(vm.new_value_error("timeout value must be a non-negative number"));
            }
            if timeout > TIMEOUT_MAX {
                return Err(vm.new_overflow_error("timeout value is too large"));
            }
            zelf.depth.set(
                zelf.depth
                    .get()
                    .checked_add(1)
                    .ok_or_else(|| vm.new_overflow_error("lock recursion limit exceeded"))?,
            );
            Ok(true)
        }

        #[pymethod]
        fn __enter__(zelf: &Py<Self>, vm: &VirtualMachine) -> PyResult<bool> {
            Self::acquire(
                zelf,
                AcquireArgs {
                    blocking: true,
                    timeout: TimeoutSeconds::new(-1.0),
                },
                vm,
            )
        }

        #[pymethod]
        #[pymethod(name = "release_lock")]
        fn release(zelf: &Py<Self>, vm: &VirtualMachine) -> PyResult<()> {
            zelf.depth.set(
                zelf.depth
                    .get()
                    .checked_sub(1)
                    .ok_or_else(|| vm.new_runtime_error("cannot release un-acquired lock"))?,
            );
            Ok(())
        }

        #[pymethod]
        fn locked(zelf: &Py<Self>) -> bool {
            zelf.depth.get() > 0
        }

        #[pymethod(name = "_is_owned")]
        fn _is_owned(zelf: &Py<Self>) -> bool {
            Self::locked(zelf)
        }

        #[pymethod(name = "_recursion_count")]
        fn _recursion_count(zelf: &Py<Self>) -> usize {
            zelf.depth.get()
        }

        #[pymethod(name = "_release_save")]
        fn _release_save(zelf: &Py<Self>, vm: &VirtualMachine) -> PyResult<(usize, u64)> {
            let count = zelf.depth.get();
            if count == 0 {
                return Err(vm.new_runtime_error("cannot release un-acquired lock"));
            }
            zelf.depth.set(0);
            Ok((count, THREAD_ID))
        }

        #[pymethod(name = "_acquire_restore")]
        fn _acquire_restore(
            zelf: &Py<Self>,
            state: PyTupleRef,
            vm: &VirtualMachine,
        ) -> PyResult<()> {
            let [count, owner] = state.as_slice() else {
                return Err(vm.new_type_error("lock state requires a count and thread identity"));
            };
            let count: usize = count.clone().try_into_value(vm)?;
            let owner: u64 = owner.clone().try_into_value(vm)?;
            if owner != THREAD_ID {
                return Err(vm.new_runtime_error("lock state belongs to another thread"));
            }
            if zelf.depth.get() != 0 {
                return Err(vm.new_runtime_error("cannot restore an acquired lock"));
            }
            zelf.depth.set(count);
            Ok(())
        }

        #[pymethod]
        fn __exit__(
            zelf: &Py<Self>,
            _args: PosArgs<PyObjectRef, NameExcInfo>,
            vm: &VirtualMachine,
        ) -> PyResult<()> {
            Self::release(zelf, vm)
        }
    }
}
