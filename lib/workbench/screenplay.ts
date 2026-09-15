/** Screenplay source limits are explicit; no caller may silently slice a script. */
export const MAX_SCRIPT_CHARS = 1_000_000;
export const MAX_SCRIPT_PAGES = 400;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export type ScriptPage = { page: number; start: number; end: number };
export type ScreenplayOcr = {
  engine: "tesseract-7.0.0";
  language: "eng";
  requestedPages: number[];
  pages: {
    page: number;
    confidence: number;
    reviewed: boolean;
    corrected: boolean;
  }[];
};
export type ScriptSource = {
  assetId: string;
  filename: string;
  sha256: string;
  pages: ScriptPage[];
  importedAt: string;
  edited: boolean;
  acknowledgedEmptyPages: number[];
  ocr?: ScreenplayOcr;
};
export type SceneReview = {
  sourceKey: string;
  intent: string;
  beats: string[];
};
export type ScreenplayImport = {
  text: string;
  pages: ScriptPage[];
  sha256: string;
  emptyPages: number[];
  ocr?: ScreenplayOcr;
};
export type ScriptScene = {
  id: string;
  slug: string;
  number?: string;
  location: string;
  time: string;
  body: string;
  characters: string[];
  start: number;
  end: number;
  pageStart?: number;
  pageEnd?: number;
  sourceKey: string;
};

/** A change marker, not a security hash. It invalidates notes when source text changes. */
export function sceneKey(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
const heading =
  /^\s*(?:(\d+[A-Z]?)\.?\s+)?((?:INT\.?\s*[\/-]\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INT\.?|EXT\.?|I\/E\.?)[ .].+)$/i;

export function parseScreenplay(
  script: string,
  pages: ScriptPage[] = [],
): ScriptScene[] {
  const lines = [...script.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0]);
  const starts: {
    offset: number;
    bodyStart: number;
    slug: string;
    number?: string;
  }[] = [];
  for (const match of lines) {
    const line = match[0].replace(/[\r\n\f]/g, "");
    const h = line.match(heading);
    if (!h) continue;
    const number = h[1];
    // Final Draft can repeat the production scene number in the right margin.
    const clean = number
      ? h[2].replace(new RegExp("\\s+" + number + "\\s*$", "i"), "")
      : h[2];
    starts.push({
      offset: match.index!,
      bodyStart: match.index! + match[0].length,
      slug: clean.trim(),
      number,
    });
  }
  if (!starts.length && script.trim())
    starts.push({ offset: 0, bodyStart: 0, slug: "UNASSIGNED SCENE" });
  return starts.map((item, index) => {
    const end = starts[index + 1]?.offset ?? script.length;
    const body = script.slice(item.bodyStart, end).trim();
    const parts = item.slug.split(/\s+[-–—]\s+/);
    const bodyLines = body.split("\n"),
      characters = new Set<string>();
    for (let j = 0; j < bodyLines.length; j++) {
      const cue = bodyLines[j].trim();
      if (
        !/^[A-Z][A-Z .’'\-]{1,35}(?:\s*\((?:V\.O\.|O\.S\.|CONT['’]D)\))?$/.test(
          cue,
        )
      )
        continue;
      if (/(?:FADE|CUT TO|DISSOLVE|THE END|CONTINUED)/.test(cue)) continue;
      const next = bodyLines
        .slice(j + 1, j + 4)
        .map((line) => line.trim())
        .find(Boolean);
      // Uppercase action without a following dialogue line is not a cast cue.
      if (next && !heading.test(next) && !/^[A-Z\s\d.]+$/.test(next))
        characters.add(cue.replace(/\s*\(.*\)$/, ""));
    }
    return {
      id: "scene-" + String(index + 1).padStart(2, "0"),
      slug: item.slug,
      number: item.number,
      location: parts[0].replace(
        /^(?:INT\.?\s*[\/-]\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INT\.?|EXT\.?|I\/E\.?)[ .]+/i,
        "",
      ),
      time: parts.slice(1).join(" - ") || "Not specified",
      body,
      characters: [...characters],
      start: item.offset,
      end,
      pageStart: pages.find(
        (p) => item.offset >= p.start && item.offset < p.end,
      )?.page,
      pageEnd: pages.find(
        (p) =>
          Math.max(item.offset, end - 1) >= p.start &&
          Math.max(item.offset, end - 1) < p.end,
      )?.page,
      sourceKey: sceneKey(script.slice(item.offset, end)),
    };
  });
}

export function assemblePages(texts: string[]): {
  text: string;
  pages: ScriptPage[];
  emptyPages: number[];
} {
  if (!texts.length || texts.length > MAX_SCRIPT_PAGES)
    throw new Error(`Use a PDF with 1–${MAX_SCRIPT_PAGES} pages.`);
  let text = "";
  const pages: ScriptPage[] = [],
    emptyPages: number[] = [];
  texts.forEach((value, index) => {
    const pageText = value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    const start = text.length;
    text += pageText + "\n\f\n";
    if (text.length > MAX_SCRIPT_CHARS)
      throw new Error(
        "The extracted screenplay exceeds one million characters. Nothing was imported. Split the source into explicitly named parts.",
      );
    pages.push({ page: index + 1, start, end: text.length });
    if (pageText.replace(/[\s\d.]/g, "").length < 8) emptyPages.push(index + 1);
  });
  return { text, pages, emptyPages };
}

type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};
/** Reconstruct horizontal screenplay lines from PDF positions, including cue indentation. */
export function screenplayPageText(items: TextItem[]): string {
  const sorted = items
    .filter((i) => i.str.trim())
    .sort(
      (a, b) =>
        b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
    );
  const rows: { y: number; height: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (
      row &&
      Math.abs(row.y - item.transform[5]) <= Math.max(2, item.height * 0.25)
    )
      row.items.push(item);
    else
      rows.push({
        y: item.transform[5],
        height: item.height || 12,
        items: [item],
      });
  }
  const left = Math.min(...sorted.map((i) => i.transform[4]));
  return rows
    .map((row, index) => {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const first = row.items[0],
        charWidth = Math.max(3, first.height * 0.5);
      let line = " ".repeat(
        Math.min(
          40,
          Math.max(0, Math.round((first.transform[4] - left) / charWidth)),
        ),
      );
      row.items.forEach((item, at) => {
        const previous = row.items[at - 1];
        if (
          previous &&
          item.transform[4] > previous.transform[4] + previous.width + 1
        )
          line += " ";
        line += item.str;
      });
      const prior = rows[index - 1];
      return (
        (prior && prior.y - row.y > Math.max(row.height, prior.height) * 1.65
          ? "\n"
          : "") + line
      );
    })
    .join("\n");
}
