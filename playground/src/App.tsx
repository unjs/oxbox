import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { OxcError, TransformOptions } from "oxbox";
import { AstTree, findPath, type AstNode } from "./AstTree.tsx";
import { Code } from "./Code.tsx";
import { Split } from "./Split.tsx";

const example = `import { ref, type Ref } from "vue";

interface User {
  id: number;
  name: string;
}

export const user: Ref<User> = ref({ id: 1, name: "oxbox" });

export function greet(u: User = user.value): string {
  return \`Hello, \${u.name}!\`;
}
`;

const exts = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const targets = ["esnext", "es2024", "es2022", "es2020", "es2019", "es2018", "es2017", "es2015"];
const jsxModes = ["automatic", "classic", "preserve"] as const;

const features: [string, () => unknown][] = [
  ["WebAssembly", () => typeof WebAssembly === "object"],
  ["SharedArrayBuffer", () => typeof SharedArrayBuffer === "function"],
  ["crossOriginIsolated", () => globalThis.crossOriginIsolated],
  ["Atomics.waitAsync", () => typeof Atomics?.waitAsync === "function"],
  ["Worker", () => typeof Worker === "function"],
  ["DecompressionStream (deflate-raw)", () => !!new DecompressionStream("deflate-raw")],
];

const env = Object.fromEntries(
  features.map(([name, test]) => {
    try {
      return [name, !!test()];
    } catch {
      return [name, false];
    }
  }),
);

const threads = env.SharedArrayBuffer && env.crossOriginIsolated && env.Worker;

// Own chunk: napi.ts spawns its thread workers from its module URL.
// Warm-up (wasm compile, thread workers, JIT) so displayed timings exclude startup
const oxbox = import("oxbox").then(async (m) => {
  const start = performance.now();
  await Promise.all([m.transform("warmup.ts", example), m.parse("warmup.ts", example)]);
  return { ...m, startupMs: performance.now() - start };
});

const defaults = {
  ext: "ts",
  code: example,
  target: "esnext",
  jsx: "automatic" as (typeof jsxModes)[number],
  tab: "js" as "js" | "dts" | "map",
  ranges: false,
  astView: "tree" as "tree" | "json",
};

type State = typeof defaults;

// UTF-8 safe base64 of the JSON state, kept in the URL hash for reload and sharing
const encode = (state: State) =>
  btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(state)), (b) => String.fromCharCode(b)).join(
      "",
    ),
  );

