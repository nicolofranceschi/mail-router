// `import x from "<pkg>/wasm" with { type: "file" }` yields the file path (embedded in compiled builds).
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const path: string;
  export default path;
}
