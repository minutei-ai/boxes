# Package wire schema

`v2.bare` is an unchanged copy of the package container schema from [rivet-dev/agentos at 4d486283](https://github.com/rivet-dev/agentos/blob/4d48628304c1ddedafc9d55f60752093fcf6f3d2/crates/vfs/package-format/v2.bare).

Copyright 2025 Rivet Gaming, Inc. Licensed under Apache-2.0; see the repository [LICENSE](../../../LICENSE).

The kernel build invokes the pinned native `vbare-compiler` to generate Rust records from this schema. `software.rs` owns container validation and the preparation of immutable file blocks. Its output is an installation plan; preparing it does not install a package or publish a sandbox root.
