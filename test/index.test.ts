import * as nativeParser from "oxc-parser";
import * as native from "oxc-transform";
import oxcPkg from "oxc-transform/package.json" with { type: "json" };
import { describe, expect, it, vi } from "vitest";
import * as oxbox from "../src/index.ts";
import { wasm, wasmAsync } from "../src/_vendor/wasm.ts";

const parserCode = `#!/usr/bin/env node
  // comment
  import def, { a as b } from "./a";
  export * from "./b";
  export default /* block */ 123n + /x/gu.test(import.meta.url);
  const c: number = await import("./c");
`;

const code = `
  import type { A } from "./a";
  enum E { X = 1 }
  export const fn = (a: A): E => E.X;
  export class Foo { constructor(private readonly bar: string) {} }
`;

describe("oxbox", () => {
  it("transformSync", () => {
    expect(oxbox.transformSync("test.ts", code)).toEqual(native.transformSync("test.ts", code));
  });

  it("transform", async () => {
    expect(await oxbox.transform("test.ts", code)).toEqual(await native.transform("test.ts", code));
  });

  it("isolatedDeclarationSync", () => {
    expect(oxbox.isolatedDeclarationSync("test.ts", code)).toEqual(
      native.isolatedDeclarationSync("test.ts", code),
    );
  });

  it("moduleRunnerTransformSync", () => {
    expect(oxbox.moduleRunnerTransformSync("test.ts", code)).toEqual(
      native.moduleRunnerTransformSync("test.ts", code),
    );
  });

  it("reports errors", () => {
    const result = oxbox.transformSync("test.ts", "const = 1");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors).toEqual(native.transformSync("test.ts", "const = 1").errors);
  });

  it("works without Buffer", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(oxbox.transformSync("test.ts", code).code).toBe(
        native.transformSync("test.ts", code).code,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parseSync", () => {
    for (const [file, opts] of [
      ["test.ts", undefined],
      ["test.js", undefined],
      ["test.ts", { range: true, astType: "js", showSemanticErrors: true }],
    ] as const) {
      const actual = oxbox.parseSync(file, parserCode, opts);
      const expected = nativeParser.parseSync(file, parserCode, opts);
      expect(actual.program).toEqual(expected.program);
      expect(actual.module).toEqual(expected.module);
      expect(actual.comments).toEqual(expected.comments);
      expect(actual.errors).toEqual(expected.errors);
    }
  });

  it("parse", async () => {
    const actual = await oxbox.parse("test.ts", parserCode);
    const expected = await nativeParser.parse("test.ts", parserCode);
    expect(actual.program).toEqual(expected.program);
    expect(actual.module).toEqual(expected.module);
  });

  it("parse reports errors", () => {
    expect(oxbox.parseSync("test.ts", "const = 1").errors).toEqual(
      nativeParser.parseSync("test.ts", "const = 1").errors,
    );
  });

  it("enums match native binding", () => {
    for (const name of ["Severity", "HelperMode"] as const) {
      expect(Object.getOwnPropertyDescriptors(oxbox[name])).toEqual(
        Object.getOwnPropertyDescriptors(native[name]),
      );
    }
    for (const name of [
      "ExportExportNameKind",
      "ExportImportNameKind",
      "ExportLocalNameKind",
      "ImportNameKind",
    ] as const) {
      expect(Object.getOwnPropertyDescriptors(oxbox[name])).toEqual(
        Object.getOwnPropertyDescriptors(nativeParser[name]),
      );
    }
  });

  it("wasmAsync (DecompressionStream) matches wasm (node:zlib)", async () => {
    expect(Buffer.compare(await wasmAsync(), wasm())).toBe(0);
  });

  it("init() loads asynchronously for sync APIs (web path)", async () => {
    vi.resetModules();
    const fresh: typeof oxbox = await import("../src/index.ts");
    vi.stubGlobal("process", { ...process, getBuiltinModule: undefined });
    try {
      expect(() => fresh.transformSync("test.ts", code)).toThrow("await init()");
      await fresh.init();
      expect(fresh.transformSync("test.ts", code)).toEqual(native.transformSync("test.ts", code));
      // Runs on the pool prewarmed by `init()`
      expect(await fresh.transform("test.ts", code)).toEqual(
        await native.transform("test.ts", code),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs without threads when SharedArrayBuffer is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("SharedArrayBuffer", undefined);
    try {
      const fresh: typeof oxbox = await import("../src/index.ts");
      expect(fresh.transformSync("test.ts", code)).toEqual(native.transformSync("test.ts", code));
      expect(await fresh.transform("test.ts", code)).toEqual(
        await native.transform("test.ts", code),
      );
      expect((await fresh.parse("test.ts", parserCode)).program).toEqual(
        (await nativeParser.parse("test.ts", parserCode)).program,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("oxcVersion", () => {
    expect(oxbox.oxcVersion).toBe(oxcPkg.version);
  });
});
