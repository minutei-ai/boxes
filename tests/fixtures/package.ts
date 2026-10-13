import type { WasmConfiguration } from "../../src/contracts";

const uint = (value: bigint): Buffer => {
  if (value < 128n) return Buffer.from([Number(value)]);
  return Buffer.concat([Buffer.from([Number(value & 127n) | 128]), uint(value >> 7n)]);
};
const text = (value: string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint(BigInt(bytes.length)), bytes]);
};
const wide = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const integer = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const header = (name: string, size: number, kind: string) => {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100, "utf8");
  bytes.write("0000755\0", 100, 8, "ascii");
  bytes.write("0001750\0", 108, 8, "ascii");
  bytes.write("0001751\0", 116, 8, "ascii");
  bytes.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  bytes.write("00000000173\0", 136, 12, "ascii");
  bytes.fill(32, 148, 156);
  bytes.write(kind, 156, 1, "ascii");
  bytes.write("ustar\0", 257, 6, "ascii");
  bytes.write("00", 263, 2, "ascii");
  const sum = bytes.reduce((total: number, byte: number) => total + byte, 0);
  bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return bytes;
};

export const commandPackage = (
  binary: Uint8Array,
  name = "probe",
  version = "1.0.0",
  environment: typeof WasmConfiguration.Type.env = { CIRRO_MARKER: "package" },
  projection: string | null = null,
) => {
  const directories = Buffer.concat([
    text("/bin"),
    uint(1n),
    wide(0),
    wide(0),
    integer(0o40755),
    integer(0),
    integer(0),
    wide(0),
    Buffer.from([0]),
  ]);
  const file = Buffer.concat([
    text("/bin/probe"),
    uint(0n),
    wide(1024),
    wide(binary.byteLength),
    integer(0o100755),
    integer(1000),
    integer(1001),
    wide(123),
    Buffer.from([0]),
  ]);
  const env = Object.entries(environment);
  const mounts = (() => {
    if (projection === null) return uint(0n);
    return Buffer.concat([uint(1n), text("bin"), text(projection)]);
  })();
  const manifest = Buffer.concat([
    Buffer.from([2, 0]),
    text(name),
    text(version),
    Buffer.from([1]),
    uint(BigInt(env.length)),
    ...env.flatMap(([key, value]) => [text(key), text(value)]),
    mounts,
    uint(1n),
    text("probe"),
    text("bin/probe"),
    uint(0n),
  ]);
  const index = Buffer.concat([Buffer.from([2, 0]), uint(2n), directories, file]);
  const padding = Buffer.alloc((512 - (binary.byteLength % 512)) % 512);
  const tar = Buffer.concat([
    header("bin/", 0, "5"),
    header("bin/probe", binary.byteLength, "0"),
    binary,
    padding,
    Buffer.alloc(1024),
  ]);
  const bytes = Buffer.from([0x89, 65, 79, 83, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  bytes.writeUInt32LE(manifest.byteLength, 8);
  bytes.writeUInt32LE(index.byteLength, 12);
  return Buffer.concat([bytes, manifest, index, tar]);
};
