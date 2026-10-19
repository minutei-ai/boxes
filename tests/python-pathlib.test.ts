import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonPathlibTest.connect")(function* (directory: string) {
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
  "pinned pathlib files, links, metadata and iterators restore through R2 with current authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-pathlib-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grants = yield* Effect.scoped(
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
              const full = yield* native.admin.mintCapability("paths", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const reader = yield* native.admin.mintCapability("paths", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const executor = yield* native.admin.mintCapability("paths", {
                permissions: ["execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(full.token));
              const lazy = yield* client.action("paths", {
                op: "python.execute",
                id: "lazy",
                source:
                  "import os,sys\nassert '_boxes_paths' not in sys.modules and 'pathlib' not in sys.modules\n42",
              });
              expect(lazy.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
              yield* client.action("paths", {
                op: "contexts.create",
                id: "library",
                language: "python",
              });
              const run = yield* client.action("paths", {
                op: "python.execute",
                id: "seed",
                contextId: "library",
                source: `from pathlib import Path,PurePosixPath,PureWindowsPath
import pathlib,os,sys,stat,errno
assert Path is pathlib.Path and sys.modules['pathlib'] is pathlib
assert isinstance(Path('/'),os.PathLike)
class CustomPath:
 def __fspath__(self):
  return '/tmp/custom'
assert isinstance(CustomPath(),os.PathLike) and os.fspath(CustomPath())=='/tmp/custom'
assert os.PathLike[str].__origin__ is os.PathLike
try:
 os.PathLike()
except TypeError:
 pass
else:
 raise AssertionError('abstract PathLike was instantiated')
assert str(PurePosixPath('/a/b.txt').with_suffix('.py'))=='/a/b.py'
assert PureWindowsPath('C:/demo/a.txt').drive=='C:'
assert PureWindowsPath('C:/demo/a.txt').suffix=='.txt'
os.umask(0o027)
root=Path('/tmp/pathlib/deep')
root.mkdir(parents=True)
assert stat.S_IMODE(root.stat().st_mode)==0o750
p=root/'data.txt'
assert p.write_text('old42',encoding='utf-8')==5
assert p.read_text(encoding='utf-8')=='old42'
u=root/'unicode.txt'
u.write_text('ação',encoding='utf-8')
assert u.read_text(encoding='utf-8')=='ação'
binary=root/'binary'
assert binary.write_bytes(b'\\x00\\xff42')==4
assert binary.read_bytes()==b'\\x00\\xff42'
p.chmod(0o640)
os.utime(p,ns=(3000000001,4000000002))
assert p.stat().st_atime_ns==3000000001 and p.stat().st_mtime_ns==4000000002
copy=p.copy(root/'copied',preserve_metadata=True)
copy=copy.rename(root/'renamed')
assert copy.name=='renamed'
copy=copy.replace(root/'copied')
copy=copy.move(root/'moved-copy')
copy=copy.move(root/'copied')
assert copy.read_text()=='old42' and stat.S_IMODE(copy.stat().st_mode)==0o640
assert copy.stat().st_mtime_ns==4000000002
link=root/'relative'
link.symlink_to('data.txt')
assert link.readlink()==Path('data.txt') and link.resolve(strict=True)==p
hard=root/'hard'
hard.hardlink_to(p)
assert hard.samefile(p) and p.stat().st_nlink==2
copied_link=link.copy(root/'copied-link',follow_symlinks=False,preserve_metadata=True)
assert copied_link.is_symlink() and copied_link.readlink()==Path('data.txt')
new=root/'created'
new.touch(exist_ok=False)
new.touch()
assert new.is_file() and new.stat().st_mtime_ns>4000000002
try:
 new.touch(exist_ok=False)
except FileExistsError:
 pass
else:
 raise AssertionError('exclusive touch replaced an existing file')
assert sorted(q.name for q in root.glob('*.txt'))==['data.txt','unicode.txt']
assert 'data.txt' in [q.name for q in root.rglob('*.txt')]
assert len(list(root.walk()))==1
pending=root.iterdir()
first=next(pending)
reader=p.open('rb')
assert reader.read(2)==b'ol'
os.chdir(root)
relative=Path('data.txt')
42`,
              });
              expect(run.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
              const walking = yield* client.action("paths", {
                op: "python.execute",
                id: "walk",
                contextId: "library",
                source: `tree=Path('/tmp/walk-tree')
(tree/'keep'/'nested').mkdir(parents=True)
(tree/'skip').mkdir()
(tree/'keep'/'file.txt').write_text('42')
(tree/'alias').symlink_to('keep')
walked=list(tree.walk())
assert len(walked)==4 and 'alias' in walked[0][2] and 'alias' not in walked[0][1]
pruned=tree.walk()
base,dirs,files=next(pruned)
dirs[:]=['keep']
assert len(list(pruned))==2
assert len(list(tree.walk(top_down=False)))==4
assert len(list(tree.walk(follow_symlinks=True)))==6
byte_walk=list(os.walk(bytes(tree)))
assert all(isinstance(base,bytes) for base,dirs,files in byte_walk)
errors=[]
assert list(Path('/tmp/missing-tree').walk(on_error=errors.append))==[] and errors[0].errno==errno.ENOENT
copied_tree=(tree/'keep').copy('/tmp/copied-tree',preserve_metadata=True)
assert (copied_tree/'file.txt').read_text()=='42' and (copied_tree/'nested').is_dir()
moved_tree=copied_tree.move('/tmp/moved-tree')
assert moved_tree.is_dir() and not copied_tree.exists()
walker=tree.walk()
assert next(walker)[0]==tree
42`,
              });
              expect(walking.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
              yield* client.action("paths", {
                op: "filesystem.move",
                from: "/tmp/pathlib",
                to: "/tmp/moved",
              });
              yield* client.action("paths", {
                op: "filesystem.writeFile",
                path: "/tmp/moved/deep/data.txt",
                content: "new42",
                encoding: "utf8",
              });
              return { full, reader, executor };
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              const reader = yield* makeBinding(native.service, Redacted.make(grants.reader.token));
              const run = yield* reader.action("paths", {
                op: "python.execute",
                id: "restored",
                contextId: "library",
                source: `assert Path.cwd()==Path('/tmp/moved/deep')
assert Path is pathlib.Path and sys.modules['pathlib'] is pathlib
assert relative.read_text()=='new42'
assert reader.read()==b'd42'
reader.close()
assert len(list(pending))==7
assert len(list(walker))==3
assert not root.exists()
assert Path('relative').readlink()==Path('data.txt')
assert Path('relative').resolve(strict=True)==Path.cwd()/'data.txt'
before=relative.stat().st_mtime_ns
for action in [lambda:relative.chmod(0o777),lambda:relative.touch(),lambda:os.utime(relative,ns=(1,2)),lambda:Path('denied-link').symlink_to('data.txt'),lambda:Path('denied-hard').hardlink_to(relative),lambda:relative.write_text('denied')]:
 try:
  action()
 except PermissionError as error:
  assert error.errno==errno.EACCES
 else:
  raise AssertionError('pathlib mutation escaped current authority')
assert relative.stat().st_mtime_ns==before and relative.read_text()=='new42'
assert not Path('denied-link').exists() and not Path('denied-link').is_symlink() and not Path('denied-hard').exists()
42`,
              });
              expect(run.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
              const executor = yield* makeBinding(
                native.service,
                Redacted.make(grants.executor.token),
              );
              const contextDenied = yield* executor
                .action("paths", {
                  op: "python.execute",
                  id: "execute-only-context",
                  contextId: "library",
                  source: "42",
                })
                .pipe(Effect.result);
              expect(contextDenied).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "BoxesError", status: 403, error: "FORBIDDEN" },
              });
              const denied = yield* executor.action("paths", {
                op: "python.execute",
                id: "execute-only",
                source: `import os,errno
from os import PathLike
class ProtocolPath(PathLike):
 def __fspath__(self):
  return '/tmp/moved/deep/data.txt'
value=ProtocolPath()
assert os.fspath(value)=='/tmp/moved/deep/data.txt'
for action in [lambda:os.stat(value),lambda:os.listdir('/tmp/moved/deep'),lambda:os.readlink('/tmp/moved/deep/relative')]:
 try:
  action()
 except PermissionError as error:
  assert error.errno==errno.EACCES
 else:
  raise AssertionError('fresh filesystem read escaped current authority')
42`,
              });
              expect(denied.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
              const manager = yield* makeBinding(native.service, Redacted.make(grants.full.token));
              expect(
                (yield* manager.action("paths", { op: "contexts.get", id: "library" })).state,
              ).toBe("idle");
              yield* manager.action("paths", { op: "contexts.delete", id: "library" });
            }),
          );
        }),
      ),
    ),
  60000,
);

