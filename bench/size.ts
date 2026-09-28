// Measures the install size (package files + installed dependencies) of oxbox vs oxc (wasm) vs oxc (napi)
// and renders it to `size.svg` (README chart). Usage: pnpm bench:size (builds oxbox first)
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

type Segment = { label: string; raw: number; gzip: number };
type Row = { name: string; segments: Segment[] };

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist/index.mjs"))) throw new Error("Run `pnpm build` first");

// oxbox bundles transform + parser into a single wasm; oxc ships them as two packages (+ shared deps)
const rows: Row[] = [
  {
    name: "oxbox",
    segments: [
      measure(
        "transform + parser",
        ["dist", "package.json", "README.md", "LICENSE"].map((f) => join(root, f)),
      ),
    ],
  },
  {
    name: "oxc (wasm)",
    segments: split("@oxc-transform/binding-wasm32-wasi", "@oxc-parser/binding-wasm32-wasi"),
  },
  { name: "oxc (napi)", segments: split("oxc-transform", "oxc-parser") },
];

const oxcDir = resolvePkg("oxc-transform", root)!;
const oxcVersion = JSON.parse(readFileSync(join(oxcDir, "package.json"), "utf8")).version;
const napiBinding = [...deps("oxc-transform")]
  .map((d) => basename(d))
  .find((n) => n.startsWith("binding-"));

for (const { name, segments } of rows) {
  const total = (k: "raw" | "gzip") => mb(segments.reduce((s, x) => s + x[k], 0));
  console.log(`${name.padEnd(12)} ${total("raw").padStart(8)} (gzip ${total("gzip")})`);
  for (const s of segments)
    console.log(`  ${s.label.padEnd(20)} ${mb(s.raw).padStart(8)} (gzip ${mb(s.gzip)})`);
}
writeFileSync(new URL("size.svg", import.meta.url), svg());
console.log("Written bench/size.svg");

function split(transform: string, parser: string): Segment[] {
  const [t, p] = [deps(transform), deps(parser)];
  const shared = [...t].filter((d) => p.has(d));
  return [
    measure(
      "transform",
      [...t].filter((d) => !p.has(d)),
    ),
    measure(
      "parser",
      [...p].filter((d) => !t.has(d)),
    ),
    measure("shared deps", shared),
  ].filter((s) => s.raw);
}

// Real dirs of `name` and its installed (transitive) dependencies; optional platform bindings are only installed for the host
function deps(name: string, from = root, seen = new Set<string>()) {
  const dir = resolvePkg(name, from);
  if (!dir || seen.has(dir)) return seen;
  seen.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  }))
    deps(dep, dir, seen);
  return seen;
}

function resolvePkg(name: string, from: string): string | undefined {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", name);
    if (existsSync(join(pkg, "package.json"))) return realpathSync(pkg);
  }
}

// `gzip` compresses all files as one stream (≈ npm tarball / download size)
function measure(label: string, paths: string[]): Segment {
  const files = paths.flatMap(read);
  const raw = files.reduce((s, b) => s + b.length, 0);
  return { label, raw, gzip: raw && gzipSync(Buffer.concat(files), { level: 9 }).length };
}

function read(path: string): Buffer[] {
  if (!statSync(path).isDirectory()) return [readFileSync(path)];
  return readdirSync(path)
    .filter((f) => f !== "node_modules")
    .flatMap((f) => read(join(path, f)));
}

function mb(bytes: number) {
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function svg() {
  const W = 800;
  const PAD = 24;
  const X0 = 130; // bars start (row labels on the left)
  const BW = W - PAD - X0 - 70; // longest bar (room for the total label)
  const BAR = 14;
  const ROW = BAR + 16; // bar + segment labels
  const ROW_GAP = 10;
  const labels = ["transform + parser", "transform", "parser", "shared deps"];
  const max = Math.ceil(
    Math.max(...rows.map((r) => r.segments.reduce((s, x) => s + x.raw, 0))) / 1e6,
  );
  const scale = BW / (max * 1e6);

  const el: string[] = [];
  const text = (x: number, y: number, cls: string, s: string, anchor = "start") =>
    el.push(`<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`);
  const heading = (y: number, title: string, note: string) =>
    el.push(
      `<text x="${PAD}" y="${y}" class="t1 b">${esc(title)}<tspan class="t3" font-weight="400" dx="6">· ${esc(note)}</tspan></text>`,
    );
  // Segments separated by a 2px surface gap; 4px rounded data-end on the last one only
  const bar = (x: number, y: number, w: number, i: number, last: boolean) => {
    const r = last ? Math.min(4, w / 2) : 0;
    el.push(
      `<path class="s${i}" d="M${f(x)},${y}h${f(w - r)}a${r},${r} 0 0 1 ${r},${r}v${BAR - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${f(w - r)}z"/>`,
    );
  };

  let y = PAD + 14;
  text(PAD, y, "t1 h", "oxbox vs oxc (wasm) vs oxc (napi): install size");
  y += 20;
  text(PAD, y, "t2", "Package files + installed dependencies (lower is better)");
  y += 24;
  let lx = PAD;
  for (const [i, label] of labels.entries()) {
    el.push(`<rect x="${lx}" y="${y - 9}" width="10" height="10" rx="2" class="s${i}"/>`);
    text(lx + 16, y, "t1", label);
    lx += 16 + label.length * 7 + 20;
  }
  y += 16;

  for (const [k, title, note] of [
    ["raw", "unpacked", "on disk after install"],
    ["gzip", "gzip", "≈ download size"],
  ] as const) {
    y += 16;
    heading(y, title, note);
    y += 12;
    const h = rows.length * (ROW + ROW_GAP) - ROW_GAP;
    for (let t = 0; t <= max; t++) {
      const x = X0 + (BW / max) * t + 0.5;
      el.push(
        `<line x1="${x}" x2="${x}" y1="${y - 4}" y2="${y + h}" class="${t ? "grid" : "axis"}"/>`,
      );
    }
    const totals = rows.map((r) => r.segments.reduce((s, x) => s + x[k], 0));
    for (const [ri, { name, segments }] of rows.entries()) {
      text(PAD, y + BAR / 2 + 4, "t2", name);
      let x = X0;
      for (const [si, s] of segments.entries()) {
        const w = s[k] * scale;
        const last = si === segments.length - 1;
        bar(x, y, last ? w : w - 2, labels.indexOf(s.label), last);
        // Name + size when it fits under the segment, size only otherwise
        const full = `${s.label} ${mb(s[k])}`;
        text(x, y + BAR + 13, "v t3", full.length * 6 < w || last ? full : mb(s[k]));
        x += w;
      }
      const cls = totals[ri] === Math.min(...totals) ? "v t1 b" : "v t2";
      text(x + 6, y + BAR / 2 + 4, cls, mb(totals[ri]!));
      y += ROW + ROW_GAP;
    }
    y -= ROW_GAP;
    for (let t = 0; t <= max; t++)
      text(X0 + (BW / max) * t, y + 14, "t3", t ? `${t} MB` : "0", "middle");
    y += 14;
  }

  y += 32;
  text(
    PAD,
    y,
    "t3",
    `napi bindings: @oxc-*/${napiBinding} (one per platform) · shared deps: emnapi + napi-rs wasm runtime`,
  );
  y += 16;
  text(
    PAD,
    y,
    "t3",
    `oxc ${oxcVersion} · ${new Date().toISOString().slice(0, 10)} · ${os.platform()}-${os.arch()} · measured with pnpm bench:size`,
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" role="img" aria-label="Install size: oxbox vs oxc (wasm) vs oxc (napi)">
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
