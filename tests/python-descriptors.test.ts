import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("pythonDescriptorsTest.connect")(function* (directory: string) {
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
  "native Python descriptors share dup offsets and retain unlinked blocks across closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-descriptors-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "descriptors",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100_000,
                  memoryBytes: 8_388_608,
                  maxOutputBytes: 1_048_576,
                },
              });
              const grant = yield* native.admin.mintCapability("descriptors", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("descriptors", {
                op: "contexts.create",
                id: "files",
                language: "python",
              });
              yield* client.action("descriptors", {
                op: "filesystem.writeFile",
                path: "/tmp/read.bin",
                content: "YWJjAP9kZWY=",
                encoding: "base64",
              });
              const seeded = yield* client.action("descriptors", {
                op: "python.execute",
                id: "seed",
                contextId: "files",
                source: `import os
class Path:
 def __fspath__(self):
  return b'/tmp/read.bin'
fd=os.open(Path(),os.O_RDONLY|os.O_CLOEXEC)
alias=os.dup(fd)
separate=os.open('/tmp/read.bin',os.O_RDONLY)
assert not os.get_inheritable(fd)
assert not os.get_inheritable(separate)
assert not os.get_inheritable(alias)
os.set_inheritable(alias,True)
assert os.get_inheritable(alias) and not os.get_inheritable(fd)
assert os.read(fd,2)==b'ab'
assert os.read(alias,1)==b'c'
assert os.read(separate,1)==b'a'
info=os.fstat(fd)
assert info.st_mode & 0o170000 == 0o100000
assert info[1]==info.st_ino and info[6]==8
assert info.st_nlink==1 and isinstance(info.st_mtime_ns,int)
await tools.call({'op':'filesystem.chmod','path':'/tmp/read.bin','mode':0})
try:
 os.open('/tmp/read.bin',os.O_RDONLY)
except PermissionError as error:
 assert error.errno==13
else:
 raise AssertionError('new open ignored mode')
await tools.call({'op':'filesystem.move','from':'/tmp/read.bin','to':'/tmp/renamed.bin'})
assert os.read(alias,2)==b'\\x00\\xff'
assert os.lseek(fd,-1,os.SEEK_END)==7
assert os.read(fd,10)==b'f'
os.lseek(fd,1,os.SEEK_SET)
await tools.call({'op':'filesystem.remove','path':'/tmp/renamed.bin','recursive':False})
assert os.fstat(fd).st_nlink==0
[fd,alias,separate,os.read(fd,2).decode()]`,
              });
              expect(seeded.output?.stderr).toBe("");
              expect(seeded.output?.result).toEqual([3, 4, 5, "bc"]);
              return grant.token;
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              const client = yield* makeBinding(native.service, Redacted.make(token));
              const resumed = yield* client.action("descriptors", {
                op: "python.execute",
                id: "resume",
                contextId: "files",
                source: `assert os.read(alias,2)==b'\\x00\\xff'
assert os.lseek(separate,0,os.SEEK_CUR)==1
assert os.read(separate,20)==b'bc\\x00\\xffdef'
assert os.read(separate,0)==b''
assert os.read(separate,20)==b''
assert os.fstat(fd).st_nlink==0
os.close(fd)
assert os.read(alias,1)==b'd'
os.close(alias)
os.close(separate)
errors=[]
for operation in [lambda:os.read(fd,1),lambda:os.close(fd),lambda:os.lseek(fd,0,0),lambda:os.fstat(fd),lambda:os.dup(fd),lambda:os.get_inheritable(fd)]:
 try:
  operation()
 except OSError as error:
  errors.append(error.errno)
errors`,
              });
              expect(resumed.output?.stderr).toBe("");
              expect(resumed.output?.result).toEqual([9, 9, 9, 9, 9, 9]);
              const missing = yield* client.action("descriptors", {
                op: "filesystem.exists",
                path: "/tmp/renamed.bin",
              });
              expect(missing.exists).toBe(false);
              const reducedGrant = yield* native.admin.mintCapability("descriptors", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const readOnly = yield* makeBinding(
                native.service,
                Redacted.make(reducedGrant.token),
              );
              const modes = yield* readOnly.action("descriptors", {
                op: "python.execute",
                id: "reject",
                source: `import os,_boxes_io
errors=[]
for operation in [lambda:os.open('/tmp/uncreated',os.O_WRONLY|os.O_CREAT),lambda:os.open('/tmp/uncreated',os.O_RDONLY,dir_fd=3),lambda:_boxes_io.call({'op':'python.file.openRead','path':'/tmp/uncreated'})]:
 try:
  operation()
 except OSError as error:
  errors.append(error.errno)
errors`,
              });
              expect(modes.output?.stderr).toBe("");
              expect(modes.output?.result).toEqual([13, 95, 13]);
              expect(
                (yield* client.action("descriptors", {
                  op: "filesystem.exists",
                  path: "/tmp/uncreated",
                })).exists,
              ).toBe(false);
              yield* client.action("descriptors", {
                op: "filesystem.writeFile",
                path: "/tmp/large.bin",
                encoding: "base64",
                content: Buffer.alloc(262_145, 97).toString("base64"),
              });
              const bounded = yield* client.action("descriptors", {
                op: "python.execute",
                id: "bounded",
                source: `import os
fd=os.open('/tmp/large.bin',os.O_RDONLY)
first=os.read(fd,1000000)
assert len(first)==262144 and first==b'a'*262144
assert os.read(fd,1000000)==b'a'
assert os.read(fd,1)==b''
try:
 os.lseek(fd,-262146,os.SEEK_CUR)
except OSError as error:
 assert error.errno==22
else:
 raise AssertionError('negative seek succeeded')
assert os.lseek(fd,0,os.SEEK_CUR)==262145
os.lseek(fd,0,os.SEEK_SET)
try:
 os.read(fd,-1)
except OSError as error:
 assert error.errno==22
else:
 raise AssertionError('negative length succeeded')
assert os.lseek(fd,0,os.SEEK_CUR)==0
for buffer in (b'readonly',memoryview(bytearray(8))[::2]):
 try:
  os.readinto(fd,buffer)
 except (TypeError,BufferError):
  pass
 else:
  raise AssertionError('invalid readinto buffer accepted')
 assert os.lseek(fd,0,os.SEEK_CUR)==0
os.close(fd)
original=os.open('/tmp/large.bin',os.O_RDONLY)
fds=[original]+[os.dup(original) for _ in range(124)]
assert fds[-1]==127
try:
 os.open('/tmp/large.bin',os.O_RDONLY)
except OSError as error:
 assert error.errno==24
else:
 raise AssertionError('descriptor limit ignored')
try:
 os.dup(original)
except OSError as error:
 assert error.errno==24
else:
 raise AssertionError('duplicate descriptor limit ignored')
os.close(fds[10])
assert os.open('/tmp/large.bin',os.O_RDONLY)==fds[10]
for item in fds:
 os.close(item)
len(first)`,
              });
              expect(bounded.output?.stderr).toBe("");
              expect(bounded.output?.result).toBe(262_144);
            }),
          );
        }),
      ),
    ),
  60_000,
);

