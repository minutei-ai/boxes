declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "cirro:wasm" {
  const module: WebAssembly.Module;
  export default module;
}
