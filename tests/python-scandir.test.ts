import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonScandirTest.connect")(function* (directory: string) {
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
  "native Python directory entries and pinned globbing retain state and current authority across closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-scandir-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grant = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              for (const id of ["scan", "foreign"])
                yield* native.admin.create({
                  id,
                  policy: {
                    networkHosts: [],
                    interruptBudget: 100000,
                    memoryBytes: 16777216,
                    maxOutputBytes: 1048576,
                  },
                });
              const capability = yield* native.admin.mintCapability("scan", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const foreignGrant = yield* native.admin.mintCapability("foreign", {
                permissions: ["write"],
                expiresInSeconds: 3600,
              });
              const foreign = yield* makeBinding(native.service, Redacted.make(foreignGrant.token));
              yield* foreign.action("foreign", {
                op: "filesystem.writeFiles",
                entries: [{ path: "/tmp/scans/secret.py", content: "foreign", encoding: "utf8" }],
              });
              const client = yield* makeBinding(native.service, Redacted.make(capability.token));
              yield* client.action("scan", {
                op: "filesystem.writeFiles",
                entries: [
                  { path: "/tmp/scans/a.py", content: "old", encoding: "utf8" },
                  {
                    path: "/tmp/scans/changing",
                    content: "regular",
                    encoding: "utf8",
                  },
                  { path: "/tmp/scans/é.txt", content: "native", encoding: "utf8" },
                  { path: "/tmp/scans/deep/b.py", content: "nested", encoding: "utf8" },
                  { path: "/tmp/scans/.hidden.py", content: "hidden", encoding: "utf8" },
                ],
              });
              for (const [path, target] of [
                ["alias", "a.py"],
                ["directory", "deep"],
                ["dangling", "missing"],
                ["cycle", "cycle"],
              ])
                yield* client.action("scan", {
                  op: "filesystem.symlink",
                  path: `/tmp/scans/${path}`,
                  target,
                });
              yield* client.action("scan", {
                op: "contexts.create",
                id: "reader",
                language: "python",
              });
              const seed = yield* client.action("scan", {
                op: "python.execute",
                id: "seed",
                contextId: "reader",
                source: `import os,errno,stat
assert callable(os.scandir)
import glob,fnmatch
os.chdir('/tmp/scans')
with os.scandir('.') as scan:
 entries={entry.name:entry for entry in scan}
assert 'secret.py' not in entries
assert entries['a.py'].path=='./a.py'
assert os.fspath(entries['a.py'])=='./a.py'
assert isinstance(entries['a.py'],os.DirEntry)
assert entries['a.py'].is_file() and not entries['a.py'].is_dir()
assert entries['deep'].is_dir() and not entries['deep'].is_file()
assert entries['alias'].is_symlink() and entries['alias'].is_file()
assert not entries['alias'].is_file(follow_symlinks=False)
assert entries['directory'].is_dir() and not entries['directory'].is_dir(follow_symlinks=False)
assert entries['dangling'].is_symlink() and not entries['dangling'].is_file() and not entries['dangling'].is_dir()
assert entries['alias'].stat().st_ino==entries['a.py'].inode()
assert entries['alias'].stat(follow_symlinks=False).st_ino==entries['alias'].inode()
assert entries['a.py'].stat() is entries['a.py'].stat(follow_symlinks=False)
assert entries['a.py'].stat().st_size==3
cached=entries['a.py'].stat()
replaced=entries['changing']
fresh=next(entry for entry in os.scandir('.') if entry.name=='é.txt')
assert fresh.name=='é.txt'
with os.scandir(b'.') as scan:
 byte_entries={entry.name:entry for entry in scan}
assert byte_entries[b'a.py'].path==b'./a.py'
assert byte_entries[b'a.py'].__fspath__()==b'./a.py'
assert byte_entries[b'a.py'].stat().st_size==3
class Path:
 def __fspath__(self):
  return b'.'
assert all(isinstance(entry.name,bytes) for entry in os.scandir(Path()))
assert sorted(glob.glob('*.py'))==['a.py']
assert sorted(glob.glob('*.py',include_hidden=True))==['.hidden.py','a.py']
assert sorted(glob.glob('deep/**/*.py',recursive=True))==['deep/b.py']
assert list(glob.iglob('*.py',root_dir='/tmp/scans/deep'))==['b.py']
assert glob.glob(b'deep/*.py')==[b'deep/b.py']
assert fnmatch.filter(['a.py','b.txt','c.py'],'*.py')==['a.py','c.py']
assert fnmatch.fnmatchcase('a.PY','*.py') is False
for invalid,kind,number in [('/tmp/scans/a.py',NotADirectoryError,errno.ENOTDIR),('/tmp/missing',FileNotFoundError,errno.ENOENT),(-1,OSError,errno.EBADF),(3,OSError,errno.ENOTSUP)]:
 try:
  os.scandir(invalid)
 except kind as error:
  assert error.errno==number
 else:
  raise AssertionError('invalid directory accepted')
try:
 entries['cycle'].stat()
except OSError as error:
 assert error.errno==errno.ELOOP
else:
 raise AssertionError('symlink cycle accepted')
closed=os.scandir('.')
assert iter(closed) is closed
closed.close()
closed.close()
assert next(closed,None) is None
with os.scandir('.') as scope:
 first=next(scope)
assert next(scope,None) is None
try:
 with os.scandir('.') as raised:
  raise ValueError('scope')
except ValueError:
 assert next(raised,None) is None
for construct in [os.DirEntry,os.ScandirIterator]:
 try:
  construct()
 except TypeError:
  pass
 else:
  raise AssertionError('native entry constructed directly')
patterns=glob.iglob('deep/*.py')
pending=os.scandir('.')
first=next(pending)
assert all(entry.path.startswith('./') for entry in os.scandir(path='.'))
True`,
              });
              expect(seed.output?.stderr).toBe("");
              expect(seed.output?.result).toBe(true);
              expect(seed.output?.exitCode).toBe(0);
              yield* client.action("scan", {
                op: "filesystem.writeFile",
                path: "/tmp/scans/a.py",
                content: "changed",
                encoding: "utf8",
              });
              yield* client.action("scan", {
                op: "filesystem.remove",
                path: "/tmp/scans/changing",
                recursive: false,
              });
              yield* client.action("scan", {
                op: "filesystem.symlink",
                path: "/tmp/scans/changing",
                target: "a.py",
              });
              return capability.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(grant));
          const resumed = yield* client.action("scan", {
            op: "python.execute",
            id: "resume",
            contextId: "reader",
            source: `assert os.getcwd()=='/tmp/scans'
assert entries['a.py'].stat() is cached and cached.st_size==3
assert os.stat(entries['a.py']).st_size==7
assert fresh.stat().st_size==6
assert replaced.is_file() and not replaced.is_symlink()
assert stat.S_ISLNK(replaced.stat().st_mode)
assert replaced.stat() is replaced.stat(follow_symlinks=False)
assert os.stat(replaced).st_size==7
assert next(pending,None) is not None
pending.close()
assert next(pending,None) is None
assert glob.glob('deep/*.py')==['deep/b.py']
assert next(patterns)=='deep/b.py' and next(patterns,None) is None
True`,
          });
          expect(resumed.output?.stderr).toBe("");
          expect(resumed.output?.result).toBe(true);
          const readonly = yield* native.admin.mintCapability("scan", {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const reader = yield* makeBinding(native.service, Redacted.make(readonly.token));
          const denied = yield* reader.action("scan", {
            op: "python.execute",
            id: "read-authority",
            contextId: "reader",
            source: `assert len(list(os.scandir('.')))==9
assert len(list(os.scandir()))==9 and len(list(os.scandir(None)))==9
blocked=next(entry for entry in os.scandir('.') if entry.name=='é.txt')
try:
 open('denied','w')
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('directory enumeration granted write')
True`,
          });
          expect(denied.output?.stderr).toBe("");
          expect(denied.output?.result).toBe(true);
          const executeOnly = yield* native.admin.mintCapability("scan", {
            permissions: ["execute"],
            expiresInSeconds: 600,
          });
          const executor = yield* makeBinding(native.service, Redacted.make(executeOnly.token));
          const noRead = yield* executor.action("scan", {
            op: "python.execute",
            id: "without-read",
            source: `import os,errno
try:
 os.scandir('/tmp/scans')
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('enumeration accepted without read authority')
True`,
          });
          expect(noRead.output?.stderr).toBe("");
          expect(noRead.output?.result).toBe(true);
          yield* client.action("scan", {
            op: "filesystem.chmod",
            path: "/tmp/scans",
            mode: 0,
          });
          const inaccessible = yield* reader.action("scan", {
            op: "python.execute",
            id: "search-denied",
            contextId: "reader",
            source: `assert entries['a.py'].stat().st_size==3
assert blocked.is_file()
try:
 blocked.stat()
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('uncached metadata bypassed search permissions')
try:
 os.scandir('/tmp/scans')
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('directory permissions ignored')
True`,
          });
          expect(inaccessible.output?.result).toBe(true);
        }),
      ),
    ),
  60000,
);

test(
  "Python classifies 512 directory entries within its 256-request host budget",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-scandir-budget-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const native = yield* connect(directory);
          yield* native.admin.create({
            id: "many",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 16777216,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* native.admin.mintCapability("many", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* makeBinding(native.service, Redacted.make(grant.token));
          for (const batch of [0, 1, 2, 3])
            yield* client.action("many", {
              op: "filesystem.writeFiles",
              entries: Array.from({ length: 128 }, (_, index) => ({
                path: `/tmp/many/${batch * 128 + index}.py`,
                content: "",
                encoding: "utf8" as const,
              })),
            });
          const run = yield* client.action("many", {
            op: "python.execute",
            id: "classify",
            source: `import os
with os.scandir('/tmp/many') as scan:
 entries=list(scan)
assert len(entries)==512
assert len({entry.inode() for entry in entries})==512
assert all(entry.is_file() and not entry.is_dir() and not entry.is_symlink() for entry in entries)
512`,
          });
          expect(run.output?.stderr).toBe("");
          expect(run.output?.exitCode).toBe(0);
          expect(run.output?.result).toBe(512);
        }),
      ),
    ),
  60000,
);
