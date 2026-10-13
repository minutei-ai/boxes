declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "cirro:wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "cirro:guest" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "cirro:compiler" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "cirro:wasi" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "cirro:python" {
  const module: WebAssembly.Module;
  export default module;
}