test(
  "Python standard-library open reads buffered binary and decoded text through native descriptors",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-open-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "reading",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100_000,
                  memoryBytes: 16_777_216,
                  maxOutputBytes: 1_048_576,
                },
              });
              const grant = yield* native.admin.mintCapability("reading", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("reading", {
                op: "contexts.create",
                id: "stream",
                language: "python",
              });
              yield* client.action("reading", {
                op: "filesystem.writeFile",
                path: "/tmp/text",
                encoding: "utf8",
                content: "ação\r\nsegunda\rfinal\n",
              });
              const direct = yield* client.action("reading", {
                op: "python.execute",
                id: "native-fileio",
                source: `from _io import FileIO
import io
assert FileIO is io.FileIO
with FileIO('/tmp/text','r') as raw:
 assert raw.read(2)==b'a\\xc3'
assert raw.closed
True`,
              });
              expect(direct.output?.stderr).toBe("");
              expect(direct.output?.result).toBe(true);
              const opened = yield* client.action("reading", {
                op: "python.execute",
                id: "open",
                contextId: "stream",
                source: `import io,os,_io
assert '_pyio' not in __import__('sys').modules
from io import FileIO
assert FileIO is io.FileIO and FileIO is _io.FileIO
assert isinstance(FileIO,type) and issubclass(FileIO,io.RawIOBase)
with FileIO('/tmp/text','r') as raw:
 assert raw.read(2)==b'a\\xc3'
with open('/tmp/text') as default:
 assert default.readline()=='ação\\n'
stream=io.open('/tmp/text','r',encoding='utf-8')
assert isinstance(stream,io.TextIOWrapper)
assert stream.readline()=='ação\\n'
with open('/tmp/text','rb',buffering=0) as raw:
 assert isinstance(raw,io.FileIO)
 data=bytearray(4)
 assert raw.readinto(data)==4
 assert bytes(data)==b'a\\xc3\\xa7\\xc3'
 assert raw.seek(0)==0
 assert raw.read()==b'a\\xc3\\xa7\\xc3\\xa3o\\r\\nsegunda\\rfinal\\n'
fd=os.open('/tmp/text',os.O_RDONLY)
with open(fd,'rb',closefd=False) as borrowed:
 assert borrowed.read(1)==b'a'
assert os.lseek(fd,0,os.SEEK_CUR)>0
os.close(fd)
[stream.tell(),stream.closed,raw.closed]`,
              });
              expect(opened.output?.stderr).toBe("");
              expect(opened.output?.exitCode).toBe(0);
              expect(opened.output?.result).toEqual([8, false, true]);
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          const reducedGrant = yield* native.admin.mintCapability("reading", {
            permissions: ["read", "execute"],
            expiresInSeconds: 3600,
          });
          const readOnly = yield* makeBinding(native.service, Redacted.make(reducedGrant.token));
          const resumed = yield* readOnly.action("reading", {
            op: "python.execute",
            id: "resume",
            contextId: "stream",
            source: `assert FileIO is io.FileIO and FileIO is _io.FileIO
assert stream.readline()=='segunda\\n'
assert stream.read()=='final\\n'
stream.close()
errors=[]
for mode in ('w','a','x','r+'):
 try:
  open('/tmp/uncreated',mode)
 except OSError as error:
  errors.append(error.errno)
[errors,stream.closed]`,
          });
          expect(resumed.output?.stderr).toBe("");
          expect(resumed.output?.result).toEqual([[13, 13, 13, 13], true]);
          expect(
            (yield* client.action("reading", { op: "filesystem.exists", path: "/tmp/uncreated" }))
              .exists,
          ).toBe(false);
        }),
      ),
    ),
  60_000,
);

