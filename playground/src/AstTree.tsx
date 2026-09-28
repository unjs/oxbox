import { useLayoutEffect, useRef, useState } from "react";
import { scrollToView } from "./Code.tsx";

export interface AstNode {
  type: string;
  start: number;
  end: number;
}

interface Context {
  ranges: boolean;
  selected?: AstNode;
  /** Ancestors of `selected` to expand (set when selecting from source) */
  path?: Set<object>;
  onSelect: (node?: AstNode) => void;
  onHover: (node?: AstNode) => void;
}

const rangeKeys = new Set(["start", "end", "range"]);

const isNode = (value: object): value is AstNode =>
  typeof (value as AstNode).type === "string" && typeof (value as AstNode).start === "number";

/** Objects from `value` down to the smallest node covering `start`..`end` */
export function findPath(value: unknown, start: number, end: number): object[] | undefined {
  if (!value || typeof value !== "object") return;
  if (isNode(value) && (start < value.start || end > value.end)) return;
  for (const child of Object.values(value)) {
    const path = findPath(child, start, end);
    if (path) return [value, ...path];
  }
  return isNode(value) ? [value] : undefined;
}

export function AstTree(props: Context & { ast: unknown }) {
  const { ast, ...ctx } = props;
  return (
    <div
      data-ast-tree
      className="h-full overflow-auto py-2 pr-2 font-mono text-[13px] leading-5 whitespace-nowrap"
      onMouseLeave={() => ctx.onHover()}
    >
      <Entry value={ast} depth={0} ctx={ctx} />
    </div>
  );
}

function Entry(props: { name?: string | number; value: unknown; depth: number; ctx: Context }) {
  const { name, value, depth, ctx } = props;
  const inPath = !!value && typeof value === "object" && !!ctx.path?.has(value);
  const [open, setOpen] = useState(depth < 3 || Array.isArray(value) || inPath);
  const rowRef = useRef<HTMLDivElement>(null);
  const selected = !!value && ctx.selected === value;

  useLayoutEffect(() => {
    if (inPath) setOpen(true);
  }, [inPath, ctx.path]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const box = row?.closest<HTMLElement>("[data-ast-tree]");
    if (selected && row && box) scrollToView(box, row);
  }, [selected]);
  const key = name !== undefined && (
    <span className="text-neutral-500">{typeof name === "number" ? `${name}` : `${name}:`} </span>
  );

  if (!value || typeof value !== "object" || value instanceof RegExp) {
    return (
      <div className="pl-3.5">
        {key}
        <Primitive value={value} />
      </div>
    );
  }

  const node = isNode(value) ? value : undefined;
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value).filter(
        ([k]) => (!node || k !== "type") && (ctx.ranges || !rangeKeys.has(k)),
      );

  const expandable = entries.length > 0;

  if (!expandable && !node) {
    return (
      <div className="pl-3.5">
        {key}
        <span className="text-neutral-400">{Array.isArray(value) ? "[]" : "{}"}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={rowRef}
        className={`flex cursor-pointer rounded-sm ${selected ? "bg-sky-100 dark:bg-sky-900/50" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}
        onClick={() => {
          if (!node) return setOpen(!open);
          if (!expandable) return ctx.onSelect(selected ? undefined : node);
          setOpen(true);
          ctx.onSelect(selected ? undefined : node);
        }}
        onMouseEnter={() => ctx.onHover(node)}
      >
        <span
          className="w-3.5 shrink-0 text-center text-neutral-400 select-none hover:text-neutral-800 dark:hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {expandable && (
            <svg
              viewBox="0 0 16 16"
              className={`inline size-3 transition-transform ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
        <span>
          {key}
          {node ? (
            <span className="shj-class">{node.type}</span>
          ) : (
            <span className="text-neutral-400">
              {Array.isArray(value) ? `[${value.length}]` : "{…}"}
            </span>
          )}
          {node && expandable && !open && <span className="text-neutral-400"> {"{…}"}</span>}
        </span>
      </div>
      {expandable && open && (
        <div className="ml-1.5 border-l border-neutral-200 pl-1 dark:border-neutral-800">
          {entries.map(([k, v]) => (
            <Entry key={k} name={k} value={v} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

function Primitive(props: { value: unknown }) {
  const { value } = props;
  if (typeof value === "string") return <span className="shj-str">{JSON.stringify(value)}</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span className="shj-num">{String(value)}</span>;
  if (typeof value === "bigint") return <span className="shj-num">{`${value}n`}</span>;
  if (value instanceof RegExp) return <span className="shj-str">{String(value)}</span>;
  return <span className="text-neutral-400">{String(value)}</span>;
}
