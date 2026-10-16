/**
 * The PDF half of the fixed export command (Slice 1 of the engine stack): the app's own deck page in, a PDF out, printed by the
 * Chrome Headless Shell the worker image already carries. Nothing here fetches anything or runs anyone's script: the page is
 * checked against an allow-list (remotion/src/lib/pdf.ts), Chrome is started with no way to resolve a name and a Content-Security-Policy
 * that allows only files beside the page, and the PDF that comes back is checked for what it should be (a PDF, the page count and size
 * the spec promised) before it is kept. The command takes no arguments; the browser's own flags are fixed in this file.
 */
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PDF_FONTS, PDF_HTML_FILE, PDF_LIMITS, PDF_OUTPUT_FILE,
  checkDeckHtml, imageKindOf, mediaMatches, pdfFacts, validatePdfSpec,
  type PdfSpec,
} from "../src/lib/pdf";

export type PdfFailure = { ok: false; code: "spec_invalid" | "input_missing" | "input_mismatch" | "render_failed"; errors: string[] };
export type PdfSuccess = { ok: true; composition: "pdf"; pages: number; bytes: number; files: { name: string; kind: "pdf"; bytes: number }[]; /** Present when the second print browser made the PDF. */ usedFallback?: true };
export type PdfResult = PdfSuccess | PdfFailure;

export type ChromeRun = { code: number | null; timedOut: boolean; stderr: string };
/** Runs the browser. The real one spawns it with no shell; the tests substitute a stand-in. */
export type ChromeRunner = (executable: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ChromeRun>;

export type RunPdfArgs = {
  spec: unknown;
  inputDir: string;
  outputDir: string;
  /** Scratch folder; created. The page is printed from here: deck.html, assets/, fonts/. */
  workDir: string;
  /** Where the worker image keeps the typeface files (PDF_FONTS). */
  fontsDir: string;
  /** The Chrome Headless Shell. */
  chrome: string | null;
  /**
   * A second print browser, tried only when the first one hangs, crashes or writes nothing (PRINT_FALLBACK: a pinned Chrome for Testing
   * headless shell kept beside the first in the worker image). Null or absent: the first one's answer is the answer.
   */
  fallback?: string | null;
  /** How long the first browser gets when there is a second to fall back to. */
  primaryMs?: number;
  run?: ChromeRunner;
  timeoutMs?: number;
};

const fail = (code: PdfFailure["code"], ...errors: string[]): PdfFailure => ({ ok: false, code, errors });

async function head(file: string, n: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buffer, 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The browser's fixed flags: no sandbox of its own (the container is the sandbox: non-root, read-only, no network), no GPU, no name resolution. */
export function chromeArgs(workDir: string, output: string, profile = "profile"): string[] {
  return [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--mute-audio",
    "--hide-scrollbars",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    `--user-data-dir=${path.join(workDir, profile)}`,
    "--no-pdf-header-footer",
    `--print-to-pdf=${output}`,
    `file://${path.join(workDir, PDF_HTML_FILE)}`,
  ];
}

/** Where the worker image keeps its second print browser (a pinned Chrome for Testing headless shell and the files it needs), and how long the first gets before the second is tried. Constants, not settings. */
export const PRINT_FALLBACK = "/opt/chrome-print/chrome-headless-shell";
export const PRIMARY_PRINT_MS = 30_000;

const realRunner: ChromeRunner = (executable, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    /* A group of its own, so a hung browser's helper processes (zygote, network service, GPU) end with it and none is left to hold the session. */
    const child = spawn(executable, args, { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8", NODE_ENV: "production" } });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8000) stderr += chunk.toString("utf8").slice(0, 8000 - stderr.length); });
    const end = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stderr: String(error.message) }); });
    child.on("close", (code) => { clearTimeout(timer); end(); resolve({ code, timedOut, stderr }); });
  });