test(
  "Python writes and retained buffered flush publish to R2 with inode rights and exclusive creation",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-write-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grants = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "writing",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const full = yield* native.admin.mintCapability("writing", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const readOnly = yield* native.admin.mintCapability("writing", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(full.token));
              yield* client.action("writing", {
                op: "contexts.create",
                id: "writer",
                language: "python",
              });
              const created = yield* client.action("writing", {
                op: "python.execute",
                id: "create",
                contextId: "writer",
                source: `import os
assert os.umask(0o077)==0o022
writer=open('/tmp/text','w+',encoding='utf-8')
assert writer.write('ação\\n')==5
writer.flush()
writer.write('pendente')
[writer.closed,writer.writable()]`,
              });
              expect(created.output?.stderr).toBe("");
              expect(created.output?.result).toEqual([false, true]);
              const content = yield* client.action("writing", {
                op: "filesystem.readFile",
                path: "/tmp/text",
              });
              expect(Buffer.from(content.content, "base64").toString()).toBe("ação\n");
              return { full: full.token, readOnly: readOnly.token };
            }),
          );
          const native = yield* connect(directory);
          const readOnly = yield* makeBinding(native.service, Redacted.make(grants.readOnly));
          const denied = yield* readOnly.action("writing", {
            op: "python.execute",
            id: "denied",
            contextId: "writer",
            source: `try:
 writer.flush()
except PermissionError as error:
 denied=error.errno
else:
 raise AssertionError('readonly flush succeeded')
denied`,
          });
          expect(denied.output?.stderr).toBe("");
          expect(denied.output?.result).toBe(13);
          const client = yield* makeBinding(native.service, Redacted.make(grants.full));
          const resumed = yield* client.action("writing", {
            op: "python.execute",
            id: "resume",
            contextId: "writer",
            source: `import os
assert os.umask(0o022)==0o077
assert os.fstat(writer.fileno()).st_mode & 0o777 == 0o600
writer.flush()
writer.seek(0)
assert writer.read()=='ação\\npendente'
writer.close()
with open('/tmp/raw','w+b',buffering=0) as raw:
 assert raw.write(b'abc')==3
 raw.seek(5)
 assert raw.write(b'Z')==1
 raw.seek(0)
 assert raw.read()==b'abc\\x00\\x00Z'
 raw.seek(6)
 raw.truncate(2)
 assert raw.tell()==6
 await tools.call({'op':'filesystem.move','from':'/tmp/raw','to':'/tmp/moved'})
 await tools.call({'op':'filesystem.chmod','path':'/tmp/moved','mode':0})
 raw.seek(0,2)
 assert raw.write(b'!')==1
 raw.seek(0)
 assert raw.read()==b'ab!'
try:
 open('/tmp/text','x')
except FileExistsError as error:
 assert error.errno==17
else:
 raise AssertionError('exclusive open replaced file')
await tools.call({'op':'filesystem.symlink','path':'/tmp/dangling','target':'/tmp/missing-target'})
try:
 open('/tmp/dangling','x')
except FileExistsError:
 pass
else:
 raise AssertionError('exclusive open followed symlink')
with open('/tmp/text','a',encoding='utf-8') as appended:
 appended.seek(0)
 appended.write('!')
append_fd=os.open('/tmp/text',os.O_WRONLY|os.O_APPEND)
os.lseek(append_fd,0,os.SEEK_SET)
assert os.write(append_fd,b'')==0
assert os.lseek(append_fd,0,os.SEEK_CUR)==0
os.close(append_fd)
with open('/tmp/chunks','wb') as chunks:
 assert chunks.write(b'a'*262145)==262145
writer.closed`,
          });
          expect(resumed.output?.stderr).toBe("");
          expect(resumed.output?.result).toBe(true);
          expect(
            Buffer.from(
              (yield* client.action("writing", { op: "filesystem.readFile", path: "/tmp/text" }))
                .content,
              "base64",
            ).toString(),
          ).toBe("ação\npendente!");
          expect(
            (yield* client.action("writing", {
              op: "filesystem.exists",
              path: "/tmp/missing-target",
            })).exists,
          ).toBe(false);
          expect(
            (yield* client.action("writing", { op: "filesystem.exists", path: "/tmp/raw" })).exists,
          ).toBe(false);
          expect(
            (yield* client.action("writing", {
              op: "filesystem.stat",
              path: "/tmp/chunks",
              follow: true,
            })).size,
          ).toBe(262145);
          expect(
            (yield* client.action("writing", {
              op: "filesystem.readFile",
              path: "/tmp/chunks",
              offset: 262144,
              length: 1,
            })).content,
          ).toBe("YQ==");
        }),
      ),
    ),
  60000,
);

