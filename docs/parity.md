# AgentOS parity inventory

Reference: [AgentOS README at the inspected commit](https://github.com/rivet-dev/agentos/blob/4d48628304c1ddedafc9d55f60752093fcf6f3d2/README.md). The scope is behavioral parity, not matching names or publishing endpoints that silently ignore inputs. Unsupported actions fail schema validation.

| Group      | Implemented in Cirro                                                                                   | Remaining                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| VM         | Create by ID, status, disposal tombstone                                                               | Restart semantics, immediate termination, disposal reclamation                                                              |
| Config     | Get, set, patch with management grants and atomic root publication                                     | Mounts, environment configuration, full resource/permission policies                                                        |
| Process    | Run, get and paginated metadata list; unique IDs; persistent source/result receipts                    | execFile, spawn, tree, wait, signals/kill, stdin, output replay, resize, crash recovery                                     |
| Terminal   | None                                                                                                   | PTY open/list/write/resize/read/wait/close, interactive sessions                                                            |
| Filesystem | Read/write/append, stat/lstat, exists, mkdir, readdir, move, remove, symlink/readlink, chmod, truncate | Multi-file operations, recursive listing, mount/unmount/listMounts, export, hard links, random access, timestamps/ownership |
| JavaScript | Rust QuickJS execute/evaluate/executeFile, JS/TS module graphs, captured output, scoped tools          | Full Node/CommonJS compatibility, npm packages, contexts, spawn, import attributes/URL query identities, execution options  |
| TypeScript | Rust Oxc execute/evaluate/executeFile with scoped module execution                                     | Project type checking, package resolution, contexts, spawn, execution options                                               |
| Python     | None; explicit 501 response, no Dynamic Worker fallback                                                | Bounded native interpreter, tool bridge, pip, modules/files, contexts, spawn, filesystem mount                              |
| Contexts   | None                                                                                                   | Create/get/list/reset/delete with explicit restart lifetime                                                                 |
| Network    | Capability-bound HTTPS GET, exact host policy, bounded body, no redirect following                     | Sockets/listeners, HTTP methods/headers/streaming, virtual server requests and preview URLs                                 |
| Software   | None                                                                                                   | Validated package format, digest-pinned installation, command catalog, unlink/uninstall and WASI execution                  |
| Cron       | None                                                                                                   | Durable schedules/list/cancel and idempotent command delivery                                                               |
| Shell/WASI | Initial shell parser, pipes/redirection/conditionals, fuel/memory-bounded imported-free Wasmi          | Complete POSIX shell, expansions/compound syntax/jobs, full WASI syscalls, software command parity                          |

Implemented shell commands: `pwd`, `whoami`, `cd`, `ls`, `mkdir`, `rm`, `mv`, `cp`, `echo`, `cat`, `true`, `false`, `head`, `tail`, `wc`, `sort`, `uniq`, `grep`. Options and input modes are limited. `grep` uses bounded Rust regular expressions. Shell expansions and compound syntax fail explicitly. Background syntax is rejected because durable spawn does not exist.

## Completion gates

1. Port the missing process/terminal and language contracts with real native-runtime tests. QuickJS does not provide Node compatibility.
2. Add a Rust syscall execution plane for WASI, shared durable files and software packages. The upstream browser bridge uses SharedArrayBuffer/Web Workers; Cloudflare Workers has no threading and cannot use it unchanged.
3. Complete language package resolution and filesystem integration, then compare actual upstream fixtures. Evaluate native Rust compilation and native Cloudflare runtime support before adding alternate execution infrastructure.
4. Implement durable execution recovery, cancellation, stdio replay, schedules and previews with R2 as application data owner. Define and test effects under interruption/reconnection.
5. Validate performance at large file/process inventories, CPU/memory exhaustion, concurrent agents and cold language startup.
6. Deploy using the minutei profile, validate the same flows against the remote Worker, and verify remote CI independently.

The current implementation passes the implemented-boundary tests; these gates are open. There is no total-parity or production-readiness claim.
