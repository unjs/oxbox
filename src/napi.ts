/**
 * Minimal N-API + WASI preview1 + wasi-threads host for napi-rs wasm32-wasi builds.
 * Implements only the imports oxc-transform + oxc-parser use (74 env + 7 wasi + thread-spawn).
 *
 * Clean-room reimplementation. Behavior (env struct offsets, _emnapi_* hook semantics,
 * init order, memory limits) was derived by reading:
 * - emnapi, MIT, Copyright (c) 2021-present Toyobayashi — https://github.com/toyobayashi/emnapi
 * - napi-rs wasm runtime, MIT, Copyright (c) 2020-present LongYinan — https://github.com/napi-rs/napi-rs
 */
import { isMainBrowserThread, workerThreads } from "./worker_threads.ts";

type NapiFn = (...args: number[]) => number;

interface WasmExports {
  __indirect_function_table: WebAssembly.Table;
  _initialize(): void;
  emnapi_create_env(): number;
  napi_register_wasm_v1(env: number, exports: number): number;
  wasi_thread_start(tid: number, arg: number): void;
  [key: string]: unknown;
}

interface HostOptions {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /** Unset when threads are disabled (non-shared memory) */
  tidCounter?: Int32Array;
  poolSize: number;
  isMain: boolean;
}

interface AsyncSendMessage {
  __oxbox: "send";
  type: number;
  cb: number;
  data: number;
}

export interface InstantiateOptions {
  poolSize?: number;
  /** Shared memory + worker threads (async work pool); without, only sync APIs work. */
  threads?: boolean;
}

/** Lazily loads a Node.js built-in module (throws on runtimes without it). */
export const getBuiltin = ((id: string) => {
  const mod = globalThis.process?.getBuiltinModule?.(id);
  if (!mod) throw new Error(`[oxbox] \`${id}\` is not available in this runtime.`);
  return mod;
}) as NodeJS.Process["getBuiltinModule"];

const setImmediate: (fn: () => void) => unknown =
  globalThis.setImmediate ?? ((fn: () => void) => setTimeout(fn, 0));

const SELF = new URL(import.meta.url);
const td = new TextDecoder();
const te = new TextEncoder();
const NONE = Symbol("none");

