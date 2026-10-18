import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonNamespaceTest.connect")(function* (directory: string) {
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
  "Python namespace mutations preserve modes, errors, inode lifetimes and current authority across closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-namespace-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "namespace",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* native.admin.mintCapability("namespace", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("namespace", {
                op: "contexts.create",
                id: "python",
                language: "python",
              });
              const seed = yield* client.action("namespace", {
                op: "python.execute",
                id: "seed",
                contextId: "python",
                source: `import os,errno,stat
assert callable(os.mkdir)
assert os.umask(0o027)==0o022
assert os.mkdir('/tmp/namespace') is None
assert stat.S_IMODE(os.stat('/tmp/namespace').st_mode)==0o750
os.chdir('/tmp/namespace')
os.mkdir(path='café'.encode(),mode=0o777)
assert stat.S_IMODE(os.stat('café').st_mode)==0o750
class Path:
 def __fspath__(self):
  return 'by-path'
os.mkdir(Path(),0o700)
assert stat.S_IMODE(os.stat('by-path').st_mode)==0o700
os.mkdir('zero',0)
assert stat.S_IMODE(os.stat('zero').st_mode)==0
os.rmdir('zero')
os.mkdir('empty')
os.rmdir('empty')
with open('file','w') as stream:
 stream.write('original')
for invalid,kind,number in [('file',FileExistsError,errno.EEXIST),('by-path',FileExistsError,errno.EEXIST),('file/',FileExistsError,errno.EEXIST),('missing/child',FileNotFoundError,errno.ENOENT)]:
 try:
  os.mkdir(invalid)
 except kind as error:
  assert error.errno==number
 else:
  raise AssertionError('invalid mkdir accepted')
for action,kind,number in [(lambda:os.unlink('by-path'),IsADirectoryError,errno.EISDIR),(lambda:os.rmdir('file'),NotADirectoryError,errno.ENOTDIR),(lambda:os.rmdir('by-path/.'),OSError,errno.EINVAL),(lambda:os.rmdir('by-path/./'),OSError,errno.EINVAL),(lambda:os.rmdir('/tmp/namespace'),OSError,errno.ENOTEMPTY),(lambda:os.unlink('missing'),FileNotFoundError,errno.ENOENT),(lambda:os.mkdir('unsupported-mode',0o1700),OSError,errno.ENOTSUP),(lambda:os.mkdir('unsupported-fd',dir_fd=3),OSError,errno.ENOTSUP),(lambda:os.rename('file','unused',src_dir_fd=3),OSError,errno.ENOTSUP),(lambda:os.replace('file','unused',dst_dir_fd=3),OSError,errno.ENOTSUP)]:
 try:
  action()
 except kind as error:
  assert error.errno==number
 else:
  raise AssertionError('invalid namespace operation accepted')
assert not os.path.exists('unsupported-mode') and not os.path.exists('unsupported-fd')
with open('replacement','w') as stream:
 stream.write('new')
fd=os.open('file',os.O_RDWR)
original_inode=os.fstat(fd).st_ino
assert os.rename(src='replacement',dst='file') is None
assert os.read(fd,20)==b'original' and os.fstat(fd).st_nlink==0
with open('file') as stream:
 assert stream.read()=='new'
with open('to-replace','w') as stream:
 stream.write('final')
assert os.replace('to-replace','file') is None
assert os.remove('file') is None
assert not os.path.exists('file')
os.mkdir('live')
os.mkdir('live/deep')
os.chdir('live/deep')
os.rename('/tmp/namespace/live','/tmp/namespace/moved')
assert os.getcwd()=='/tmp/namespace/moved/deep'
True`,
              });
              expect(seed.output?.stderr).toBe("");
              expect(seed.output?.exitCode).toBe(0);
              expect(seed.output?.result).toBe(true);
              for (const [name, target] of [
                ["link-file", "/tmp/namespace/linked-target"],
                ["link-dir", "/tmp/namespace/by-path"],
                ["dangling", "/tmp/namespace/absent"],
              ])
                yield* client.action("namespace", {
                  op: "filesystem.symlink",
                  path: `/tmp/namespace/${name}`,
                  target,
                });
              yield* client.action("namespace", {
                op: "filesystem.writeFile",
                path: "/tmp/namespace/linked-target",
                content: "target",
                encoding: "utf8",
              });
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          const resumed = yield* client.action("namespace", {
            op: "python.execute",
            id: "resume",
            contextId: "python",
            source: `assert os.getcwd()=='/tmp/namespace/moved/deep'
os.lseek(fd,0,0)
assert os.read(fd,20)==b'original'
assert os.fstat(fd).st_ino==original_inode and os.fstat(fd).st_nlink==0
os.lseek(fd,0,0)
os.write(fd,b'retained')
os.close(fd)
os.chdir('/tmp/namespace')
assert callable(os.remove) and callable(os.unlink)
for name in ['link-file','link-dir','dangling','link-dir/','dangling/']:
 try:
  os.mkdir(name)
 except FileExistsError as error:
  assert error.errno==errno.EEXIST
 else:
  raise AssertionError('mkdir followed an existing symlink')
for action in [lambda:os.unlink('link-dir/'),lambda:os.unlink('dangling/'),lambda:os.rmdir('link-dir/'),lambda:os.rmdir('linked-target/')]:
 try:
  action()
 except NotADirectoryError as error:
  assert error.errno==errno.ENOTDIR
 else:
  raise AssertionError('trailing slash followed a non-directory entry')
try:
 os.rmdir('link-dir')
except NotADirectoryError as error:
 assert error.errno==errno.ENOTDIR
else:
 raise AssertionError('rmdir followed a symlink')
os.unlink('link-file')
assert os.path.isfile('linked-target')
os.unlink('link-dir')
assert os.path.isdir('by-path')
os.unlink('dangling')
assert not os.path.lexists('dangling')
os.mkdir('removed-cwd')
assert stat.S_IMODE(os.stat('removed-cwd').st_mode)==0o750
os.chdir('removed-cwd')
os.rmdir('/tmp/namespace/removed-cwd')
try:
 os.getcwd()
except FileNotFoundError as error:
 assert error.errno==errno.ENOENT
else:
 raise AssertionError('removed cwd rebound')
os.chdir('/tmp/namespace')
True`,
          });
          expect(resumed.output?.stderr).toBe("");
          expect(resumed.output?.result).toBe(true);
          const readonly = yield* native.admin.mintCapability("namespace", {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const reader = yield* makeBinding(native.service, Redacted.make(readonly.token));
          const denied = yield* reader.action("namespace", {
            op: "python.execute",
            id: "denied",
            contextId: "python",
            source: `for action in [lambda:os.mkdir('denied'),lambda:os.unlink('linked-target'),lambda:os.remove('linked-target'),lambda:os.rmdir('by-path'),lambda:os.rename('linked-target','denied'),lambda:os.replace('linked-target','denied')]:
 try:
  action()
 except PermissionError as error:
  assert error.errno==errno.EACCES
 else:
  raise AssertionError('write accepted without current authority')
assert os.path.exists('linked-target') and os.path.isdir('by-path') and not os.path.exists('denied')
import _boxes_io
for action in [{'op':'python.file.mkdir','path':'/tmp/private','mode':511},{'op':'python.file.remove','path':'/tmp/namespace/linked-target','directory':False}]:
 try:
  _boxes_io.call(action)
 except PermissionError as error:
  assert error.errno==errno.EACCES
 else:
  raise AssertionError('private native request exposed')
True`,
          });
          expect(denied.output?.stderr).toBe("");
          expect(denied.output?.result).toBe(true);
          const writeOnly = yield* native.admin.mintCapability("namespace", {
            permissions: ["write", "execute"],
            expiresInSeconds: 600,
          });
          const writer = yield* makeBinding(native.service, Redacted.make(writeOnly.token));
          const write = yield* writer.action("namespace", {
            op: "python.execute",
            id: "write-only",
            source: `import os
os.mkdir('/tmp/write-only',0o700)
os.rename('/tmp/write-only','/tmp/write-renamed')
os.rmdir('/tmp/write-renamed')
True`,
          });
          expect(write.output?.stderr).toBe("");
          expect(write.output?.result).toBe(true);
          expect(
            (yield* client.action("namespace", {
              op: "filesystem.exists",
              path: "/tmp/write-renamed",
            })).exists,
          ).toBe(false);
        }),
      ),
    ),
  60000,
);