export async function runPdf(args: RunPdfArgs): Promise<PdfResult> {
  const checked = validatePdfSpec(args.spec);
  if (!checked.ok) return fail("spec_invalid", ...checked.errors);
  const { pdf } = checked.value as PdfSpec;

  /* The page: a plain file inside input/, not a link. */
  const htmlPath = path.join(args.inputDir, PDF_HTML_FILE);
  let info;
  try { info = await lstat(htmlPath); } catch { return fail("input_missing", `input/${PDF_HTML_FILE} is missing.`); }
  if (!info.isFile()) return fail("input_mismatch", `input/${PDF_HTML_FILE} is not a plain file.`);
  if (info.size > PDF_LIMITS.htmlBytes) return fail("input_mismatch", `input/${PDF_HTML_FILE} is too large.`);
  const html = await readFile(htmlPath, "utf8");
  const problems = checkDeckHtml(html, pdf.images);
  if (problems.length) return fail("spec_invalid", ...problems);

  /* Each picture: a plain file whose bytes are the kind its name says. */
  let total = 0;
  for (const name of pdf.images) {
    const file = path.join(args.inputDir, name);
    let found;
    try { found = await lstat(file); } catch { return fail("input_missing", `input/${name} is missing.`); }
    if (!found.isFile()) return fail("input_mismatch", `input/${name} is not a plain file.`);
    total += found.size;
    if (found.size === 0 || found.size > PDF_LIMITS.imageBytes || total > PDF_LIMITS.imagesTotalBytes) return fail("input_mismatch", `input/${name} is empty or too large.`);
    const kind = imageKindOf(await head(file, 16));
    if (kind !== name.slice(name.lastIndexOf(".") + 1)) return fail("input_mismatch", `input/${name} is not the kind of picture its name says.`);
  }

  /* The folder the browser prints from: the page, its pictures and the typeface, and nothing else. */
  await mkdir(path.join(args.workDir, "assets"), { recursive: true });
  await mkdir(path.join(args.workDir, "fonts"), { recursive: true });
  await mkdir(path.join(args.workDir, "profile"), { recursive: true });
  await writeFile(path.join(args.workDir, PDF_HTML_FILE), html);
  for (const name of pdf.images) await copyFile(path.join(args.inputDir, name), path.join(args.workDir, "assets", name));
  for (const name of PDF_FONTS) {
    try { await copyFile(path.join(args.fontsDir, name), path.join(args.workDir, "fonts", name)); } catch { return fail("render_failed", "The worker image is missing its typeface."); }
  }
  if (!args.chrome) return fail("render_failed", "The worker has no browser to print with.");

  await mkdir(args.outputDir, { recursive: true });
  const printed = path.join(args.workDir, PDF_OUTPUT_FILE);
  const printMs = args.timeoutMs ?? 120_000;
  const second = args.fallback && args.fallback !== args.chrome ? args.fallback : null;
  const run = args.run ?? realRunner;
  const sizeOf = async () => { try { return (await stat(printed)).size; } catch { return 0; } };
  const started = Date.now();
  let usedFallback = false;
  let ran = await run(args.chrome, chromeArgs(args.workDir, printed), { cwd: args.workDir, timeoutMs: second ? Math.min(args.primaryMs ?? PRIMARY_PRINT_MS, printMs) : printMs });
  let size = await sizeOf();
  if (second && (ran.timedOut || ran.code !== 0 || size === 0)) {
    /* The first browser hung, crashed or wrote nothing: print again with the second, in a fresh profile, with what is left of the time. */
    await rm(printed, { force: true });
    await mkdir(path.join(args.workDir, "profile-fallback"), { recursive: true });
    usedFallback = true;
    ran = await run(second, chromeArgs(args.workDir, printed, "profile-fallback"), { cwd: args.workDir, timeoutMs: Math.max(5_000, printMs - (Date.now() - started)) });
    size = await sizeOf();
  }
  if (ran.timedOut) return fail("render_failed", "Printing took too long.");
  if (ran.code !== 0 || size === 0) return fail("render_failed", `The browser did not make a PDF (exit ${ran.code}). ${ran.stderr.replace(/\s+/g, " ").slice(0, 400)}`.trim());
  if (size > PDF_LIMITS.pdfBytes) return fail("render_failed", "The PDF is larger than the limit.");

  const bytes = await readFile(printed);
  const facts = pdfFacts(bytes);
  if (!facts.header) return fail("render_failed", "What the browser wrote is not a PDF.");
  if (facts.pages !== pdf.pages) return fail("render_failed", `The PDF has ${facts.pages} pages; the deck has ${pdf.pages}.`);
  if (!mediaMatches(facts.mediaPt, pdf)) return fail("render_failed", "The PDF's page size is not the size the deck asked for.");
  await writeFile(path.join(args.outputDir, PDF_OUTPUT_FILE), bytes);
  return { ok: true, composition: "pdf", pages: facts.pages, bytes: bytes.length, files: [{ name: PDF_OUTPUT_FILE, kind: "pdf", bytes: bytes.length }], ...(usedFallback ? { usedFallback: true as const } : {}) };
}

/** The Chrome Headless Shell under the runtime folder (where `ensureBrowser` put it at image build), or null. */
export async function findChromeHeadlessShell(runtimeDir: string, maxDepth = 6): Promise<string | null> {
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) if (entry.isFile() && entry.name === "chrome-headless-shell") return path.join(dir, entry.name);
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await walk(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(path.join(runtimeDir, "node_modules", ".remotion"), 0);
}