function createHost({ module, memory, tidCounter, poolSize, isMain }: HostOptions) {
  // Views are refreshed only when an access falls outside them (`memory.buffer` is a slow getter):
  // growing detaches a non-shared buffer (length 0) and leaves a shared one at its old length
  let u8 = new Uint8Array(0);
  let dv = new DataView(u8.buffer);
  const at = (p: number, len: number) => {
    if (p + len > u8.length) {
      u8 = new Uint8Array(memory.buffer);
      dv = new DataView(u8.buffer);
    }
  };
  const r32 = (p: number) => (at(p, 4), dv.getUint32(p, true));
  const w32 = (p: number, v: number) => (at(p, 4), dv.setUint32(p, v, true));
  const w8 = (p: number, v: number) => (at(p, 1), (u8[p] = v));
  const decode = (p: number, len: number) => {
    at(p, len);
    // `TextDecoder` call overhead dominates for short (property name) strings
    if (len < 32) {
      let s = "";
      for (let i = p; i < p + len; i++) {
        if (u8[i]! > 127) break;
        s += String.fromCharCode(u8[i]!);
      }
      if (s.length === len) return s;
    }
    const s = u8.subarray(p, p + len);
    try {
      return td.decode(s);
    } catch {
      // TextDecoder may reject views over SharedArrayBuffer
      return td.decode(s.slice());
    }
  };
  const cstr = (p: number, len = 0xffffffff) => {
    if (!p) return "";
    if (len >>> 0 === 0xffffffff) {
      at(p, 1);
      let e = p;
      while (u8[e]) e++;
      if (e === u8.length) {
        at(e, 1);
        while (u8[e]) e++;
      }
      len = e - p;
    }
    return decode(p, len >>> 0);
  };

  // Handles (index 0 = NULL) and handle scopes
  const H: any[] = [undefined];
  const scopes: number[] = [];
  const h = (v: unknown) => H.push(v) - 1;
  const openScope = () => scopes.push(H.length);
  const closeScope = () => {
    H.length = scopes.pop()!;
  };

  let ENV = 0;
  let pending: unknown = NONE;
  const setLast = (status: number) => {
    if (ENV) {
      at(ENV + 32, 4);
      dv.setInt32(ENV + 32, status, true);
    }
    return status;
  };
  const takePending = () => {
    const e = pending;
    pending = NONE;
    return e;
  };
  const api =
    (fn: NapiFn): NapiFn =>
    (...args) => {
      try {
        return setLast(fn(...args) | 0);
      } catch (error) {
        pending = error;
        return setLast(10 /* napi_pending_exception */);
      }
    };

  let table: WebAssembly.Table;
  const fnCache = new Map<number, (...args: number[]) => number>();
  const tget = (i: number) => {
    let f = fnCache.get(i);
    if (!f) {
      f = table.get(i);
      fnCache.set(i, f!);
    }
    return f!;
  };

  const cbStack: { self: unknown; args: unknown[]; data: number }[] = [];
  function makeFunction(name: string, cb: number, data: number) {
    const native = tget(cb);
    const fn = function (this: unknown, ...args: unknown[]) {
      openScope();
      const id = cbStack.push({ self: this, args, data });
      try {
        const r = native(ENV, id);
        if (pending !== NONE) throw takePending();
        return r ? H[r] : undefined;
      } finally {
        cbStack.pop();
        closeScope();
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  }

  function defineProps(target: object, staticTarget: object | null, count: number, props: number) {
    for (let p = props; p < props + count * 32; p += 32) {
      const utf8name = r32(p);
      const method = r32(p + 8);
      const getter = r32(p + 12);
      const setter = r32(p + 16);
      const value = r32(p + 20);
      const attrs = r32(p + 24);
      const data = r32(p + 28);
      const key = utf8name ? cstr(utf8name) : H[r32(p + 4)];
      const obj = staticTarget && attrs & 1024 /* napi_static */ ? staticTarget : target;
      const d: PropertyDescriptor = { enumerable: !!(attrs & 2), configurable: !!(attrs & 4) };
      if (getter || setter) {
        if (getter) d.get = makeFunction(key, getter, data);
        if (setter) d.set = makeFunction(key, setter, data);
      } else {
        d.writable = !!(attrs & 1);
        d.value = method ? makeFunction(key, method, data) : H[value];
      }
      Object.defineProperty(obj, key, d);
    }
  }

  const refs = new Map<number, { c: number; v?: unknown; w?: WeakRef<object> }>();
  let refId = 0;
  const createRef = (val: unknown, count: number) => {
    refs.set(++refId, count || !isObj(val) ? { c: count, v: val } : { c: 0, w: new WeakRef(val) });
    return refId;
  };
  // napi_wrap: native pointer per object, finalized (freeing wasm memory) when the object is collected
  const wraps = new WeakMap<object, number>();
  const finalizers = new FinalizationRegistry<[cb: number, data: number, hint: number]>(
    ([cb, data, hint]) => {
      openScope();
      try {
        tget(cb)(ENV, data, hint);
      } finally {
        closeScope();
      }
    },
  );
  const deferreds = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let defId = 0;
  const isObj = (v: unknown): v is object =>
    (typeof v === "object" && v !== null) || typeof v === "function";

  // Keep the event loop alive while async work is pending (workers are unref'd)
  let waiting = 0;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const incWaiting = () => {
    if (waiting++ === 0) keepalive = setInterval(() => {}, 1 << 30);
  };
  const decWaiting = () => {
    if (--waiting === 0) clearInterval(keepalive);
  };

  const typeOf = (v: unknown) =>
    v === null
      ? 1
      : {
          undefined: 0,
          boolean: 2,
          number: 3,
          string: 4,
          symbol: 5,
          object: 6,
          function: 7,
          bigint: 9,
        }[typeof v];

  const napi: Record<string, NapiFn> = {
    napi_get_undefined: (_e, r) => (w32(r, h(undefined)), 0),
    napi_get_null: (_e, r) => (w32(r, h(null)), 0),
    napi_get_global: (_e, r) => (w32(r, h(globalThis)), 0),
    napi_get_boolean: (_e, v, r) => (w32(r, h(!!v)), 0),
    napi_typeof: (_e, v, r) => (w32(r, typeOf(H[v])), 0),
    napi_create_object: (_e, r) => (w32(r, h({})), 0),
    // oxlint-disable-next-line unicorn/no-new-array -- holey array, same as node's napi
    napi_create_array_with_length: (_e, n, r) => (w32(r, h(new Array(n >>> 0))), 0),
    napi_create_uint32: (_e, n, r) => (w32(r, h(n >>> 0)), 0),
    napi_create_string_utf8: (_e, p, len, r) => (w32(r, h(cstr(p, len))), 0),
    napi_get_value_string_utf8: (_e, v, p, size, r) => {
      const s = H[v];
      if (typeof s !== "string") return 3; /* napi_string_expected */
      if (!p) {
        if (r) w32(r, globalThis.Buffer?.byteLength(s) ?? te.encode(s).length);
        return 0;
      }
      size >>>= 0;
      if (!size) {
        if (r) w32(r, 0);
        return 0;
      }
      at(p, size);
      const dst = u8.subarray(p, p + size - 1);
      let written: number;
      try {
        written = te.encodeInto(s, dst).written;
      } catch {
        // Browsers reject views over SharedArrayBuffer
        const tmp = new Uint8Array(dst.length);
        written = te.encodeInto(s, tmp).written;
        dst.set(tmp.subarray(0, written));
      }
      u8[p + written] = 0;
      if (r) w32(r, written);
      return 0;
    },
    napi_get_value_bool: (_e, v, r) =>
      typeof H[v] === "boolean" ? (w8(r, +H[v]), 0) : 7 /* napi_boolean_expected */,
    napi_coerce_to_object: (_e, v, r) => (w32(r, h(Object(H[v]))), 0),
    napi_coerce_to_string: (_e, v, r) => (w32(r, h(String(H[v]))), 0),
    napi_is_array: (_e, v, r) => (w8(r, +Array.isArray(H[v])), 0),
    napi_is_error: (_e, v, r) => (w8(r, +(H[v] instanceof Error)), 0),
    napi_strict_equals: (_e, a, b, r) => (w8(r, +(H[a] === H[b])), 0),
    napi_get_array_length: (_e, v, r) =>
      Array.isArray(H[v]) ? (w32(r, H[v].length), 0) : 8 /* napi_array_expected */,
    napi_get_element: (_e, o, i, r) => (w32(r, h(H[o][i >>> 0])), 0),
    napi_set_element: (_e, o, i, v) => ((H[o][i >>> 0] = H[v]), 0),
    napi_get_property: (_e, o, k, r) => (w32(r, h(H[o][H[k]])), 0),
    napi_set_property: (_e, o, k, v) => ((H[o][H[k]] = H[v]), 0),
    napi_get_named_property: (_e, o, n, r) => (w32(r, h(H[o][cstr(n)])), 0),
    napi_set_named_property: (_e, o, n, v) => ((H[o][cstr(n)] = H[v]), 0),
    napi_has_own_property: (_e, o, k, r) => (w8(r, +Object.hasOwn(H[o], H[k])), 0),
    napi_get_prototype: (_e, o, r) => (w32(r, h(Object.getPrototypeOf(H[o]))), 0),
    napi_get_property_names: (_e, o, r) => {
      const keys: string[] = [];
      for (const k in H[o]) keys.push(k);
      w32(r, h(keys));
      return 0;
    },
    napi_define_properties: (_e, o, n, p) => (defineProps(H[o], null, n >>> 0, p), 0),
    napi_define_class: (_e, name, len, ctor, data, n, p, r) => {
      const F = makeFunction(cstr(name, len), ctor, data);
      defineProps(F.prototype, F, n >>> 0, p);
      w32(r, h(F));
      return 0;
    },
    napi_create_function: (_e, name, len, cb, data, r) => (
      w32(r, h(makeFunction(cstr(name, len), cb, data))),
      0
    ),
    napi_get_cb_info: (_e, info, argcP, argvP, thisP, dataP) => {
      const { self, args, data } = cbStack[info - 1]!;
      if (argvP) {
        const cap = r32(argcP);
        for (let i = 0; i < cap; i++) w32(argvP + i * 4, h(args[i]));
      }
      if (argcP) w32(argcP, args.length);
      if (thisP) w32(thisP, h(self));
      if (dataP) w32(dataP, data);
      return 0;
    },
    napi_call_function: (_e, recv, f, argc, argv, r) => {
      const fn = H[f];
      if (typeof fn !== "function") return 5; /* napi_function_expected */
      const args = [];
      for (let i = 0; i < argc; i++) args.push(H[r32(argv + i * 4)]);
      const res = Reflect.apply(fn, H[recv], args);
      if (r) w32(r, h(res));
      return 0;
    },
    napi_new_instance: (_e, f, argc, argv, r) => {
      const args = [];
      for (let i = 0; i < argc; i++) args.push(H[r32(argv + i * 4)]);
      w32(r, h(Reflect.construct(H[f], args)));
      return 0;
    },
    napi_create_error: (_e, code, msg, r) => {
      const err: Error & { code?: unknown } = new Error(H[msg]);
      if (code) err.code = H[code];
      w32(r, h(err));
      return 0;
    },
    napi_throw: (_e, v) => ((pending = H[v]), 0),
    napi_throw_error: (_e, code, msg) => {
      const err: Error & { code?: string } = new Error(cstr(msg));
      if (code) err.code = cstr(code);
      pending = err;
      return 0;
    },
    napi_is_exception_pending: (_e, r) => (w8(r, +(pending !== NONE)), 0),
    napi_get_and_clear_last_exception: (_e, r) => (
      w32(r, h(pending === NONE ? undefined : takePending())),
      0
    ),
    napi_open_handle_scope: (_e, r) => (w32(r, openScope()), 0),
    napi_close_handle_scope: () => (closeScope(), 0),
    napi_create_reference: (_e, v, count, r) => (w32(r, createRef(H[v], count)), 0),
    napi_wrap: (_e, o, data, cb, hint, r) => {
      const obj = H[o];
      if (!isObj(obj)) return 2; /* napi_object_expected */
      if (wraps.has(obj)) return 1; /* napi_invalid_arg */
      wraps.set(obj, data);
      if (cb) finalizers.register(obj, [cb, data, hint]);
      if (r) w32(r, createRef(obj, 0));
      return 0;
    },
    napi_unwrap: (_e, o, r) => {
      const data = wraps.get(H[o]);
      if (data === undefined) return 1; /* napi_invalid_arg */
      w32(r, data);
      return 0;
    },
    napi_reference_unref: (_e, id, r) => {
      const ref = refs.get(id);
      if (!ref || !ref.c) return 9; /* napi_generic_failure */
      if (--ref.c === 0 && isObj(ref.v)) {
        ref.w = new WeakRef(ref.v);
        ref.v = undefined;
      }
      if (r) w32(r, ref.c);
      return 0;
    },
    napi_delete_reference: (_e, id) => (refs.delete(id), 0),
    napi_get_reference_value: (_e, id, r) => {
      const ref = refs.get(id)!;
      const v = ref.w ? ref.w.deref() : ref.v;
      w32(r, ref.w && v === undefined ? 0 : h(v));
      return 0;
    },
    napi_create_promise: (_e, dP, pP) => {
      const id = ++defId;
      const p = new Promise((resolve, reject) => deferreds.set(id, { resolve, reject }));
      w32(dP, id);
      w32(pP, h(p));
      return 0;
    },
    napi_resolve_deferred: (_e, id, v) => (
      deferreds.get(id)!.resolve(H[v]),
      deferreds.delete(id),
      0
    ),
    napi_reject_deferred: (_e, id, v) => (deferreds.get(id)!.reject(H[v]), deferreds.delete(id), 0),
  };

  const asyncSendJs = (type: number, cb: number, data: number) => {
    if (!isMain)
      return workerThreads.parentPort!.postMessage({
        __oxbox: "send",
        type,
        cb,
        data,
      } satisfies AsyncSendMessage);
    if (type === 0) setImmediate(() => tget(cb)(data));
    else queueMicrotask(() => tget(cb)(data));
  };
  const noop = () => {};

  const env: Record<string, unknown> = {
    memory,
    ...Object.fromEntries(Object.entries(napi).map(([k, fn]) => [k, api(fn)])),
    _emnapi_create_function: api(
      (_e, name, len, cb, data, r) => (w32(r, h(makeFunction(cstr(name, len), cb, data))), 0),
    ),
    _emnapi_open_handle_scope: openScope,
    _emnapi_close_handle_scope: closeScope,
    _emnapi_callback_into_module: (
      forceUncaught: number,
      e: number,
      cb: number,
      data: number,
      closeOuterOnThrow: number,
    ) => {
      openScope();
      try {
        tget(cb)(e, data);
        if (pending !== NONE) throw takePending();
      } catch (error) {
        closeScope();
        if (closeOuterOnThrow) closeScope();
        if (forceUncaught) {
          queueMicrotask(() => {
            throw error;
          });
          return;
        }
        throw error;
      }
      closeScope();
    },
    _emnapi_call_finalizer: (
      _forceUncaught: number,
      e: number,
      cb: number,
      data: number,
      hint: number,
    ) => tget(cb >>> 0)(e, data, hint),
    _emnapi_node_make_callback: (
      _e: number,
      res: number,
      cb: number,
      argv: number,
      size: number,
      _asyncId: number,
      _triggerAsyncId: number,
      r: number,
    ) => {
      const args = [];
      for (let i = 0; i < size; i++) args.push(H[r32(argv + i * 4)]);
      const v = Reflect.apply(H[cb], H[res], args);
      if (r) w32(r, h(v));
    },
    _emnapi_node_emit_async_init: noop,
    _emnapi_node_emit_async_destroy: noop,
    _emnapi_env_check_gc_access: noop,
    _emnapi_env_ref: noop,
    _emnapi_env_unref: noop,
    _emnapi_runtime_keepalive_push: noop,
    _emnapi_runtime_keepalive_pop: noop,
    _emnapi_ctx_increase_waiting_request_counter: incWaiting,
    _emnapi_ctx_decrease_waiting_request_counter: decWaiting,
    _emnapi_set_immediate: (cb: number, data: number) => setImmediate(() => tget(cb)(data)),
    _emnapi_async_send_js: asyncSendJs,
    _emnapi_async_work_pool_size: () => poolSize,
    _emnapi_tell_js_uvthreadpool: noop,
    _emnapi_emit_async_thread_ready: noop,
    _emnapi_worker_ref: noop,
    _emnapi_unwind: () => {
      throw "unwind";
    },
    // Busy-waits instead of `memory.atomic.wait` (disallowed on browser main threads and non-shared memory)
    _emnapi_is_main_browser_thread: () => +(isMain && (isMainBrowserThread || !tidCounter)),
    _emnapi_is_main_runtime_thread: () => +isMain,
    _emnapi_get_now: () => performance.timeOrigin + performance.now(),
  };

  const wasi = {
    random_get: (p: number, len: number) => {
      // getRandomValues rejects shared memory views and fills at most 64 KiB per call
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
      at(p, len);
      u8.set(bytes, p);
      return 0;
    },
    environ_sizes_get: (c: number, s: number) => (w32(c, 0), w32(s, 0), 0),
    environ_get: () => 0,
    clock_time_get: (id: number, _precision: bigint, p: number) => {
      at(p, 8);
      const ns =
        id === 0 /* realtime */
          ? BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))
          : BigInt(Math.round(performance.now() * 1e6));
      dv.setBigUint64(p, ns, true);
      return 0;
    },
    fd_write: (fd: number, iovs: number, n: number, out: number) => {
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = r32(iovs + i * 8);
        const l = r32(iovs + i * 8 + 4);
        console[fd === 1 ? "log" : "error"](decode(p, l).replace(/\n$/, ""));
        total += l;
      }
      w32(out, total);
      return 0;
    },
    proc_exit: (code: number) => {
      throw new Error(`wasm proc_exit(${code})`);
    },
    sched_yield: () => 0,
  };

  // wasi-threads: each thread is a worker instantiating the same module over shared memory
  const onMessage = (m: AsyncSendMessage) => {
    // Already on a fresh macrotask: no need to defer like `asyncSendJs` does on the main thread
    if (m?.__oxbox === "send") tget(m.cb)(m.data);
  };
  const threadSpawn = (arg: number) => {
    if (!tidCounter) return -6; /* EAGAIN */
    const { Worker, parentPort } = workerThreads;
    const tid = Atomics.add(tidCounter, 0, 1) + 1;
    const worker = new Worker(SELF, {
      workerData: { __oxbox: { module, memory, tidCounter, tid, arg, poolSize } },
    });
    worker.on("message", (m) => (isMain ? onMessage(m) : parentPort!.postMessage(m)));
    worker.on("error", (error) => {
      throw error;
    });
    worker.unref(); // After listeners: adding a 'message' listener re-refs the port
    return tid;
  };

  return {
    imports: {
      env,
      napi: { napi_add_env_cleanup_hook: () => 0, napi_remove_env_cleanup_hook: () => 0 },
      emnapi: { emnapi_is_node_binding_available: () => 0 },
      wasi_snapshot_preview1: wasi,
      wasi: { "thread-spawn": threadSpawn },
    } as WebAssembly.Imports,
    init(instance: WebAssembly.Instance) {
      const exports = instance.exports as unknown as WasmExports;
      table = exports.__indirect_function_table;
      if (!isMain) return;
      exports._initialize();
      for (const k of Object.keys(exports)) {
        if (k.startsWith("__napi_register__")) (exports[k] as () => void)();
      }
      ENV = (exports.emnapi_create_env() >>> 0) + 8;
      w32(ENV + 16, 1); // env id
      openScope();
      try {
        const exp = {};
        const r = exports.napi_register_wasm_v1(ENV, h(exp));
        if (pending !== NONE) throw takePending();
        return r ? H[r] : exp;
      } finally {
        closeScope();
      }
    },
  };
}

