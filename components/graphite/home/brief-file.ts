/**
 * "Attach a brief" (the master's Home): a PDF or a text file, read on this device into the box.
 * PDF goes through the screenplay importer's own reader (lib/workbench/screenplay-pdf.ts), loaded
 * only when a PDF is attached. No other formats (lead decision 23: no new reader dependency).
 */
import { BRIEF_MAX } from "./home-model";

export const BRIEF_ACCEPT = ".pdf,.txt,.md,.markdown,.fountain,application/pdf,text/plain,text/markdown";
/** A text brief larger than this is not a brief. */
const TEXT_MAX_BYTES = 2 * 1024 * 1024;

export type BriefKind = "pdf" | "text";
export function briefKind(file: Pick<File, "name" | "type">): BriefKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "text/plain" || file.type === "text/markdown" || /\.(txt|md|markdown|fountain)$/.test(name)) return "text";
  return null;
}

export class BriefFileError extends Error {}

/** The file's words, at most the brief's limit (`cut` when it was longer). */
export async function readBriefFile(file: File, signal: AbortSignal, onPage?: (page: number, total: number) => void): Promise<{ text: string; cut: boolean }> {
  const kind = briefKind(file);
  if (!kind) throw new BriefFileError("Use a PDF or text file.");
  let text: string;
  if (kind === "pdf") {
    const { extractScreenplayPdf } = await import("@/lib/workbench/screenplay-pdf");
    text = (await extractScreenplayPdf(file, signal, (page, total) => onPage?.(page, total))).text;
  } else {
    if (file.size > TEXT_MAX_BYTES) throw new BriefFileError("Use a text file up to 2 MB.");
    text = await file.text();
  }
  if (signal.aborted) throw new BriefFileError("Reading stopped.");
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new BriefFileError(kind === "pdf" ? "This PDF has no text to read. Use one with text, or a text file." : "This file is empty.");
  return text.length > BRIEF_MAX ? { text: text.slice(0, BRIEF_MAX), cut: true } : { text, cut: false };
}
