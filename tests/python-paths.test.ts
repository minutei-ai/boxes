import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonPathsTest.connect")(function* (directory: string) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => runtime(directory, { controlled: false })),
    (worker) => Effect.promise(() => worker.dispose()),
  );
  const service = yield* Effect.promise(() => worker.service);
  return {
    service,
    admin: yield* makeBinding(service, Redacted.make("cirro-local-test-credential")),
  };
});

test(
  "Python pathname metadata and navigation follow native inodes across closed Workers and current grants",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-paths-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "paths",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* native.admin.mintCapability("paths", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("paths", {
                op: "filesystem.mkdir",
                path: "/tmp/café",
                recursive: false,
              });
              yield* client.action("paths", {
                op: "filesystem.writeFile",
                path: "/tmp/café/data",
                content: "native",
                encoding: "utf8",
              });
              yield* client.action("paths", {
                op: "filesystem.symlink",
                path: "/tmp/alias",
                target: "/tmp/café",
              });
              yield* client.action("paths", {
                op: "filesystem.symlink",
                path: "/tmp/café/link",
                target: "/tmp/café/data",
              });
              yield* client.action("paths", {
                op: "filesystem.symlink",
                path: "/tmp/café/dangling",
                target: "/tmp/missing",
              });
              yield* client.action("paths", {
                op: "filesystem.utimes",
                path: "/tmp/café/data",
                atimeNs: 1234567890123456789n,
                mtimeNs: 1234567890987654321n,
                follow: true,
              });
              yield* client.action("paths", {
                op: "contexts.create",
                id: "reader",
                language: "python",
              });
              const seeded = yield* client.action("paths", {
                op: "python.execute",
                id: "seed",
                contextId: "reader",
                source: `import os,stat
class Path:
 def __fspath__(self):
  return b'/tmp/alias'
assert os.getcwd()=='/' and os.getcwdb()==b'/'
assert stat.S_ISDIR(os.stat(Path()).st_mode)
assert stat.S_ISLNK(os.lstat('/tmp/alias').st_mode)
os.chdir(path=Path())
assert os.getcwd()=='/tmp/café'
assert os.getcwdb()==b'/tmp/caf\\xc3\\xa9'
assert sorted(os.listdir())==['dangling','data','link']
assert sorted(os.listdir(path=None))==['dangling','data','link']
assert sorted(os.listdir(b'.'))==[b'dangling',b'data',b'link']
info=os.stat(path='link')
assert stat.S_ISREG(info.st_mode) and info.st_size==6
assert info.st_atime_ns==1234567890123456789
assert info.st_mtime_ns==1234567890987654321
assert os.stat('link',follow_symlinks=False).st_ino==os.lstat('link').st_ino
assert stat.S_ISLNK(os.lstat(path='link').st_mode)
assert os.readlink('link')=='/tmp/café/data'
assert os.readlink(path=b'link')==b'/tmp/caf\\xc3\\xa9/data'
fd=os.open('data',os.O_RDONLY)
assert os.stat(fd).st_ino==info.st_ino
assert os.stat(fd).st_size==os.fstat(fd).st_size
try:
 os.stat(fd,follow_symlinks=False)
except ValueError:
 pass
else:
 raise AssertionError('fd and follow_symlinks=False accepted')
assert os.read(fd,6)==b'native'
os.close(fd)
for operation in [lambda:os.stat('dangling'),lambda:os.stat('missing'),lambda:os.chdir('missing')]:
 try:
  operation()
 except FileNotFoundError as error:
  assert error.errno==2
 else:
  raise AssertionError('missing path accepted')
for operation in [lambda:os.listdir('data'),lambda:os.chdir('data')]:
 try:
  operation()
 except NotADirectoryError as error:
  assert error.errno==20
 else:
  raise AssertionError('file accepted as directory')
for operation in [lambda:os.stat('data',dir_fd=3),lambda:os.lstat('data',dir_fd=3),lambda:os.readlink('link',dir_fd=3)]:
 try:
  operation()
 except OSError as error:
  assert error.errno==95
 else:
  raise AssertionError('dir_fd ignored')
True`,
              });
              expect(seeded.output?.stderr).toBe("");
              expect(seeded.output?.result).toBe(true);
              expect(seeded.output?.exitCode).toBe(0);
              yield* client.action("paths", {
                op: "filesystem.move",
                from: "/tmp/café",
                to: "/tmp/moved",
              });
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          const restored = yield* client.action("paths", {
            op: "python.execute",
            id: "restore",
            contextId: "reader",
            source: `assert os.getcwd()=='/tmp/moved'
assert sorted(os.listdir())==['dangling','data','link']
with open('data','rb') as stream:
 assert stream.read()==b'native'
True`,
          });
          expect(restored.output?.stderr).toBe("");
          expect(restored.output?.result).toBe(true);
          yield* client.action("paths", {
            op: "filesystem.writeFile",
            path: "/tmp/moved/cwd_module.py",
            content: "VALUE=42\n",
            encoding: "utf8",
          });
          const isolated = yield* client.action("paths", {
            op: "python.execute",
            id: "ephemeral",
            source:
              "import os,sys\nassert os.getcwd()=='/'\nos.chdir('/tmp/moved')\nsys.path.insert(0,'')\nimport cwd_module\nassert cwd_module.__file__=='/tmp/moved/cwd_module.py'\ncwd_module.VALUE",
          });
          expect(isolated.output?.stderr).toBe("");
          expect(isolated.output?.result).toBe(42);
          yield* client.action("paths", { op: "filesystem.chmod", path: "/tmp/moved", mode: 0 });
          const unsearchable = yield* client.action("paths", {
            op: "python.execute",
            id: "mode-denied",
            contextId: "reader",
            source: `try:
 os.chdir('/tmp/moved')
except PermissionError as error:
 assert error.errno==13
else:
 raise AssertionError('directory search mode ignored')
True`,
          });
          expect(unsearchable.output?.stderr).toBe("");
          expect(unsearchable.output?.result).toBe(true);
          yield* client.action("paths", { op: "filesystem.chmod", path: "/tmp/moved", mode: 493 });
          const restricted = yield* native.admin.mintCapability("paths", {
            permissions: ["execute"],
            expiresInSeconds: 3600,
          });
          const executor = yield* makeBinding(native.service, Redacted.make(restricted.token));
          const deniedContext = yield* executor
            .action("paths", {
              op: "python.execute",
              id: "denied-context",
              contextId: "reader",
              source: "True",
            })
            .pipe(Effect.result);
          expect(deniedContext._tag).toBe("Failure");
          if (deniedContext._tag === "Failure") {
            expect(deniedContext.failure._tag).toBe("BoxesError");
            if (deniedContext.failure._tag === "BoxesError")
              expect(deniedContext.failure.status).toBe(403);
          }
          const denied = yield* executor.action("paths", {
            op: "python.execute",
            id: "denied",
            source: `import os
assert os.getcwd()=='/'
import _boxes_io
try:
 _boxes_io.call({'op':'python.file.cwd','inode':1})
except PermissionError as error:
 assert error.errno==13
else:
 raise AssertionError('private cwd bridge exposed')
for operation in [lambda:os.listdir('/tmp/moved'),lambda:os.stat('/tmp/moved/data'),lambda:os.readlink('/tmp/alias'),lambda:os.chdir('/tmp')]:
 try:
  operation()
 except PermissionError as error:
  assert error.errno==13
 else:
  raise AssertionError('current read authority ignored')
True`,
          });
          expect(denied.output?.stderr).toBe("");
          expect(denied.output?.result).toBe(true);
          yield* client.action("paths", {
            op: "filesystem.remove",
            path: "/tmp/moved",
            recursive: true,
          });
          yield* client.action("paths", {
            op: "filesystem.mkdir",
            path: "/tmp/moved",
            recursive: false,
          });
          const removed = yield* client.action("paths", {
            op: "python.execute",
            id: "removed",
            contextId: "reader",
            source: `for operation in [os.getcwd,os.listdir,lambda:os.stat('data'),lambda:os.open('data',os.O_RDONLY)]:
 try:
  operation()
 except FileNotFoundError as error:
  assert error.errno==2
 else:
  raise AssertionError('cwd rebound to replacement directory')
os.chdir('/tmp/moved')
assert os.listdir()==[]
True`,
          });
          expect(removed.output?.stderr).toBe("");
          expect(removed.output?.result).toBe(true);
          const reset = yield* client.action("paths", { op: "contexts.reset", id: "reader" });
          expect(reset.generation).toBe(1);
          const fresh = yield* client.action("paths", {
            op: "python.execute",
            id: "reset",
            contextId: "reader",
            source: "import os\n[os.getcwd(),os.listdir('/tmp/moved')]",
          });
          expect(fresh.output?.result).toEqual(["/", []]);
        }),
      ),
    ),
  60000,
);