test(
  "ephemeral Python flushes open streams before publishing completion",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-exit-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const native = yield* connect(directory);
          yield* native.admin.create({
            id: "finishing",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 16777216,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* native.admin.mintCapability("finishing", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 3600,
          });
          const client = yield* makeBinding(native.service, Redacted.make(grant.token));
          const finished = yield* client.action("finishing", {
            op: "python.execute",
            id: "normal",
            source: `writer=open('/tmp/normal','w',encoding='utf-8')
writer.write('ação no fim')
42`,
          });
          expect(finished.output?.stderr).toBe("");
          expect(finished.output?.result).toBe(42);
          const content = yield* client.action("finishing", {
            op: "filesystem.readFile",
            path: "/tmp/normal",
          });
          expect(Buffer.from(content.content, "base64").toString()).toBe("ação no fim");
          const composed = yield* client.action("finishing", {
            op: "python.execute",
            id: "composed",
            source: `import io,gc
anchor=open('/tmp/anchor','w')
anchor.write('anchor')
raw=io.FileIO('/tmp/manual','w')
buffered=io.BufferedWriter(raw)
buffered.write(b'manual')
cycle=[buffered]
cycle.append(cycle)
gc.freeze()
42`,
          });
          expect(composed.output?.stderr).toBe("");
          expect(composed.output?.result).toBe(42);
          expect(
            Buffer.from(
              (yield* client.action("finishing", {
                op: "filesystem.readFile",
                path: "/tmp/manual",
              })).content,
              "base64",
            ).toString(),
          ).toBe("manual");
          const errored = yield* client.action("finishing", {
            op: "python.execute",
            id: "exception",
            source: `writer=open('/tmp/exception','wb')
writer.write(b'preserved')
raise ValueError('after buffering')`,
          });
          expect(errored.output?.exitCode).toBe(1);
          expect(errored.output?.stderr).toContain("after buffering");
          expect(
            Buffer.from(
              (yield* client.action("finishing", {
                op: "filesystem.readFile",
                path: "/tmp/exception",
              })).content,
              "base64",
            ).toString(),
          ).toBe("preserved");
          const failed = yield* client.action("finishing", {
            op: "python.execute",
            id: "bad-fd",
            source: `import os
writer=open('/tmp/failure','wb')
writer.write(b'uncommitted')
os.close(writer.fileno())
42`,
          });
          expect(failed.output?.exitCode).toBe(1);
          expect(failed.output?.result).toBeNull();
          expect(failed.output?.stderr).toContain("Bad file descriptor");
          expect(
            (yield* client.action("finishing", { op: "filesystem.readFile", path: "/tmp/failure" }))
              .content,
          ).toBe("");
          const partial = yield* client.action("finishing", {
            op: "python.execute",
            id: "uninitialized",
            source: `import io
writer=open('/tmp/partial','w')
writer.write('complete')
partial=io.BufferedWriter.__new__(io.BufferedWriter)
42`,
          });
          expect(partial.output?.stderr).toBe("");
          expect(partial.output?.result).toBe(42);
          expect(
            Buffer.from(
              (yield* client.action("finishing", {
                op: "filesystem.readFile",
                path: "/tmp/partial",
              })).content,
              "base64",
            ).toString(),
          ).toBe("complete");
          const beforeTrap = yield* client.action("finishing", { op: "vm.status" });
          const trapped = yield* client.action("finishing", {
            op: "python.execute",
            id: "unlinked-trap",
            source: `import os
fd=os.open('/tmp/trapped',os.O_RDWR|os.O_CREAT,0o600)
os.write(fd,b'trapped')
await tools.call({'op':'filesystem.remove','path':'/tmp/trapped','recursive':False})
while True:
 pass`,
          });
          expect(trapped.status).toBe("failed");
          expect((yield* client.action("finishing", { op: "vm.status" })).filesystemBytes).toBe(
            beforeTrap.filesystemBytes,
          );
          expect(
            (yield* client.action("finishing", { op: "filesystem.exists", path: "/tmp/trapped" }))
              .exists,
          ).toBe(false);
        }),
      ),
    ),
  60000,
);