function decode(hash: string): State {
  try {
    const bytes = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
    return { ...defaults, ...JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return defaults;
  }
}

interface Diagnostic {
  severity: string;
  message: string;
  start?: number;
  end?: number;
  line?: number;
  col?: number;
}

interface Output {
  ready: boolean;
  version: string;
  startupMs: number;
  js: string;
  dts?: string;
  map?: string;
  ast: string;
  program?: unknown;
  source?: string;
  transformMs: number;
  parseMs: number;
  diagnostics: Diagnostic[];
}

const loading: Output = {
  ready: false,
  version: "",
  startupMs: 0,
  js: "// loading oxbox...",
  ast: "// loading oxbox...",
  transformMs: 0,
  parseMs: 0,
  diagnostics: [],
};

const timed = async <T,>(fn: () => Promise<T>) => {
  const start = performance.now();
  const result = await fn();
  return [result, performance.now() - start] as const;
};

function useOxbox(state: State) {
  const { ext, code, target, jsx, tab, ranges } = state;
  const [out, setOut] = useState(loading);
  useEffect(() => {
    let stale = false;
    const filename = `input.${ext}`;
    const options: TransformOptions = {
      target,
      jsx: jsx === "preserve" ? "preserve" : { runtime: jsx },
      sourcemap: tab === "map",
      typescript: tab === "dts" ? { declaration: {} } : undefined,
    };
    (async () => {
      try {
        const { transform, parse, oxcVersion, startupMs } = await oxbox;
        // Sequential so each timing is its own
        const [t, transformMs] = await timed(() => transform(filename, code, options));
        const [p, parseMs] = await timed(() => parse(filename, code));
        if (stale) return;
        const failed = t.errors.length > 0 && !t.code;
        setOut({
          ready: true,
          version: oxcVersion,
          startupMs,
          js: failed ? "// transform failed, see errors" : t.code,
          dts: t.declaration,
          map: t.map && JSON.stringify(t.map, null, 2),
          ast: JSON.stringify(p.program, astReplacer(ranges), 2),
          program: p.program,
          source: code,
          transformMs,
          parseMs,
          diagnostics: diagnostics(code, [...p.errors, ...t.errors] as OxcError[]),
        });
      } catch (error) {
        if (!stale) setOut({ ...loading, js: `// ${error}`, ast: `// ${error}` });
      }
    })();
    return () => {
      stale = true;
    };
  }, [ext, code, target, jsx, tab, ranges]);
  return out;
}

function diagnostics(code: string, errors: OxcError[]): Diagnostic[] {
  const seen = new Set<string>();
  return errors.flatMap((e) => {
    const { start, end } = e.labels[0] ?? {};
    const key = `${e.message}:${start}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (start === undefined) return [{ severity: e.severity, message: e.message }];
    const lines = code.slice(0, start).split("\n");
    return [
      {
        severity: e.severity,
        message: e.message,
        start,
        end,
        line: lines.length,
        col: lines.at(-1)!.length + 1,
      },
    ];
  });
}

const astReplacer = (ranges: boolean) => (key: string, value: unknown) =>
  !ranges && (key === "start" || key === "end" || key === "range")
    ? undefined
    : typeof value === "bigint"
      ? `${value}n`
      : value instanceof RegExp
        ? String(value)
        : value;

const wide = matchMedia("(min-width: 768px)");
const useWide = () =>
  useSyncExternalStore(
    (cb) => (wide.addEventListener("change", cb), () => wide.removeEventListener("change", cb)),
    () => wide.matches,
  );

export function App() {
  const [state, setState] = useState(() => decode(location.hash.slice(1)));
  const set = (patch: Partial<State>) => setState((s) => ({ ...s, ...patch }));
  const isTs = state.ext.endsWith("ts");
  const isJsx = state.ext.endsWith("x");
  const tab = state.tab === "dts" && !isTs ? "js" : state.tab;
  const out = useOxbox({ ...state, tab });
  const isWide = useWide();
  const [view, setView] = useState<"input" | "output" | "ast">("input");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<{ node?: AstNode; path?: Set<object> }>({});
  const [hovered, setHovered] = useState<AstNode>();
  const highlighted = hovered ?? selection.node;

  useEffect(() => {
    setSelection({});
    setHovered(undefined);
  }, [out.program]);

  const selectFromSource = (start: number, end: number) => {
    // Skip caret moves from typing until the AST catches up with the input
    if (inputRef.current?.value !== out.source) return;
    const path = findPath(out.program, start, end);
    setSelection({ node: path?.at(-1) as AstNode | undefined, path: new Set(path) });
  };

  useEffect(() => {
    history.replaceState(null, "", `#${encode(state)}`);
  }, [state]);

  const marks = useMemo(
    () => new Set(out.diagnostics.flatMap((d) => (d.line ? [d.line] : []))),
    [out.diagnostics],
  );

  const reveal = (d: Diagnostic) => {
    if (d.start === undefined) return;
    setView("input");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(d.start!, d.end ?? d.start!);
    });
  };

  const outputCode = tab === "dts" ? out.dts : tab === "map" ? out.map : out.js;

  const input = (
    <Pane
      title="Input"
      actions={
        <label className="flex items-center font-mono text-xs text-neutral-500">
          input.
          <select
            aria-label="File extension"
            className={selectClass}
            value={state.ext}
            onChange={(e) => set({ ext: e.target.value })}
          >
            {exts.map((ext) => (
              <option key={ext}>{ext}</option>
            ))}
          </select>
        </label>
      }
    >
      <Code
        ref={inputRef}
        code={state.code}
        lang={state.ext}
        onChange={(code) => set({ code })}
        marks={marks}
        highlight={highlighted && [highlighted.start, highlighted.end]}
        onSelectRange={selectFromSource}
      />
    </Pane>
  );

  const output = (
    <Pane
      title="Output"
      actions={
        <>
          <Tabs
            value={tab}
            onChange={(tab) => set({ tab })}
            options={[["js", "JS"], ...(isTs ? [["dts", ".d.ts"] as const] : []), ["map", "Map"]]}
          />
          <Select
            label="target"
            value={state.target}
            options={targets}
            onChange={(target) => set({ target })}
          />
          {isJsx && (
            <Select
              label="jsx"
              value={state.jsx}
              options={jsxModes}
              onChange={(jsx) => set({ jsx })}
            />
          )}
          <Meta ms={out.transformMs} ready={out.ready} />
          <CopyButton text={outputCode} />
        </>
      }
    >
      <Code code={outputCode ?? ""} lang={tab === "map" ? "json" : tab === "dts" ? "ts" : "js"} />
    </Pane>
  );

  const ast = (
    <Pane
      title="AST"
      actions={
        <>
          <Tabs
            value={state.astView}
            onChange={(astView) => set({ astView })}
            options={[
              ["tree", "Tree"],
              ["json", "JSON"],
            ]}
          />
          <label className="flex cursor-pointer items-center gap-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={state.ranges}
              onChange={(e) => set({ ranges: e.target.checked })}
            />
            ranges
          </label>
          <Meta ms={out.parseMs} ready={out.ready} />
          <CopyButton text={out.ast} />
        </>
      }
    >
      {state.astView === "tree" && out.program ? (
        <AstTree
          ast={out.program}
          ranges={state.ranges}
          selected={selection.node}
          path={selection.path}
          onSelect={(node) => setSelection({ node })}
          onHover={setHovered}
        />
      ) : (
        <Code code={out.ast} lang="json" />
      )}
    </Pane>
  );

  return (
    <div className="flex h-dvh flex-col bg-white text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-neutral-200 px-3 dark:border-neutral-800">
        <h1 className="font-semibold">oxbox</h1>
        {out.version && (
          <span className="text-xs text-neutral-500 max-md:hidden">
            oxc {out.version} · startup {out.startupMs.toFixed(0)}ms
          </span>
        )}
        {!isWide && (
          <Tabs
            value={view}
            onChange={setView}
            options={[
              ["input", "Input"],
              ["output", "Output"],
              ["ast", "AST"],
            ]}
          />
        )}
        <EnvStatus />
        <a
          href="https://github.com/unjs/oxbox"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-neutral-500 hover:text-neutral-800 max-md:hidden dark:hover:text-neutral-200"
        >
          GitHub
        </a>
      </header>
      <main className="min-h-0 flex-1">
        {isWide ? (
          <Split sizes={[3, 2]}>
            <Split vertical>
              {input}
              {output}
            </Split>
            {ast}
          </Split>
        ) : (
          { input, output, ast }[view]
        )}
      </main>
      {out.diagnostics.length > 0 && (
        <Diagnostics diagnostics={out.diagnostics} onSelect={reveal} />
      )}
    </div>
  );
}

