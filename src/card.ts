import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

/** The facts a share card shows about one undo or restore. */
export interface CardData {
  /** Headline, for example "snap-back undo". */
  title: string;
  /** Files written back from the snapshot. */
  restored: number;
  /** Of those, files that no longer existed: recovered deletions. */
  recovered: number;
  /** Notable paths to name, for example ".env" or a deleted data file. */
  highlights: string[];
  /** Big directories the snapshot could not store, with their recorded size. */
  skipped: { path: string; bytes: number }[];
  agent?: string;
  project?: string;
}

/** Human-readable byte size, for example "310 MB". No decimals above a gigabyte boundary noise. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const WIDTH = 1200;
const HEIGHT = 630;

/** Render a share card as an SVG string. Deterministic; no external resources. */
export function renderCard(data: CardData): string {
  const bg = "#0f1117";
  const panel = "#171a22";
  const fg = "#e6e9ef";
  const muted = "#9aa4b2";
  const accent = "#4ea1ff";
  const warn = "#f0b429";

  const lines: string[] = [];
  const recovered = data.recovered > 0 ? `, ${data.recovered} of them deleted` : "";
  lines.push(`Restored ${data.restored} file${data.restored === 1 ? "" : "s"}${recovered}.`);
  const shownHighlights = data.highlights.slice(0, 4).map((h) => truncate(h, 40));
  if (shownHighlights.length) lines.push(`Including ${shownHighlights.join(", ")}.`);

  const skipRows = data.skipped
    .slice(0, 3)
    .map((s) => `${truncate(s.path.replace(/\/+$/, "") + "/", 34)}  ${formatBytes(s.bytes)} not stored`);

  const bodyY = 300;
  const bodyLines = lines
    .map((t, i) => `<text x="80" y="${bodyY + i * 58}" font-size="38" fill="${fg}">${escapeXml(t)}</text>`)
    .join("\n    ");

  const skipHeaderY = bodyY + lines.length * 58 + 36;
  const skipBlock = skipRows.length
    ? `<text x="80" y="${skipHeaderY}" font-size="26" fill="${warn}">Too big to store, rebuild these:</text>\n    ` +
      skipRows
        .map((t, i) => `<text x="80" y="${skipHeaderY + 40 + i * 38}" font-size="26" fill="${muted}" font-family="monospace">${escapeXml(t)}</text>`)
        .join("\n    ")
    : "";

  const subtitle = [data.agent ? `after ${data.agent}` : null, data.project ? truncate(data.project, 48) : null]
    .filter(Boolean)
    .join("  •  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="sans-serif">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
  <rect x="32" y="32" width="${WIDTH - 64}" height="${HEIGHT - 64}" rx="24" fill="${panel}"/>
  <text x="80" y="120" font-size="30" fill="${accent}" font-weight="700" letter-spacing="2">SNAP-BACK</text>
  <text x="80" y="188" font-size="56" fill="${fg}" font-weight="700">${escapeXml(data.title)}</text>
  ${subtitle ? `<text x="80" y="226" font-size="26" fill="${muted}">${escapeXml(subtitle)}</text>` : ""}
    ${bodyLines}
    ${skipBlock}
  <text x="80" y="${HEIGHT - 60}" font-size="24" fill="${muted}">Undo for any coding agent, including what checkpoints miss.</text>
</svg>
`;
}

/**
 * Well-known font files by platform, each with its family name. The PNG renderer
 * runs in WebAssembly and cannot read the system font list, so it is handed one
 * of these if present; without it, text would not appear in the PNG.
 */
const FONT_CANDIDATES: { path: string; family: string }[] = [
  { path: "/System/Library/Fonts/Supplemental/Arial.ttf", family: "Arial" },
  { path: "/Library/Fonts/Arial.ttf", family: "Arial" },
  { path: "/System/Library/Fonts/Geneva.ttf", family: "Geneva" },
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "DejaVu Sans" },
  { path: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", family: "Liberation Sans" },
  { path: "/usr/share/fonts/TTF/DejaVuSans.ttf", family: "DejaVu Sans" },
  { path: "C:\\Windows\\Fonts\\arial.ttf", family: "Arial" },
  { path: "C:\\Windows\\Fonts\\segoeui.ttf", family: "Segoe UI" },
];

function pickFont(): { buffer: Uint8Array; family: string } | null {
  for (const c of FONT_CANDIDATES) {
    try {
      return { buffer: readFileSync(c.path), family: c.family };
    } catch {
      // not on this machine; try the next
    }
  }
  return null;
}

let wasmReady: Promise<unknown> | null = null;

/**
 * Write the card as SVG, and as PNG when the in-process renderer is available.
 * PNG is best effort: if the renderer cannot start, only the SVG is written.
 * Returns the paths written.
 */
export async function writeCard(data: CardData, basePath: string): Promise<{ svg: string; png?: string }> {
  const svg = renderCard(data);
  const svgPath = basePath.endsWith(".svg") ? basePath : `${basePath}.svg`;
  const base = svgPath.replace(/\.svg$/, "");
  writeFileSync(svgPath, svg);
  const result: { svg: string; png?: string } = { svg: svgPath };
  try {
    const require = createRequire(import.meta.url);
    const resvg = require("@resvg/resvg-wasm") as {
      initWasm: (b: BufferSource) => Promise<void>;
      Resvg: new (svg: string, opts?: unknown) => { render: () => { asPng: () => Uint8Array } };
    };
    if (!wasmReady) {
      const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
      wasmReady = resvg.initWasm(readFileSync(wasmPath));
    }
    await wasmReady;
    const font = pickFont();
    const opts = font
      ? {
          font: {
            loadSystemFonts: false,
            fontBuffers: [font.buffer],
            defaultFontFamily: font.family,
            sansSerifFamily: font.family,
            serifFamily: font.family,
            monospaceFamily: font.family,
          },
        }
      : { font: { loadSystemFonts: true } };
    const png = new resvg.Resvg(svg, opts).render().asPng();
    const pngPath = `${base}.png`;
    writeFileSync(pngPath, png);
    result.png = pngPath;
  } catch {
    // No PNG renderer available; the SVG was still written.
  }
  return result;
}
