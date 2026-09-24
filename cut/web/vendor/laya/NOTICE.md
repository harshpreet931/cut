# Vendored laya-ts

These files are the browser runtime from [laya-ts](https://github.com/NandhaKishorM/laya/tree/main/laya-ts)
(Apache-2.0, see `LICENSE`), at commit `23a1752` (2026-09-24). laya-ts is not published to npm, so it's
vendored here as plain JavaScript and the site needs no build step.

Changes from upstream:

- Converted from TypeScript to JavaScript by stripping types with Node's `module.stripTypeScriptTypes`.
- Only the modules the browser path uses are kept: `agent`, `common`, `hooks`, `providers`, `tokenizer`.
- `providers.js`: `fetchArrayBuffer` is cache-first (upstream always went to the network), downloads
  large files as parallel HTTP Range chunks with retries (a single 500 MB stream from the Hugging Face
  CDN can drop partway), and reports progress through a new `setFetchProgress` export.
- `providers.js`: in the browser the head runs on WebGPU as well (upstream: WASM only), and the encoder's
  output tensor is handed to the head directly instead of being converted to nested arrays and back
  (`feedHead` accepts a tensor). About 3x faster per post.
- `providers.js`: the ONNX Runtime Web module can be overridden with `globalThis.LAYA_ORT_URL` (used by the
  Chrome extension, which bundles its own copy).
