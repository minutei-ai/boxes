# Guest exec cwd

These Rust patches target Rivet agentOS commit `4d48628304c1ddedafc9d55f60752093fcf6f3d2`, its `wasi-ext` crate and the vendored `brush-builtins` 0.1.0 source after the upstream crate patches. They add `wasi_ext::exec_in` and pass Brush's actual working directory to the Boxes `host_process.proc_exec_v2` import. The existing `proc_exec` import carries no cwd. Neither patch infers it from exported `PWD`.

The corresponding Boxes runtime validates an absolute UTF-8 cwd of at most 4,096 bytes, resolves its physical directory and checks search permission. A successful image replacement commits that cwd with the image. Rejected admission retains the current image and cwd. `proc_fexec_v2` provides the same contract for an open executable descriptor. Both imports append `(cwd_ptr, cwd_len)` to their original arguments; existing imports retain their existing behavior. The guest wire request marks the explicit cwd so ordinary existing exec calls add no directory validation work.

Build in a separate upstream checkout. The upstream `patch-std` command modifies the installed `rust-src` for its pinned nightly; use the dedicated `nightly-2026-03-01` toolchain rather than the compiler used to build Boxes. The sysroot uses the upstream pinned wasi-sdk 25 and wasi-libc commit `574b88da481569b65a237cb80daf9a2d5aeaf82d`.

```sh
rustup toolchain install nightly-2026-03-01 --profile minimal --component rust-src --target wasm32-wasip1
git clone https://github.com/rivet-dev/agentos.git /path/to/guest-source
git -C /path/to/guest-source checkout --detach 4d48628304c1ddedafc9d55f60752093fcf6f3d2
make -C /path/to/guest-source/toolchain/c sysroot
make -C /path/to/guest-source/toolchain vendor patch-vendor patch-std
git -C /path/to/guest-source apply /path/to/boxes/tooling/guest-patches/wasi-ext-exec-cwd.patch
git -C /path/to/guest-source apply --directory=toolchain/vendor/brush-builtins /path/to/boxes/tooling/guest-patches/brush-exec-cwd.patch
make -C /path/to/guest-source/toolchain -o vendor -o patch-vendor -o patch-std -o wasm-opt-check wasm-cmd CMD=sh
cd /path/to/boxes
bun run build
bun tooling/shell-cwd-proof.ts /path/to/guest-source/toolchain/target/wasm32-wasip1/release/sh.wasm
```

The proof consumes the raw Cargo artifact, before optional `wasm-opt` processing. It runs through native Alchemy workerd, service bindings and R2. Direct relative exec, absolute exec, symlink cwd, an adulterated `PWD` and `exec -c` must all retain the correct directory. Passing the original published `sh` binary to the same proof must fail the direct case with exit 127. Native Rust fixtures separately cover `fexec`, subsequent existing exec calls, malformed pointers/paths, rejected image admission and authorization.

These patches and the proof do not update the digest-pinned published shell package or establish a production fix. Shipping the rebuilt guest, its source/notice bundle and the matching runtime remains a separate delivery gate. General C libc cwd synchronization is also still open. The runtime retains the existing patched-libc startup convention of supplying `PWD` from the validated cwd, including after `exec -c`; the empty-environment probe does not establish strict POSIX environment-clearing conformance.

Rivet agentOS source is Apache-2.0; see the repository [LICENSE](../../LICENSE). Brush is Copyright (c) 2024 reuben olinsky, MIT; its unchanged license is retained in [brush-LICENSE](brush-LICENSE).
