/** Subset of `node:worker_threads` used by `napi.ts`, with a Web Worker fallback. */

export interface WorkerLike {
  on(event: "message", fn: (message: any) => void): unknown;
  on(event: "error", fn: (error: Error) => void): unknown;
  unref(): unknown;
}

export interface WorkerThreads {
  Worker: new (url: URL, options: { workerData: unknown }) => WorkerLike;
  parentPort: { postMessage(message: unknown): void } | null;
  /** Calls `fn` with the `workerData` of this thread (Web Workers receive it as the first message). */
  onWorkerData(fn: (data: any) => void): void;
}

const node = globalThis.process?.getBuiltinModule?.("node:worker_threads");

/** True on a browser main thread, where blocking (`Atomics.wait`) is not allowed. */
export const isMainBrowserThread = !node && typeof (globalThis as any).document !== "undefined";

/** Threads need shared wasm memory (cross-origin isolation in browsers) and workers. */
export const canUseThreads = (): boolean =>
  typeof SharedArrayBuffer === "function" &&
  globalThis.crossOriginIsolated !== false &&
  (!!node || typeof Worker === "function");

export const workerThreads: WorkerThreads = node
  ? {
      Worker: node.Worker,
      parentPort: node.parentPort,
      onWorkerData: (fn) => node.workerData && fn(node.workerData),
    }
  : webWorkerThreads();

function webWorkerThreads(): WorkerThreads {
  const scope = globalThis as any;
  const inWorker = typeof scope.WorkerGlobalScope === "function";

  class WebWorker implements WorkerLike {
    #worker: Worker;
    constructor(url: URL, { workerData }: { workerData: unknown }) {
      this.#worker = new Worker(url, { type: "module" });
      this.#worker.postMessage(workerData);
    }
    on(event: "message" | "error", fn: (value: any) => void) {
      this.#worker.addEventListener(event, (e: any) =>
        fn(event === "message" ? e.data : (e.error ?? new Error(e.message || "Worker error"))),
      );
      return this;
    }
    // Web Workers never keep the page alive
    unref() {
      return this;
    }
  }

  return {
    Worker: WebWorker,
    parentPort: inWorker ? { postMessage: (message) => scope.postMessage(message) } : null,
    onWorkerData: (fn) => {
      if (inWorker)
        scope.addEventListener("message", (e: MessageEvent) => fn(e.data), { once: true });
    },
  };
}
