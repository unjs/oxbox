import { Children, Fragment, useRef, useState, type PointerEvent, type ReactNode } from "react";

export function Split(props: { vertical?: boolean; sizes?: number[]; children: ReactNode }) {
  const { vertical } = props;
  const children = Children.toArray(props.children);
  const [sizes, setSizes] = useState(() => props.sizes ?? children.map(() => 1));
  const ref = useRef<HTMLDivElement>(null);

  const startDrag = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = ref.current!.getBoundingClientRect();
    const total = sizes.reduce((a, b) => a + b, 0);
    const scale = total / (vertical ? rect.height : rect.width);
    const start = vertical ? e.clientY : e.clientX;
    const [a, b] = [sizes[i]!, sizes[i + 1]!];
    const min = total * 0.05;
    el.onpointermove = (e) => {
      const delta = Math.max(
        min - a,
        Math.min(b - min, ((vertical ? e.clientY : e.clientX) - start) * scale),
      );
      setSizes((s) => s.map((v, j) => (j === i ? a + delta : j === i + 1 ? b - delta : v)));
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
    };
  };

  return (
    <div
      ref={ref}
      className={`flex h-full min-h-0 w-full min-w-0 ${vertical ? "flex-col" : "flex-row"}`}
    >
      {children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              onPointerDown={startDrag(i - 1)}
              className={`relative z-20 shrink-0 touch-none bg-neutral-200 before:absolute before:content-[''] hover:bg-sky-500 dark:bg-neutral-800 ${vertical ? "h-px cursor-row-resize before:inset-x-0 before:-inset-y-1" : "w-px cursor-col-resize before:inset-y-0 before:-inset-x-1"}`}
            />
          )}
          <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${sizes[i]} 1 0` }}>
            {child}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