test(
  "unlinked Python files share native bytes across opens and restore through R2 without replacing recreated paths",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-detached-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grants = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "detached",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const full = yield* native.admin.mintCapability("detached", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const reduced = yield* native.admin.mintCapability("detached", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(full.token));
              yield* client.action("detached", {
                op: "filesystem.writeFile",
                path: "/tmp/open",
                content: "abcdef",
                encoding: "utf8",
              });
              yield* client.action("detached", {
                op: "contexts.create",
                id: "files",
                language: "python",
              });
              const created = yield* client.action("detached", {
                op: "python.execute",
                id: "create",
                contextId: "files",
                source: `import os
left=os.open('/tmp/open',os.O_RDWR)
right=os.open('/tmp/open',os.O_RDWR|os.O_APPEND)
alias=os.dup(left)
original_table=os._boxes_descriptors
os._boxes_descriptors=None
import sys,_imp
os_spec=os.__spec__
del sys.modules['os']
replacement=_imp.create_builtin(os_spec)
assert replacement._boxes_descriptors is original_table
sys.modules['os']=os
await tools.call({'op':'filesystem.remove','path':'/tmp/open','recursive':False})
assert os.write(left,b'XY')==2
assert os.lseek(left,0,1)==2
assert os.read(right,6)==b'XYcdef'
assert os.write(right,b'!')==1
os.ftruncate(left,4)
assert os.lseek(alias,0,1)==2
assert os.read(alias,2)==b'cd'
os.lseek(right,0,0)
assert os.read(right,20)==b'XYcd'
writer=open('/tmp/buffered','w+b')
buffer_reader=os.open('/tmp/buffered',os.O_RDONLY)
writer.write(b'buffered')
await tools.call({'op':'filesystem.remove','path':'/tmp/buffered','recursive':False})
writer.flush()
writer.close()
assert os.read(buffer_reader,2)==b'bu'
[os.fstat(left).st_size,os.fstat(right).st_nlink]`,
              });
              expect(created.output?.stderr).toBe("");
              expect(created.output?.result).toEqual([4, 0]);
              expect(
                (yield* client.action("detached", { op: "filesystem.exists", path: "/tmp/open" }))
                  .exists,
              ).toBe(false);
              return { full: full.token, reduced: reduced.token };
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              const client = yield* makeBinding(native.service, Redacted.make(grants.reduced));
              const denied = yield* client.action("detached", {
                op: "python.execute",
                id: "denied",
                contextId: "files",
                source: `errors=[]
for operation in (lambda:os.write(left,b'denied'),lambda:os.ftruncate(right,0)):
 try:
  operation()
 except PermissionError as error:
  errors.append(error.errno)
os.lseek(right,0,0)
assert os.read(buffer_reader,20)==b'ffered'
[errors,os.read(right,20).decode(),os.lseek(alias,0,1)]`,
              });
              expect(denied.output?.stderr).toBe("");
              expect(denied.output?.result).toEqual([[13, 13], "XYcd", 4]);
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(grants.full));
          yield* client.action("detached", {
            op: "filesystem.writeFile",
            path: "/tmp/open",
            content: "recreated",
            encoding: "utf8",
          });
          const restored = yield* client.action("detached", {
            op: "python.execute",
            id: "restore",
            contextId: "files",
            source: `os.lseek(left,6,0)
assert os.write(left,b'Z')==1
assert os.write(right,b'?')==1
assert os.read(alias,1)==b'?'
os.lseek(right,0,0)
assert os.read(right,20)==b'XYcd\\x00\\x00Z?'
assert os.fstat(right).st_size==8
os.close(left)
os.close(alias)
os.close(right)
os.close(buffer_reader)
True`,
          });
          expect(restored.output?.stderr).toBe("");
          expect(restored.output?.result).toBe(true);
          expect(
            Buffer.from(
              (yield* client.action("detached", { op: "filesystem.readFile", path: "/tmp/open" }))
                .content,
              "base64",
            ).toString(),
          ).toBe("recreated");
        }),
      ),
    ),
  60000,
);

