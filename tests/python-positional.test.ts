import { expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { positionalSeed, positionalResume } from "./fixtures/python-positional-inputs";

test("CPython Linux positional I/O reference preserves aliases and append semantics", async () => {
  const process = Bun.spawn(
    [
      "python3",
      "-c",
      `import tempfile,os\nwith tempfile.TemporaryDirectory() as root:\n os.chdir(root)\n exec(${JSON.stringify(`${positionalSeed}\n${positionalResume}\nos.close(alias)\nos.close(fd)`)})`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(process.stderr).text();
  expect(await process.exited).toBe(0);
  expect(error).toBe("");
});

test(
  "native Python positional I/O retains offsets, unlinked inodes and current grants across replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-positional-"))),
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
                id: "position",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const full = yield* admin.mintCapability("position", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const reader = yield* admin.mintCapability("position", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const writer = yield* admin.mintCapability("position", {
                permissions: ["write", "execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(service, Redacted.make(full.token));
              yield* client.action("position", {
                op: "contexts.create",
                id: "fds",
                language: "python",
              });
              const run = yield* client.action("position", {
                op: "python.execute",
                id: "seed",
                contextId: "fds",
                source: positionalSeed,
              });
              expect(run.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              return { full, reader, writer };
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
              const deniedWrite = yield* reader.action("position", {
                op: "python.execute",
                id: "readonly",
                contextId: "fds",
                source: `assert os.pread(fd,4,0)==b'abcd'
try:
 os.pwrite(fd,b'forbidden',0)
except PermissionError as error:
 assert error.errno==errno.EACCES
else:
 raise AssertionError('retained descriptor escaped write grant')
assert os.lseek(alias,0,os.SEEK_CUR)==3
42`,
              });
              expect(deniedWrite.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              const writer = yield* makeBinding(service, Redacted.make(grants.writer.token));
              const deniedResume = yield* writer
                .action("position", {
                  op: "python.execute",
                  id: "writeonly-retained",
                  contextId: "fds",
                  source: "42",
                })
                .pipe(Effect.result);
              expect(deniedResume).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "BoxesError", status: 403, error: "FORBIDDEN" },
              });
              const writeOnly = yield* writer.action("position", {
                op: "python.execute",
                id: "writeonly",
                source: `import os,errno
out=os.open('/position',os.O_WRONLY)
os.lseek(out,4,os.SEEK_SET)
assert os.pwrite(out,b'r',0)==1
assert os.lseek(out,0,os.SEEK_CUR)==4
try:
 os.pread(out,1,0)
except OSError as error:
 assert error.errno==errno.EBADF
else:
 raise AssertionError('write-only descriptor became readable')
os.close(out)
42`,
              });
              expect(writeOnly.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              const client = yield* makeBinding(service, Redacted.make(grants.full.token));
              const resumed = yield* client.action("position", {
                op: "python.execute",
                id: "resume",
                contextId: "fds",
                source: positionalResume,
              });
              expect(resumed.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              const boundary = yield* client.action("position", {
                op: "python.execute",
                id: "boundary",
                contextId: "fds",
                source: `before=os.lseek(fd,0,os.SEEK_CUR)
data=b'Z'*300000
assert os.pwrite(fd,data,0)==262144
assert os.pread(fd,300000,0)==data[:262144]
assert os.lseek(alias,0,os.SEEK_CUR)==before
for operation in [lambda:os.pread(fd,1,9007199254740992),lambda:os.pwrite(fd,b'!',9007199254740992)]:
 try:
  operation()
 except OSError as error:
  assert error.errno==errno.EINVAL
 else:
  raise AssertionError('out-of-range offset accepted')
try:
 os.pwrite(fd,b'!',16777216)
except OSError as error:
 assert error.errno==errno.EFBIG
else:
 raise AssertionError('file size limit escaped')
assert os.lseek(alias,0,os.SEEK_CUR)==before
os.close(alias)
os.close(fd)
42`,
              });
              expect(boundary.output).toMatchObject({ exitCode: 0, result: 42, stderr: "" });
              expect(
                yield* client.action("position", { op: "filesystem.readFile", path: "/position" }),
              ).toMatchObject({ content: Buffer.from("replacement").toString("base64") });
              yield* client.action("position", { op: "contexts.delete", id: "fds" });
              yield* client.action("position", { op: "vm.dispose" });
              const reclaimed = yield* client
                .action("position", { op: "vm.reclaim", limit: 1000 })
                .pipe(
                  Effect.repeat({ until: (progress) => progress.status === "complete", times: 20 }),
                );
              expect(reclaimed.status).toBe("complete");
            }),
          );
        }),
      ),
    ),
  60000,
);