/** Reads the imported memory limits (in pages) from the wasm import section. */
function readMemoryImport(u: Uint8Array) {
  let i = 8;
  const leb = () => {
    let r = 0;
    let sh = 0;
    let b: number;
    do {
      b = u[i++]!;
      r |= (b & 0x7f) << sh;
      sh += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  const limits = () => {
    const flagsAt = i;
    const f = u[i++]!;
    const min = leb();
    const max = f & 1 ? leb() : undefined;
    return { min, max, flagsAt };
  };
  const skip = () => {
    const n = leb(); // `i += leb()` would read `i` before leb() advances it
    i += n;
  };
  while (i < u.length) {
    const id = u[i++];
    const size = leb();
    const end = i + size;
    if (id !== 2 /* import section */) {
      i = end;
      continue;
    }
    for (let n = leb(); n > 0; n--) {
      skip(); // module name
      skip(); // field name
      const kind = u[i++];
      if (kind === 0 /* func */) leb();
      else if (kind === 1 /* table */) {
        i++;
        limits();
      } else if (kind === 2 /* memory */) return limits();
      else if (kind === 3 /* global */) i += 2;
      else if (kind === 4 /* tag */) {
        i++;
        leb();
      }
    }
    break;
  }
  throw new Error("wasm module does not import a memory");
}

function prepare(bytes: Uint8Array, { poolSize = 4, threads = true }: InstantiateOptions) {
  const { min, max, flagsAt } = readMemoryImport(bytes);
  // Without threads, import a non-shared memory (atomic ops remain valid on it)
  if (!threads) bytes[flagsAt]! &= ~2;
  const memory = new WebAssembly.Memory({ initial: min, maximum: max ?? 65536, shared: threads });
  const tidCounter = threads ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  return (module: WebAssembly.Module) =>
    createHost({ module, memory, tidCounter, poolSize, isMain: true });
}

export async function instantiate(bytes: Uint8Array, options: InstantiateOptions = {}) {
  const createMainHost = prepare(bytes, options);
  const module = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
  const host = createMainHost(module);
  return host.init(await WebAssembly.instantiate(module, host.imports));
}

/** Synchronous variant (fine in Node.js; browsers restrict sync compile of large modules). */
export function instantiateSync(bytes: Uint8Array, options: InstantiateOptions = {}) {
  const createMainHost = prepare(bytes, options);
  const module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
  const host = createMainHost(module);
  return host.init(new WebAssembly.Instance(module, host.imports));
}

// Worker thread entry (see threadSpawn)
workerThreads.onWorkerData((data) => {
  if (!data?.__oxbox) return;
  const { tid, arg, ...options } = data.__oxbox as Omit<HostOptions, "isMain"> & {
    tid: number;
    arg: number;
  };
  const host = createHost({ ...options, isMain: false });
  const instance = new WebAssembly.Instance(options.module, host.imports);
  host.init(instance);
  try {
    (instance.exports as unknown as WasmExports).wasi_thread_start(tid, arg);
  } catch (error) {
    if (error !== "unwind") throw error;
  }
});
