# oxbox 🐂

<!-- [![npm version](https://img.shields.io/npm/v/oxbox?color=yellow)](https://npmjs.com/package/oxbox) -->
<!-- [![npm downloads](https://img.shields.io/npm/dm/oxbox?color=yellow)](https://npm.chart.dev/oxbox) -->

A tiny, portable JS library for parsing and transforming JS/TS/JSX, powered by [oxc](https://oxc.rs).

- ⚡ Optimized wasm build in a single JS chunk, zero dependencies
- 🪞 Same API as [oxc-parser](https://www.npmjs.com/package/oxc-parser) + [oxc-transform](https://www.npmjs.com/package/oxc-transform)
- 🤝 Works in browsers and Node.js
- 💾 Fits on a floppy disk

👉 Try it in the [online playground](https://oxbox.unjs.io/).

## Usage

```js
import { parseSync, transformSync } from "oxbox";

const { code } = transformSync("input.ts", "const a: number = 1");
const { program } = parseSync("input.ts", "const a: number = 1");
```

All `oxc-parser` and `oxc-transform` exports are available (`parse`, `parseSync`, `transform`, `transformSync`, `isolatedDeclaration`, `moduleRunnerTransform`, ...), so oxbox can be used as a drop-in replacement.

The wasm is decoded, decompressed and instantiated lazily on first call. Use `await init()` to warm it up ahead of time (**required before calling sync APIs in browsers**).

Async APIs run on a prewarmed worker pool when `SharedArrayBuffer` is available (in browsers, the page must be [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)); otherwise oxbox runs single-threaded and async APIs run on the calling thread.

## How it works

The official oxc packages ship the parser and transformer as separate binaries, and since the transformer includes its own parser, much of it is duplicated. They also pull in dozens of platform bindings and a JS runtime ([emnapi](https://github.com/toyobayashi/emnapi) + [napi-rs](https://napi.rs)).

oxbox instead:

- 🔗 Links parser and transformer into **one wasm binary**, optimized together (LTO)
- ⚡ Enables **SIMD** (`simd128`) across the whole build, not just in a few hand-written spots
- 🗜️ Embeds the wasm in the JS bundle, compressed with [zopfli](https://github.com/google/zopfli) (deflate-raw) and base93-encoded
- 🪶 Replaces platform bindings and the emnapi / napi-rs runtime with its own tiny N-API + WASI host that runs in Node.js and browsers
- 🧵 Runs async APIs on a **multithreaded**, prewarmed worker pool

## Benchmarks

Compared with the official [oxc-transform](https://www.npmjs.com/package/oxc-transform) / [oxc-parser](https://www.npmjs.com/package/oxc-parser) wasm and native (napi) bindings.

### Install size

![Install size: oxbox vs oxc (wasm) vs oxc (napi)](./bench/size.svg)

oxbox ships transform and parser as a single wasm; oxc ships them as two packages (and the wasm bindings share the emnapi / napi-rs runtime).

### Performance

![Benchmarks: oxbox vs oxc (wasm) vs oxc (napi)](./bench/results.svg)

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run the browser playground using `pnpm dev`
- Run tests using `pnpm vitest`
- Run benchmarks against `oxc-transform` / `oxc-parser` (napi and wasm) using `pnpm bench [filter]` (unfiltered runs save `bench/results.json`; `pnpm bench:report` re-renders `bench/results.svg` from it) and install sizes using `pnpm bench:size` (renders `bench/size.svg`)
- Rebuild the wasm from oxc sources (committed as `src/_vendor/wasm.ts`) using `pnpm vendor` (requires Rust and `rustup target add wasm32-wasip1-threads`)

</details>

## License

Published under the [MIT](./LICENSE) license 💛.

Bundles [oxc](https://github.com/oxc-project/oxc) (MIT, VoidZero Inc. & Contributors). The N-API / WASI host (`src/napi.ts`) is derived from [emnapi](https://github.com/toyobayashi/emnapi) (MIT, Toyobayashi) and the [napi-rs](https://github.com/napi-rs/napi-rs) wasm runtime (MIT, LongYinan). See [LICENSE](./LICENSE) for full license texts.
