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
              const modes = yield* client.action("descriptors", {
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
              expect(modes.output?.result).toEqual([95, 95, 13]);
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
              const opened = yield* client.action("reading", {
                op: "python.execute",
                id: "open",
                contextId: "stream",
                source: `import io,os
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
          const resumed = yield* client.action("reading", {
            op: "python.execute",
            id: "resume",
            contextId: "stream",
            source: `assert stream.readline()=='segunda\\n'
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
          expect(resumed.output?.result).toEqual([[95, 95, 95, 95], true]);
          expect(
            (yield* client.action("reading", { op: "filesystem.exists", path: "/tmp/uncreated" }))
              .exists,
          ).toBe(false);
        }),
      ),
    ),
  60_000,
);