test(
  "retained Python inodes enforce filesystem quota until the last alias closes and permit write-only mutation",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-detached-quota-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const native = yield* connect(directory);
          yield* native.admin.create({
            id: "cache",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 33554432,
              maxOutputBytes: 1048576,
            },
          });
          const full = yield* native.admin.mintCapability("cache", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 3600,
          });
          const client = yield* makeBinding(native.service, Redacted.make(full.token));
          const quota = yield* client.action("cache", {
            op: "python.execute",
            id: "quota",
            source: `import os
a=os.open('/tmp/a',os.O_RDWR|os.O_CREAT,0o600)
dup=os.dup(a)
b=os.open('/tmp/b',os.O_RDWR|os.O_CREAT,0o600)
await tools.call({'op':'filesystem.remove','path':'/tmp/a','recursive':False})
await tools.call({'op':'filesystem.remove','path':'/tmp/b','recursive':False})
fillers=[]
for name in ('c','d','e'):
 descriptor=os.open('/tmp/'+name,os.O_RDWR|os.O_CREAT,0o600)
 await tools.call({'op':'filesystem.remove','path':'/tmp/'+name,'recursive':False})
 os.ftruncate(descriptor,16777216)
 fillers.append(descriptor)
os.ftruncate(a,16777216)
errors=[]
for descriptor in (a,dup):
 try:
  os.ftruncate(b,1)
 except OSError as error:
  errors.append(error.errno)
 else:
  raise AssertionError('retained inode filesystem quota ignored')
 os.close(descriptor)
os.ftruncate(b,1)
assert os.fstat(b).st_size==1
os.lseek(b,0,0)
assert os.read(b,1)==b'\\x00'
os.close(b)
for descriptor in fillers:
 os.close(descriptor)
errors`,
          });
          expect(quota.output?.stderr).toBe("");
          expect(quota.output?.result).toEqual([28, 28]);
          const writeGrant = yield* native.admin.mintCapability("cache", {
            permissions: ["write", "execute"],
            expiresInSeconds: 3600,
          });
          const writeOnly = yield* makeBinding(native.service, Redacted.make(writeGrant.token));
          yield* client.action("cache", {
            op: "filesystem.writeFile",
            path: "/tmp/secret",
            content: "retained",
            encoding: "utf8",
          });
          const mutation = yield* writeOnly.action("cache", {
            op: "python.execute",
            id: "write-only",
            source: `import os
fd=os.open('/tmp/secret',os.O_WRONLY)
await tools.call({'op':'filesystem.remove','path':'/tmp/secret','recursive':False})
assert os.write(fd,b'X')==1
assert len(repr(os._boxes_descriptors))<100
assert not hasattr(os._boxes_descriptors,'images')
assert os.fstat(fd).st_size==8
try:
 os.read(fd,1)
except OSError as error:
 denied=error.errno
else:
 raise AssertionError('write-only descriptor became readable')
os.ftruncate(fd,0)
os.close(fd)
denied`,
          });
          expect(mutation.output?.stderr).toBe("");
          expect(mutation.output?.result).toBe(9);
          expect(
            (yield* client.action("cache", { op: "filesystem.exists", path: "/tmp/secret" }))
              .exists,
          ).toBe(false);
        }),
      ),
    ),
  60000,
);

