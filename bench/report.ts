// Renders `results.json` (written by `pnpm bench`) to `results.svg` (README chart)
import { readFileSync, writeFileSync } from "node:fs";

// `avg` in ns
export type Result = { name: string; avg: number };
export type Group = { op: string; file: string; size: string; results: Result[] };
export type Results = {
  env: Record<"date" | "oxc" | "node" | "os" | "cpu" | "memory", string>;
  startup: Result[];
  groups: Group[];
};

const { env, startup, groups }: Results = JSON.parse(
  readFileSync(new URL("results.json", import.meta.url), "utf8"),
);
// Series order (colors): first seen across groups, some implementations only cover some ops
const names = [...new Set([...startup, ...groups.flatMap((g) => g.results)].map((r) => r.name))];
const baseline = "oxc (napi)";

writeFileSync(new URL("results.svg", import.meta.url), svg());
console.log("Written bench/results.svg");

function time(ns: number) {
  if (ns < 1e3) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(1)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(1)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

function ratio(r: { name: string; avg: number }, results: { name: string; avg: number }[]) {
  return r.avg / results.find((b) => b.name === baseline)!.avg;
}

function svg() {
  const W = 800;
  const PAD = 24;
  const X0 = 130; // bars start (row labels on the left)
  const BW = W - PAD - X0 - 100; // longest bar (room for the value label)
  const BAR = 10;
  const GAP = 4;
  const rowH = (n: number) => n * BAR + (n - 1) * GAP;
  const ROW_GAP = 12;
  const max = Math.ceil(
    Math.max(...groups.flatMap((g) => g.results.map((r) => ratio(r, g.results)))),
  );

  const el: string[] = [];
  const text = (x: number, y: number, cls: string, s: string, anchor = "start") =>
    el.push(`<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`);
  const heading = (y: number, title: string, note: string) =>
    el.push(
      `<text x="${PAD}" y="${y}" class="t1 b">${esc(title)}<tspan class="t3" font-weight="400" dx="6">· ${esc(note)}</tspan></text>`,
    );
  // 4px rounded data-end, square at the baseline
  const bar = (x: number, y: number, w: number, i: number) => {
    const r = Math.min(BAR / 2, w);
    el.push(
      `<path class="s${i}" d="M${x},${y}h${f(w - r)}a${r},${r} 0 0 1 ${r},${r}v${BAR - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${f(w - r)}z"/>`,
    );
  };
  const row = (
    y: number,
    label: string,
    results: { name: string; avg: number }[],
    scale: number,
  ) => {
    text(PAD, y + rowH(results.length) / 2 + 4, "t2", label);
    const fastest = Math.min(...results.map((r) => r.avg));
    for (const [i, r] of results.entries()) {
      const w = r.avg * scale;
      const by = y + i * (BAR + GAP);
      bar(X0, by, w, names.indexOf(r.name));
      const rel = r.name === baseline ? "" : ` · ${ratio(r, results).toFixed(2)}x`;
      text(X0 + w + 6, by + BAR / 2 + 4, r.avg === fastest ? "v t1 b" : "v t2", time(r.avg) + rel);
    }
  };

  let y = PAD + 14;
  text(PAD, y, "t1 h", "oxbox vs oxc (wasm) vs oxc (napi)");
  y += 20;
  text(PAD, y, "t2", `Average time per call, relative to ${baseline} (lower is better)`);
  y += 24;
  let lx = PAD;
  for (const [i, name] of names.entries()) {
    el.push(`<rect x="${lx}" y="${y - 9}" width="10" height="10" rx="2" class="s${i}"/>`);
    text(lx + 16, y, "t1", name);
    lx += 16 + name.length * 7 + 20;
  }
  y += 16;

  if (startup.length) {
    y += 16;
    heading(y, "startup", "import + first transformSync in a fresh process (own scale)");
    y += 12;
    row(y, "cold start", startup, BW / Math.max(...startup.map((r) => r.avg)));
    y += rowH(startup.length) + ROW_GAP;
  }

  for (const file of new Set(groups.map((g) => g.file))) {
    const rows = groups
      .filter((g) => g.file === file)
      .sort((a, b) => +a.op.startsWith("transform") - +b.op.startsWith("transform"));
    y += 16;
    heading(y, file, rows[0]!.size);
    y += 12;
    const h = rows.reduce((h, g) => h + rowH(g.results.length) + ROW_GAP, -ROW_GAP);
    for (let t = 0; t <= max; t++) {
      const x = X0 + (BW / max) * t + 0.5;
      el.push(
        `<line x1="${x}" x2="${x}" y1="${y - 4}" y2="${y + h + 4}" class="${t > 1 ? "grid" : "axis"}"/>`,
      );
    }
    for (const g of rows) {
      const napi = g.results.find((r) => r.name === baseline)!.avg;
      row(y, g.op, g.results, BW / max / napi);
      y += rowH(g.results.length) + ROW_GAP;
    }
    y -= ROW_GAP;
    for (let t = 0; t <= max; t++)
      text(X0 + (BW / max) * t, y + 18, "t3", t ? `${t}x` : "0", "middle");
    y += 18;
  }

  y += 32;
  text(PAD, y, "t3", `${env.cpu} · ${env.memory} RAM · ${env.os}`);
  y += 16;
  text(
    PAD,
    y,
    "t3",
    `Node.js ${env.node} · oxc ${env.oxc} · ${env.date} · measured with mitata (pnpm bench)`,
  );
  y += PAD - 8;

  const colors = { t1: "#0b0b0b", t2: "#52514e", t3: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
  const series = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
  const theme = [
    ...Object.entries(colors).map(
      ([k, v]) => `.${k}{${k === "grid" || k === "axis" ? "stroke" : "fill"}:${v}}`,
    ),
    ...series.map((v, i) => `.s${i}{fill:${v}}`),
  ].join("");

  // Always light (white background) so it reads the same in light and dark READMEs
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" role="img" aria-label="Benchmarks: oxbox vs oxc (wasm) vs oxc (napi)">
<style>text{font:12px system-ui,-apple-system,"Segoe UI",sans-serif}.h{font-size:15px;font-weight:600}.b{font-weight:600}.v{font-size:11px;font-variant-numeric:tabular-nums}line{stroke-width:1}${theme}</style>
<rect width="100%" height="100%" rx="8" fill="#ffffff"/>
${el.join("\n")}
</svg>
`;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function f(n: number) {
  return Number(n.toFixed(2));
}
