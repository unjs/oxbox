import { useEffect, useMemo, useRef, type Ref } from "react";
import { tokenize } from "rangi";

const font = "font-mono text-[13px] leading-5 whitespace-pre p-3 m-0 tab-size-[2]";

// Scrolls only `box` (unlike scrollIntoView, which also scrolls overflow-hidden ancestors)
export function scrollToView(box: HTMLElement, el: HTMLElement) {
  const [b, e] = [box.getBoundingClientRect(), el.getBoundingClientRect()];
  if (e.top < b.top || e.bottom > b.bottom) box.scrollTop += e.top - b.top - b.height / 3;
}

export function Code(props: {
  code: string;
  lang: string;
  onChange?: (code: string) => void;
  marks?: Set<number>;
  highlight?: [start: number, end: number];
  onSelectRange?: (start: number, end: number) => void;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const { code, lang, onChange, marks, highlight, onSelectRange, ref } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const tokens = useMemo(() => tokenize(code, { lang }), [code, lang]);
  const lines = useMemo(() => code.split("\n").length, [code]);

  useEffect(() => {
    if (scrollRef.current && markRef.current) scrollToView(scrollRef.current, markRef.current);
  }, [highlight?.[0], highlight?.[1]]);

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 overflow-auto">
      <div
        aria-hidden
        className={`${font} sticky left-0 z-10 min-w-10 select-none bg-white pr-2 dark:bg-neutral-950 text-right text-neutral-400 dark:text-neutral-600`}
      >
        {marks?.size
          ? Array.from({ length: lines }, (_, i) => (
              <div key={i} className={marks.has(i + 1) ? "font-bold text-red-500" : undefined}>
                {i + 1}
              </div>
            ))
          : Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </div>
      <div className="grid flex-1">
        {highlight && (
          <pre aria-hidden className={`${font} col-start-1 row-start-1 text-transparent`}>
            {code.slice(0, highlight[0])}
            <mark
              ref={markRef}
              className="rounded-sm bg-sky-200/70 text-transparent dark:bg-sky-800/60"
            >
              {code.slice(highlight[0], highlight[1])}
            </mark>
          </pre>
        )}
        <pre aria-hidden={!!onChange} className={`${font} col-start-1 row-start-1`}>
          {tokens.map((t, i) => (
            <span key={i} className={t.type && `shj-${t.type}`}>
              {t.text}
            </span>
          ))}
          {/* keeps a trailing newline visible */}
          {"\n"}
        </pre>
        {onChange && (
          <textarea
            ref={ref}
            aria-label="Input code"
            className={`${font} col-start-1 row-start-1 resize-none overflow-hidden bg-transparent text-transparent caret-neutral-900 outline-none dark:caret-neutral-100`}
            value={code}
            onChange={(e) => onChange(e.target.value)}
            onSelect={(e) =>
              onSelectRange?.(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)
            }
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
          />
        )}
      </div>
    </div>
  );
}