test(
  "native Python metadata validates timestamps, byte paths, symlink following and unsupported options",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-pathlib-metadata-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const native = yield* connect(directory);
          yield* native.admin.create({
            id: "metadata",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 16777216,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* native.admin.mintCapability("metadata", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const client = yield* makeBinding(native.service, Redacted.make(grant.token));
          const run = yield* client.action("metadata", {
            op: "python.execute",
            id: "metadata",
            source: `from pathlib import Path
import os,stat,errno
p=Path('/tmp/target')
p.write_text('42')
try:
 p.move('/tmp/missing-parent/moved')
except FileNotFoundError as error:
 assert error.errno==errno.ENOENT
else:
 raise AssertionError('missing move parent was not reported')
assert p.read_text()=='42' and not Path('/tmp/missing-parent').exists()
os.chmod(bytes(p),0o600)
assert stat.S_IMODE(p.stat().st_mode)==0o600
os.symlink(b'target',b'/tmp/link')
os.utime(b'/tmp/link',ns=(1,2),follow_symlinks=False)
assert os.lstat('/tmp/link').st_mtime_ns==2
assert p.stat().st_mtime_ns!=2
os.utime('/tmp/link',ns=(3,4))
assert p.stat().st_atime_ns==3 and p.stat().st_mtime_ns==4
os.utime(p,(1.25,2.5))
assert p.stat().st_atime_ns==1250000000 and p.stat().st_mtime_ns==2500000000
os.utime(p,(1700000001.125,1700000001.125))
assert p.stat().st_mtime_ns==1700000001125000000
os.utime(p,ns=(18446744073709551615,0))
assert p.stat().st_atime_ns==18446744073709551615
os.utime(p,None)
assert p.stat().st_atime_ns>0 and p.stat().st_atime_ns==p.stat().st_mtime_ns
os.link('/tmp/link','/tmp/hard-link',follow_symlinks=False)
assert Path('/tmp/hard-link').is_symlink() and os.readlink('/tmp/hard-link')=='target'
for action in [lambda:os.utime(p,dir_fd=3),lambda:os.chmod(p,0o600,follow_symlinks=False),lambda:os.chmod(p,0o4000),lambda:os.link(p,'/tmp/unsupported',src_dir_fd=3),lambda:os.symlink('target','/tmp/unsupported',True)]:
 try:
  action()
 except OSError as error:
  assert error.errno==errno.ENOTSUP
 else:
  raise AssertionError('unsupported option was ignored')
for action in [lambda:os.utime(p,(1,2),ns=(3,4)),lambda:os.utime(p,(float('nan'),0)),lambda:os.symlink('bad\\x00target','/tmp/bad')]:
 try:
  action()
 except ValueError:
  pass
 else:
  raise AssertionError('invalid input accepted')
for action in [lambda:os.utime(p,ns=(-1,0)),lambda:os.utime(p,ns=(18446744073709551616,0)),lambda:os.utime(p,(-1.0,0))]:
 try:
  action()
 except OverflowError:
  pass
 else:
  raise AssertionError('timestamp range was not checked')
for action in [lambda:os.utime(p,ns=(1,)),lambda:os.utime(p,ns=(1.5,2))]:
 try:
  action()
 except TypeError:
  pass
 else:
  raise AssertionError('invalid timestamp type accepted')
try:
 os.symlink('','/tmp/empty')
except FileNotFoundError:
 pass
else:
 raise AssertionError('empty symlink target accepted')
for action in [lambda:os.chmod('/'+'x'*4096,0o600),lambda:os.utime('/'+'ã'*2048),lambda:os.link('/tmp/target','/'+'x'*4096),lambda:os.symlink('x'*4097,'/tmp/long-link')]:
 try:
  action()
 except OSError as error:
  assert error.errno==errno.ENAMETOOLONG
 else:
  raise AssertionError('oversized path escaped Python error boundary')
assert not Path('/tmp/unsupported').exists()
assert not Path('/tmp/bad').exists() and not Path('/tmp/long-link').is_symlink()
42`,
          });
          expect(run.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
          const writeGrant = yield* native.admin.mintCapability("metadata", {
            permissions: ["write", "execute"],
            expiresInSeconds: 3600,
          });
          const writer = yield* makeBinding(native.service, Redacted.make(writeGrant.token));
          const written = yield* writer.action("metadata", {
            op: "python.execute",
            id: "write-only",
            source: `import os
os.chmod('/tmp/target',0o640)
os.utime('/tmp/target',ns=(11,22))
os.link('/tmp/target','/tmp/write-linked')
os.symlink('target','/tmp/write-symlink')
42`,
          });
          expect(written.output).toEqual({ stdout: "", stderr: "", result: 42, exitCode: 0 });
          const changed = yield* client.action("metadata", {
            op: "filesystem.stat",
            path: "/tmp/target",
            follow: true,
          });
          const linked = yield* client.action("metadata", {
            op: "filesystem.stat",
            path: "/tmp/write-linked",
            follow: true,
          });
          expect(changed).toMatchObject({ mode: 0o640, atimeNs: "11", mtimeNs: "22" });
          expect(linked.inode).toBe(changed.inode);
          expect(
            yield* client.action("metadata", {
              op: "filesystem.readlink",
              path: "/tmp/write-symlink",
            }),
          ).toEqual({ target: "target" });
        }),
      ),
    ),
  30000,
);
