// Usage: pnpm bench [filter] (filter matches group names, e.g. `parseSync` or `checker`)
// Unfiltered runs write `results.json` and render it with `report.ts` (`pnpm bench:report`)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as oxcWasmParser from "@oxc-parser/binding-wasm32-wasi";
import * as oxcWasm from "@oxc-transform/binding-wasm32-wasi";
import { bench, do_not_optimize, group, run, summary } from "mitata";
import * as oxcParser from "oxc-parser";
// @ts-expect-error untyped: lazy `program` JSON deserialization used by `oxc-parser` (and its wasm entry)
import { wrap } from "oxc-parser/src-js/wrap.js";
import * as oxc from "oxc-transform";
import * as oxbox from "../src/index.ts";
import type { Group, Results } from "./report.ts";

type ParseResult = oxcParser.ParseResult;
type Options = { lang: "jsx" | "tsx" | "ts" };
type Impl = {
  transformSync: (file: string, code: string, opts: Options) => unknown;
  transform: (file: string, code: string, opts: Options) => Promise<unknown>;
  parseSync: (file: string, code: string, opts: Options) => ParseResult;
  parse: (file: string, code: string, opts: Options) => Promise<ParseResult>;
};

// Untyped `oxc-parser` option (spread to skip excess property checks)
const rawTransfer = { experimentalRawTransfer: true };

const impls: Record<string, Partial<Impl>> = {
  oxbox,
  "oxc (wasm)": {
    transformSync: oxcWasm.transformSync,
    transform: oxcWasm.transform,
    parseSync: (...args) => wrap(oxcWasmParser.parseSync(...args)),
    parse: async (...args) => wrap(await oxcWasmParser.parse(...args)),
  },
  "oxc (napi)": { ...oxc, ...oxcParser },
  // Parser only: AST written into a JS-owned buffer instead of JSON (64-bit native builds only)
  "oxc (napi, experimental raw transfer)": {
    parseSync: (file, code, opts) => oxcParser.parseSync(file, code, { ...opts, ...rawTransfer }),
    parse: (file, code, opts) => oxcParser.parse(file, code, { ...opts, ...rawTransfer }),
  },
};

// Pinned inputs of oxc's own benchmarks (`tasks/common/src/test_file.rs`), all free of diagnostics
// (`cal.com.tsx` is not: its codeframes for ~3k redeclaration errors dominate `transform`)
const benchmarkFiles =
  "https://raw.githubusercontent.com/oxc-project/benchmark-files/8710a334e129d4a1ab3bc054092c922db4b852a9/";
const fixtureURLs = [
  `${benchmarkFiles}RadixUIAdoptionSection.jsx`,
  `${benchmarkFiles}kitchen-sink.tsx`,
  "https://cdn.jsdelivr.net/gh/microsoft/TypeScript@v5.3.3/src/compiler/checker.ts",
];
const fixturesDir = new URL(".fixtures/", import.meta.url);
const fixtures = await Promise.all(
  fixtureURLs.map(async (url) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const file = new URL(name, fixturesDir);
    if (!existsSync(file)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(file, await res.text());
    }
    return { name, code: readFileSync(file, "utf8") };
  }),
);

const filter = process.argv[2];
const size = (code: string) => `${(code.length / 1024).toFixed(1)} KB`;
// Parse results are lazy: read `program` to include AST deserialization
const consume = (r: ParseResult) => do_not_optimize(r.program);

// Cold start (fresh process): import + wasm load + first `transformSync`
const startup: Results["startup"] = [];
if (!filter || "startup".includes(filter)) {
  const modules: Record<string, string> = {
    oxbox: import.meta.resolve("../src/index.ts"),
    "oxc (wasm)": import.meta.resolve("@oxc-transform/binding-wasm32-wasi"),
    "oxc (napi)": import.meta.resolve("oxc-transform"),
  };
  console.log("startup (import + first transformSync, median of 5 fresh processes)");
  for (const [name, url] of Object.entries(modules)) {
    const script = `const t = performance.now(); const m = await import(${JSON.stringify(url)}); m.transformSync("a.ts", "let a: number = 1"); console.log(performance.now() - t); process.exit()`;
    const times = Array.from({ length: 5 }, () =>
      Number(
        execFileSync(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
          { encoding: "utf8" },
        ),
      ),
    ).sort((a, b) => a - b);
    startup.push({ name, avg: Math.round(times[2]! * 1e6) });
    console.log(`  ${name.padEnd(12)} ${times[2]!.toFixed(1)} ms`);
  }
  console.log();
}

const cases = (file: string, code: string): [keyof Impl, (impl: Partial<Impl>) => unknown][] => {
  const lang = file.slice(file.lastIndexOf(".") + 1) as Options["lang"];
  return [
    ["transformSync", (impl) => do_not_optimize(impl.transformSync!(file, code, { lang }))],
    ["transform", async (impl) => do_not_optimize(await impl.transform!(file, code, { lang }))],
    ["parseSync", (impl) => consume(impl.parseSync!(file, code, { lang }))],
    ["parse", async (impl) => consume(await impl.parse!(file, code, { lang }))],
  ];
};
const implsOf = (op: keyof Impl) => Object.entries(impls).filter(([, impl]) => impl[op]);

const pending: (Omit<Group, "results"> & { n: number })[] = [];
for (const { name: file, code } of fixtures) {
  for (const [op, fn] of cases(file, code)) {
    const title = `${op} · ${file} (${size(code)})`;
    if (filter && !title.includes(filter)) continue;
    pending.push({ op, file, size: size(code), n: implsOf(op).length });
    // Large inputs: gc (`--expose-gc`) before each iteration to keep collections of previous ASTs
    // out of samples; small ones are batched and a full gc per iteration would skew them instead
    const gc = code.length > 100_000 ? "inner" : "once";
    group(title, () => {
      summary(() => {
        for (const [name, impl] of implsOf(op)) {
          bench(name, () => fn(impl)).gc(gc);
        }
      });
    });
  }
}

const groups: Group[] = [];
if (pending.length) {
  // mitata only discards one call per bench for slow (large file) cases: warm up wasm/JIT and
  // every worker of the async pools (concurrent batches, 2x the default pool size of 4) upfront
  const small = fixtures[0]!;
  for (const [op, fn] of cases(small.name, small.code)) {
    for (const [, impl] of implsOf(op)) {
      for (let i = 0; i < 4; i++) await Promise.all(Array.from({ length: 8 }, () => fn(impl)));
    }
  }
  const { benchmarks } = await run();
  // Benchmarks are returned in registration order: one per implementation per group
  let offset = 0;
  for (const { n, ...g } of pending) {
    const results = benchmarks.slice(offset, (offset += n)).map(({ alias: name, runs: [r] }) => {
      if (!r?.stats) throw r?.error ?? new Error(`${g.op} · ${g.file}: ${name} failed`);
      return { name, avg: Math.round(r.stats.avg) };
    });
    groups.push({ ...g, results });
  }
}

if (!filter) {
  const results: Results = {
    env: {
      date: new Date().toISOString().slice(0, 10),
      oxc: oxbox.oxcVersion,
      node: process.versions.node,
      os: `${os.type()} ${os.release()} (${process.arch})`,
      cpu: `${os.cpus()[0]?.model.trim()} (${os.availableParallelism()} threads)`,
      memory: `${Math.round(os.totalmem() / 2 ** 30)} GB`,
    },
    startup,
    groups,
  };
  writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
  await import("./report.ts");
}

// Worker threads of the async wasm APIs keep the event loop alive
process.exit();
