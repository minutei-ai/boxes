import { expect, test } from "bun:test";
import { Effect, Redacted, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { RunRecord } from "../src/contracts";
test(
  "native pathlib maximum-file copy reuses immutable chunks with bounded R2 publications",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-pathlib-probe-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const service = yield* Effect.promise(() => worker.service);
          const admin = yield* makeBinding(service, Redacted.make("cirro-local-test-credential"));
          yield* admin.create({
            id: "pathlib",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 16777216,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("pathlib", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const client = yield* makeBinding(service, Redacted.make(grant.token));
          for (const offset of Array.from({ length: 16 }, (_, index) => index * 1048576)) {
            const content = Buffer.from(
              Uint8Array.from({ length: 1048576 }, (_, index) => (offset + index) % 251),
            ).toString("base64");
            yield* client.action("pathlib", {
              op: "filesystem.writeFile",
              path: "/tmp/source",
              content,
              encoding: "base64",
              offset,
            });
          }
          const source = yield* client.action("pathlib", {
            op: "filesystem.stat",
            path: "/tmp/source",
            follow: true,
          });
          const control = yield* Effect.promise(() => worker.control);
          const usage = yield* Effect.promise(() =>
            control.pythonFilesystemUsage("pathlib", grant.token, {
              op: "python.execute",
              id: "copy-boundary",
              source:
                "from pathlib import Path\ncopied=Path('/tmp/source').copy('/tmp/copied')\nassert copied.stat().st_size==16777216\n42",
            }),
          );
          if (usage.status !== 200) return yield* Effect.die({ status: usage.status });
          const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(
            usage.body,
          );
          const overlap = yield* client.action("pathlib", {
            op: "python.execute",
            id: "large-overlap",
            source: `import os,errno
fd=os.open('/tmp/copied',os.O_RDWR)
try:
 try:
  os.copy_file_range(fd,fd,16777216,offset_src=0,offset_dst=8388608)
 except OSError as error:
  assert error.errno==errno.EINVAL
 else:
  raise AssertionError('requested ranges overlap beyond the short transfer')
finally:
 os.close(fd)
42`,
          });
          expect(overlap.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
          const copied = yield* client
            .action("pathlib", { op: "filesystem.stat", path: "/tmp/copied", follow: true })
            .pipe(Effect.result);
          const actual = new Bun.CryptoHasher("sha256");
          const expected = new Bun.CryptoHasher("sha256");

          for (const offset of Array.from({ length: 16 }, (_, index) => index * 1048576)) {
            const part = yield* client.action("pathlib", {
              op: "filesystem.readFile",
              path: "/tmp/copied",
              offset,
              length: 1048576,
            });
            const bytes = Buffer.from(part.content, "base64");
            if (bytes.byteLength !== 1048576) return yield* Effect.die("Incomplete copy readback");
            actual.update(bytes);
            expected.update(
              Uint8Array.from({ length: 1048576 }, (_, index) => (offset + index) % 251),
            );
          }
          const actualSha256 = actual.digest("hex");
          const expectedSha256 = expected.digest("hex");
          if (actualSha256 !== expectedSha256) return yield* Effect.die("Copy content mismatch");
          return {
            source,
            run,
            copied,
            actualSha256,
            expectedSha256,
            verifiedBytes: 16777216,
            usage,
          };
        }),
      ),
    ).then((report) => {
      expect(report.run.output).toMatchObject({ exitCode: 0, result: 42 });
      expect(report.verifiedBytes).toBe(16777216);
      expect(report.actualSha256).toBe(report.expectedSha256);
      expect(report.usage.counts.headPuts).toBeLessThanOrEqual(8);
    }),
  30000,
);

test(
  "copy_file_range preserves descriptor offsets, holes, ownership and current grants across closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-copy-ranges-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grants = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory, { controlled: false })),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const service = yield* Effect.promise(() => worker.service);
              const admin = yield* makeBinding(
                service,
                Redacted.make("cirro-local-test-credential"),
              );
              yield* admin.create({
                id: "ranges",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const full = yield* admin.mintCapability("ranges", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const reader = yield* admin.mintCapability("ranges", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(service, Redacted.make(full.token));
              yield* client.action("ranges", {
                op: "filesystem.writeFile",
                path: "/tmp/source",
                content: Buffer.from(
                  Uint8Array.from({ length: 524308 }, (_, index) => index % 251),
                ).toString("base64"),
                encoding: "base64",
              });
              yield* client.action("ranges", {
                op: "contexts.create",
                id: "fds",
                language: "python",
              });
              const run = yield* client.action("ranges", {
                op: "python.execute",
                id: "ranges",
                contextId: "fds",
                source: `import os,errno
src=os.open('/tmp/source',os.O_RDONLY)
dst=os.open('/tmp/destination',os.O_CREAT|os.O_RDWR)
assert os.copy_file_range(src,dst,10)==10
assert os.lseek(src,0,os.SEEK_CUR)==10 and os.lseek(dst,0,os.SEEK_CUR)==10
assert os.copy_file_range(src,dst,12,offset_src=100,offset_dst=4)==12
assert os.lseek(src,0,os.SEEK_CUR)==10 and os.lseek(dst,0,os.SEEK_CUR)==10
os.lseek(dst,0,0)
assert os.read(dst,20)==bytes(range(4))+bytes(range(100,112))
assert os.copy_file_range(src,dst,12,offset_src=262140,offset_dst=262142)==12
os.lseek(dst,262136,0)
assert os.read(dst,20)==b'\\x00'*6+bytes((262140+i)%251 for i in range(12))
os.ftruncate(dst,0)
assert os.copy_file_range(src,dst,262144,offset_src=0,offset_dst=0)==262144
assert os.fstat(dst).st_size==262144
try:
 os.copy_file_range(dst,dst,8,offset_src=0,offset_dst=2)
except OSError as error:
 assert error.errno==errno.EINVAL
else:
 raise AssertionError('overlapping aliases were accepted')
assert os.copy_file_range(dst,dst,4,offset_src=0,offset_dst=8)==4
os.lseek(dst,0,0)
assert os.read(dst,16)==bytes(range(8))+bytes(range(4))+bytes(range(12,16))
assert os.copy_file_range(src,dst,0)==0
assert os.copy_file_range(src,dst,99,offset_src=524308,offset_dst=0)==0
try:
 os.copy_file_range(src,dst,10,offset_src=0,offset_dst=16777214)
except OSError as error:
 assert error.errno==errno.EFBIG
else:
 raise AssertionError('destination limit was ignored')
assert os.fstat(dst).st_size==262144
append=os.open('/tmp/destination',os.O_APPEND|os.O_WRONLY)
for action in [lambda:os.copy_file_range(src,append,1),lambda:os.copy_file_range(src,src,1),lambda:os.copy_file_range(-1,dst,1)]:
 try:
  action()
 except OSError as error:
  assert error.errno==errno.EBADF
 else:
  raise AssertionError('invalid descriptor rights were accepted')
os.close(append)
for action in [lambda:os.copy_file_range(src,dst,-1),lambda:os.copy_file_range(src,dst,1,offset_src=-1),lambda:os.copy_file_range(src,dst,1,offset_dst=-1)]:
 try:
  action()
 except ValueError:
  pass
 else:
  raise AssertionError('negative copy range was accepted')
assert os.copy_file_range(src,dst,1000,offset_src=524300,offset_dst=100)==8
os.lseek(dst,100,0)
assert os.read(dst,8)==bytes((524300+i)%251 for i in range(8))
os.unlink('/tmp/source')
os.unlink('/tmp/destination')
42`,
              });
              expect(run.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              for (const path of ["/tmp/source", "/tmp/destination"])
                yield* client.action("ranges", {
                  op: "filesystem.writeFile",
                  path,
                  content: "replacement",
                  encoding: "utf8",
                });
              return { full, reader };
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory, { controlled: false })),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const service = yield* Effect.promise(() => worker.service);
              const reader = yield* makeBinding(service, Redacted.make(grants.reader.token));
              const denied = yield* reader.action("ranges", {
                op: "python.execute",
                id: "readonly",
                contextId: "fds",
                source: `before=os.lseek(src,0,os.SEEK_CUR)
try:
 os.copy_file_range(src,dst,3)
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('old descriptors escaped current authority')
assert os.lseek(src,0,os.SEEK_CUR)==before
42`,
              });
              expect(denied.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              const client = yield* makeBinding(service, Redacted.make(grants.full.token));
              const resumed = yield* client.action("ranges", {
                op: "python.execute",
                id: "unlinked",
                contextId: "fds",
                source: `assert os.fstat(src).st_nlink==0 and os.fstat(dst).st_nlink==0
assert os.copy_file_range(src,dst,3,offset_src=7,offset_dst=1)==3
os.lseek(dst,0,0)
assert os.read(dst,4)==bytes([0,7,8,9])
os.close(src)
os.close(dst)
42`,
              });
              expect(resumed.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              for (const path of ["/tmp/source", "/tmp/destination"])
                expect(
                  yield* client.action("ranges", { op: "filesystem.readFile", path }),
                ).toMatchObject({ content: Buffer.from("replacement").toString("base64") });
              yield* client.action("ranges", { op: "contexts.delete", id: "fds" });
            }),
          );
        }),
      ),
    ),
  60000,
);
