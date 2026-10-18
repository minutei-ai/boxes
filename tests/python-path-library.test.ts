import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonPathLibraryTest.connect")(function* (directory: string) {
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
  "pinned Python os.path uses real sandbox metadata, current grants and restored native cwd",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-path-library-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "path-library",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* native.admin.mintCapability("path-library", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("path-library", {
                op: "filesystem.mkdir",
                path: "/tmp/p-lib/deep",
                recursive: true,
              });
              yield* client.action("path-library", {
                op: "filesystem.writeFile",
                path: "/tmp/p-lib/deep/data.txt",
                content: "native",
                encoding: "utf8",
              });
              for (const [path, target] of [
                ["alias", "/tmp/p-lib/deep"],
                ["dangling", "/tmp/p-lib/missing"],
                ["cycle-a", "/tmp/p-lib/cycle-b"],
                ["cycle-b", "/tmp/p-lib/cycle-a"],
              ]) {
                yield* client.action("path-library", {
                  op: "filesystem.symlink",
                  path: `/tmp/p-lib/${path}`,
                  target,
                });
              }
              yield* client.action("path-library", {
                op: "contexts.create",
                id: "reader",
                language: "python",
              });
              const seeded = yield* client.action("path-library", {
                op: "python.execute",
                id: "seed",
                contextId: "reader",
                env: { HOME: "/home/cirro", ROOT: "/tmp/p-lib" },
                source: `import os,sys
p=os.path
import os.path as alias
import posixpath,errno
assert p is alias is posixpath is sys.modules['os.path']
assert errno.ENOENT==2 and errno.ENOTDIR==20 and errno.ELOOP==40
assert errno.ENOTSUP==95 and errno.errorcode[errno.ELOOP]=='ELOOP'
assert os.strerror(errno.ENOTDIR)=='Not a directory'
assert os.strerror(987654)=='Unknown error 987654'
import _boxes_io
for code,number,kind in [('EAGAIN',errno.EAGAIN,BlockingIOError),('EINTR',errno.EINTR,InterruptedError),('EPIPE',errno.EPIPE,BrokenPipeError),('UNAUTHORIZED',errno.EACCES,PermissionError),('FORBIDDEN',errno.EACCES,PermissionError),('ELOOP',errno.ELOOP,OSError)]:
 try:
  _boxes_io.raise_fault(code,'native fault')
 except kind as error:
  assert error.errno==number and error.error==code
  assert 'native fault' in str(error)
 else:
  raise AssertionError('native fault not raised')
try:
 _boxes_io.raise_fault('VENDOR_FAULT','provider detail')
except OSError as error:
 assert error.errno is None and error.error=='VENDOR_FAULT'
 assert 'provider detail' in str(error)
else:
 raise AssertionError('unknown native fault erased')
assert os.fsencode(filename='café')==b'caf\\xc3\\xa9'
assert os.fsdecode(b'caf\\xc3\\xa9')=='café'
assert os.fsencode(os.fsdecode(b'\\xff\\x00'))==b'\\xff\\x00'
assert os.fsencode(b'\\xff\\x00')==b'\\xff\\x00'
assert os.fsdecode(filename='café')=='café'
class Path:
 def __fspath__(self):
  return '/tmp/p-lib/deep/data.txt'
assert p.basename(Path())=='data.txt'
assert p.normpath('/a//b/../c/.')=='/a/c'
assert p.normpath(b'/a//b/../c/.')==b'/a/c'
assert p.join('a','/b','c')=='/b/c'
assert p.splitext('a.tar.gz')==('a.tar','.gz')
assert p.relpath('/a/b','/a/c')=='../b'
assert p.commonpath(['/a/b','/a/c'])=='/a'
assert p.expanduser('~/data')=='/home/cirro/data'
assert p.expanduser(b'~/data')==b'/home/cirro/data'
assert p.expandvars('$ROOT/deep')=='/tmp/p-lib/deep'
assert p.expandvars(b'\${ROOT}/deep')==b'/tmp/p-lib/deep'
try:
 p.join('a',b'b')
except TypeError:
 pass
else:
 raise AssertionError('mixed bytes and str accepted')
os.chdir('/tmp/p-lib')
assert p.abspath('deep/data.txt')=='/tmp/p-lib/deep/data.txt'
assert p.abspath(b'deep/data.txt')==b'/tmp/p-lib/deep/data.txt'
assert p.exists('deep/data.txt') and p.isfile('deep/data.txt')
assert p.isdir('alias') and p.islink('alias')
assert p.lexists('dangling') and not p.exists('dangling')
assert p.getsize(Path())==6
assert p.samefile('deep/data.txt','alias/data.txt')
assert p.realpath('alias/data.txt',strict=True)=='/tmp/p-lib/deep/data.txt'
assert p.realpath(b'alias/data.txt',strict=True)==b'/tmp/p-lib/deep/data.txt'
assert p.realpath('dangling')=='/tmp/p-lib/missing'
try:
 p.realpath('dangling',strict=True)
except FileNotFoundError as error:
 assert error.errno==errno.ENOENT
else:
 raise AssertionError('strict missing path accepted')
for path,code in [('cycle-a',errno.ELOOP),('deep/data.txt/child',errno.ENOTDIR)]:
 try:
  p.realpath(path,strict=True)
 except OSError as error:
  assert error.errno==code
 else:
  raise AssertionError('invalid strict path accepted')
a=os.open('deep/data.txt',os.O_RDONLY)
b=os.open('alias/data.txt',os.O_RDONLY)
assert p.sameopenfile(a,b)
os.close(a)
os.close(b)
saved_join=p.join
saved_exists=p.exists
os.chdir('deep')
True`,
              });
              expect(seeded.output?.stderr).toBe("");
              expect(seeded.output?.result).toBe(true);
              expect(seeded.output?.exitCode).toBe(0);
              yield* client.action("path-library", {
                op: "filesystem.move",
                from: "/tmp/p-lib",
                to: "/tmp/renamed",
              });
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          const readGrant = yield* native.admin.mintCapability("path-library", {
            permissions: ["read", "execute"],
            expiresInSeconds: 3600,
          });
          const reader = yield* makeBinding(native.service, Redacted.make(readGrant.token));
          const restored = yield* reader.action("path-library", {
            op: "python.execute",
            id: "restored",
            contextId: "reader",
            source: `assert p is os.path is sys.modules['posixpath']
assert saved_join('a','b')=='a/b'
assert p.expandvars('$ROOT')=='$ROOT'
assert 'ROOT' not in os.environ
assert p.abspath('data.txt')=='/tmp/renamed/deep/data.txt'
assert saved_exists('data.txt') and p.getsize('data.txt')==6
with open('data.txt','rb') as stream:
 assert stream.read()==b'native'
try:
 open('denied','w')
except PermissionError as error:
 assert error.errno==13
else:
 raise AssertionError('read-only client wrote a file')
True`,
          });
          expect(restored.output?.stderr).toBe("");
          expect(restored.output?.result).toBe(true);
          const executeGrant = yield* native.admin.mintCapability("path-library", {
            permissions: ["execute"],
            expiresInSeconds: 3600,
          });
          const executor = yield* makeBinding(native.service, Redacted.make(executeGrant.token));
          const denied = yield* executor.action("path-library", {
            op: "python.execute",
            id: "denied",
            source: `import os,errno
assert not os.path.exists('/tmp/renamed/deep/data.txt')
assert not os.path.lexists('/tmp/renamed/deep/data.txt')
try:
 os.path.realpath('/tmp/renamed/deep/data.txt',strict=True)
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('current read grant ignored')
True`,
          });
          expect(denied.output?.stderr).toBe("");
          expect(denied.output?.result).toBe(true);
          expect(
            (yield* client.action("path-library", {
              op: "filesystem.exists",
              path: "/tmp/renamed/deep/denied",
            })).exists,
          ).toBe(false);
        }),
      ),
    ),
  60000,
);
