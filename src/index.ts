// Named (not `* as`) type imports: namespaces make the dts build emit an orphan `rolldown-runtime` chunk
import type {
  Comment,
  EcmaScriptModule,
  ExportExportNameKind as _ExportExportNameKind,
  ExportImportNameKind as _ExportImportNameKind,
  ExportLocalNameKind as _ExportLocalNameKind,
  ImportNameKind as _ImportNameKind,
  OxcError,
  parse as _parse,
  parseSync as _parseSync,
  ParseResult,
  Program,
} from "oxc-parser";
import type {
  HelperMode as _HelperMode,
  isolatedDeclaration as _isolatedDeclaration,
  isolatedDeclarationSync as _isolatedDeclarationSync,
  moduleRunnerTransform as _moduleRunnerTransform,
  moduleRunnerTransformSync as _moduleRunnerTransformSync,
  Severity as _Severity,
  transform as _transform,
  transformSync as _transformSync,
} from "oxc-transform";
import { instantiate, instantiateSync } from "./napi.ts";
import { canUseThreads } from "./worker_threads.ts";
import { wasm, wasmAsync } from "./_vendor/wasm.ts";

export type * from "oxc-parser";
export type * from "oxc-transform";
export type { __napiBindingTarget, Comment, ErrorLabel, OxcError } from "oxc-transform";
export { oxcVersion } from "./_vendor/wasm.ts";

type Binding = {
  transform: typeof _transform;
  transformSync: typeof _transformSync;
  isolatedDeclaration: typeof _isolatedDeclaration;
  isolatedDeclarationSync: typeof _isolatedDeclarationSync;
  moduleRunnerTransform: typeof _moduleRunnerTransform;
  moduleRunnerTransformSync: typeof _moduleRunnerTransformSync;
  parse: typeof _parse;
  parseSync: typeof _parseSync;
};

let binding: Binding | undefined;
let loading: Promise<Binding> | undefined;
let threads = false;
let poolSize = 4;

const options = () => {
  const env = globalThis.process?.env ?? {};
  threads = canUseThreads();
  poolSize = Number(env.NAPI_RS_ASYNC_WORK_POOL_SIZE ?? env.UV_THREADPOOL_SIZE) || 4;
  return { poolSize, threads };
};

function load(): Binding {
  if (!binding) {
    if (!globalThis.process?.getBuiltinModule) {
      throw new Error("[oxbox] Call `await init()` before using sync APIs in this runtime.");
    }
    binding = instantiateSync(wasm(), options());
  }
  return binding!;
}

// Web-compatible: `DecompressionStream` + async compile (browsers restrict sync compile on the main thread)
const loadAsync = (): Promise<Binding> =>
  (loading ??= binding
    ? Promise.resolve(binding)
    : wasmAsync()
        .then((bytes) => instantiate(bytes, options()))
        .then((b) => (binding ??= b)));

/**
 * Eagerly decode, decompress and instantiate the wasm binary (required before sync APIs in browsers).
 * With threads, also starts the async work pool in the background (otherwise started by the first async call).
 */
export async function init(): Promise<void> {
  const b = await loadAsync();
  // One small job per worker: spawns the pool and compiles the (lazily compiled) transform wasm code
  if (threads) {
    for (let i = 0; i < poolSize; i++) b.transform("a.tsx", "let a: A = <a />").catch(() => {});
  }
}

type AsyncAPI = "transform" | "isolatedDeclaration" | "moduleRunnerTransform" | "parse";

// Without threads (no shared memory or workers), async APIs run their sync variant
async function runAsync<K extends AsyncAPI>(
  key: K,
  args: unknown[],
): Promise<Awaited<ReturnType<Binding[K]>>> {
  const b: any = await loadAsync();
  return threads ? b[key](...args) : b[`${key}Sync`](...args);
}

export const transform: Binding["transform"] = (...args) => runAsync("transform", args);
export const transformSync: Binding["transformSync"] = (...args) => load().transformSync(...args);
export const isolatedDeclaration: Binding["isolatedDeclaration"] = (...args) =>
  runAsync("isolatedDeclaration", args);
export const isolatedDeclarationSync: Binding["isolatedDeclarationSync"] = (...args) =>
  load().isolatedDeclarationSync(...args);
export const moduleRunnerTransform: Binding["moduleRunnerTransform"] = (...args) =>
  runAsync("moduleRunnerTransform", args);
export const moduleRunnerTransformSync: Binding["moduleRunnerTransformSync"] = (...args) =>
  load().moduleRunnerTransformSync(...args);

export const parseSync: Binding["parseSync"] = (...args) => wrap(load().parseSync(...args));
export const parse: Binding["parse"] = async (...args) => wrap(await runAsync("parse", args));

// The binding returns `program` as JSON plus paths to `BigInt` / `RegExp` literals whose `value` can't be encoded in JSON
function wrap(result: ParseResult): ParseResult {
  let program: Program | undefined;
  let module: EcmaScriptModule | undefined;
  let comments: Comment[] | undefined;
  let errors: OxcError[] | undefined;
  return {
    get program() {
      if (!program) {
        const { node, fixes } = JSON.parse(result.program as unknown as string);
        for (const path of fixes as (string | number)[][]) {
          const lit = path.reduce((n, key) => n[key], node);
          if (lit.bigint) lit.value = BigInt(lit.bigint);
          else {
            try {
              lit.value = new RegExp(lit.regex.pattern, lit.regex.flags);
            } catch {
              // Syntax unsupported by this runtime: keep `value: null` (same as oxc-parser)
            }
          }
        }
        program = node;
      }
      return program!;
    },
    get module() {
      return (module ??= result.module);
    },
    get comments() {
      return (comments ??= result.comments);
    },
    get errors() {
      return (errors ??= result.errors);
    },
  };
}

// Static copies of the binding's enums (read-only, non-enumerable) so importing does not load the wasm
type EnumOf<E extends string> = { readonly [K in `${E}`]: Extract<E, K> };
const enumOf = <E extends string>(keys: `${E}`[]) =>
  Object.defineProperties(
    {},
    Object.fromEntries(keys.map((key) => [key, { value: key }])),
  ) as EnumOf<E>;

export const Severity = enumOf<_Severity>(["Error", "Warning", "Advice"]);
export type Severity = _Severity;

export const HelperMode = enumOf<_HelperMode>(["Runtime", "External"]);
export type HelperMode = _HelperMode;

export const ExportExportNameKind = enumOf<_ExportExportNameKind>(["Name", "Default", "None"]);
export type ExportExportNameKind = _ExportExportNameKind;

export const ExportImportNameKind = enumOf<_ExportImportNameKind>([
  "Name",
  "All",
  "AllButDefault",
  "None",
]);
export type ExportImportNameKind = _ExportImportNameKind;

export const ExportLocalNameKind = enumOf<_ExportLocalNameKind>(["Name", "Default", "None"]);
export type ExportLocalNameKind = _ExportLocalNameKind;

export const ImportNameKind = enumOf<_ImportNameKind>(["Name", "NamespaceObject", "Default"]);
export type ImportNameKind = _ImportNameKind;