test(
  "Python contexts observe the latest shared inode after unlink and Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-shared-orphan-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "shared-orphan",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* native.admin.mintCapability("shared-orphan", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("shared-orphan", {
                op: "filesystem.writeFile",
                path: "/tmp/shared",
                content: "before",
                encoding: "utf8",
              });
              for (const id of ["writer", "reader"]) {
                yield* client.action("shared-orphan", {
                  op: "contexts.create",
                  id,
                  language: "python",
                });
                const opened = yield* client.action("shared-orphan", {
                  op: "python.execute",
                  id: `open-${id}`,
                  contextId: id,
                  source: "import os\nfd=os.open('/tmp/shared',os.O_RDWR)\nTrue",
                });
                expect(opened.output?.stderr).toBe("");
                expect(opened.output?.result).toBe(true);
              }
              const changed = yield* client.action("shared-orphan", {
                op: "python.execute",
                id: "change",
                contextId: "writer",
                source: "os.write(fd,b'linked')\nTrue",
              });
              expect(changed.output?.stderr).toBe("");
              expect(changed.output?.result).toBe(true);
              yield* client.action("shared-orphan", {
                op: "filesystem.remove",
                path: "/tmp/shared",
                recursive: false,
              });
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          const observed = yield* client.action("shared-orphan", {
            op: "python.execute",
            id: "read-unlinked",
            contextId: "reader",
            source: "[os.read(fd,20).decode(),os.fstat(fd).st_nlink]",
          });
          expect(observed.output?.stderr).toBe("");
          const changed = yield* client.action("shared-orphan", {
            op: "python.execute",
            id: "write-unlinked",
            contextId: "writer",
            source: "os.lseek(fd,0,0)\nos.write(fd,b'orphan')\nTrue",
          });
          expect(changed.output?.stderr).toBe("");
          expect(changed.output?.result).toBe(true);
          const refreshed = yield* client.action("shared-orphan", {
            op: "python.execute",
            id: "read-updated-orphan",
            contextId: "reader",
            source: "os.lseek(fd,0,0)\n[os.read(fd,20).decode(),os.fstat(fd).st_nlink]",
          });
          expect(refreshed.output?.stderr).toBe("");
          expect([observed.output?.result, refreshed.output?.result]).toEqual([
            ["linked", 0],
            ["orphan", 0],
          ]);
          yield* client.action("shared-orphan", {
            op: "filesystem.writeFile",
            path: "/tmp/shared",
            content: "new",
            encoding: "utf8",
          });
          expect((yield* client.action("shared-orphan", { op: "vm.status" })).filesystemBytes).toBe(
            9,
          );
          const closed = yield* client.action("shared-orphan", {
            op: "python.execute",
            id: "close-writer",
            contextId: "writer",
            source: "os.close(fd)\nTrue",
          });
          expect(closed.output?.stderr).toBe("");
          expect(closed.output?.result).toBe(true);
          expect((yield* client.action("shared-orphan", { op: "vm.status" })).filesystemBytes).toBe(
            9,
          );
          yield* client.action("shared-orphan", { op: "contexts.reset", id: "reader" });
          expect((yield* client.action("shared-orphan", { op: "vm.status" })).filesystemBytes).toBe(
            3,
          );
          expect(
            Buffer.from(
              (yield* client.action("shared-orphan", {
                op: "filesystem.readFile",
                path: "/tmp/shared",
              })).content,
              "base64",
            ).toString(),
          ).toBe("new");
        }),
      ),
    ),
  60000,
);