const selectClass =
  "cursor-pointer rounded bg-transparent font-mono text-xs text-neutral-800 outline-none hover:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-sky-500 dark:text-neutral-200 dark:hover:bg-neutral-800";

function Pane(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col">
      <header className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-neutral-200 px-3 whitespace-nowrap dark:border-neutral-800">
        <h2 className="text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
          {props.title}
        </h2>
        {props.actions}
      </header>
      <div className="min-h-0 flex-1">{props.children}</div>
    </section>
  );
}

function Tabs<T extends string>(props: {
  value: T;
  options: (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" className="flex rounded bg-neutral-100 p-0.5 text-xs dark:bg-neutral-900">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          role="tab"
          aria-selected={props.value === value}
          onClick={() => props.onChange(value)}
          className={`rounded px-2 py-0.5 ${props.value === value ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-neutral-500">
      {props.label}
      <select
        className={selectClass}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function Meta(props: { ms: number; ready: boolean }) {
  return (
    <span className="ml-auto font-mono text-xs text-neutral-400 tabular-nums">
      {props.ready && `${props.ms.toFixed(1)}ms`}
    </span>
  );
}

function CopyButton(props: { text?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-40 dark:hover:text-neutral-200"
      disabled={!props.text}
      onClick={async () => {
        await navigator.clipboard.writeText(props.text!);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function EnvStatus() {
  return (
    <>
      <button
        popoverTarget="env"
        className="ml-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span className={`size-2 rounded-full ${threads ? "bg-green-500" : "bg-amber-500"}`} />
        <span className="max-md:sr-only">{threads ? "threads" : "no threads"}</span>
      </button>
      <div
        id="env"
        popover="auto"
        className="inset-auto top-12 right-3 m-0 w-80 max-w-[calc(100vw-1.5rem)] rounded-md border border-neutral-200 bg-white p-3 text-neutral-800 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
      >
        <p className="mb-2 text-xs text-neutral-500">
          {threads
            ? "Async APIs run on wasi-threads workers."
            : "Threads unavailable: async APIs fall back to their sync variants."}
        </p>
        <ul className="space-y-1 font-mono text-xs">
          {Object.entries(env).map(([name, ok]) => (
            <li key={name} className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
              {name}
            </li>
          ))}
          <li className="pt-2 break-all text-neutral-500">{navigator.userAgent}</li>
        </ul>
      </div>
    </>
  );
}

function Diagnostics(props: { diagnostics: Diagnostic[]; onSelect: (d: Diagnostic) => void }) {
  const { diagnostics } = props;
  return (
    <footer className="max-h-32 shrink-0 overflow-auto border-t border-neutral-200 py-1 font-mono text-xs dark:border-neutral-800">
      {diagnostics.map((d, i) => (
        <button
          key={i}
          onClick={() => props.onSelect(d)}
          className="flex w-full gap-2 px-3 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <span className={d.severity === "Error" ? "text-red-500" : "text-amber-500"}>
            {d.severity === "Error" ? "error" : d.severity.toLowerCase()}
          </span>
          {d.line && (
            <span className="text-neutral-500">
              {d.line}:{d.col}
            </span>
          )}
          <span className="truncate">{d.message}</span>
        </button>
      ))}
    </footer>
  );
}
