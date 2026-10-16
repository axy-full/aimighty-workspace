import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PRIMARY_PRINT_MS, PRINT_FALLBACK, chromeArgs, runPdf, type ChromeRunner } from "../../remotion/node/pdf";
import type { PdfSpec } from "../../remotion/src/lib/pdf";
import { pitchDoc } from "../../lib/pdf/builders";
import { deckHtml } from "../../lib/pdf/html";
import { fakePdf } from "./remotionWorkerFake";

/**
 * The second print browser (remotion/node/pdf.ts, PRINT_FALLBACK): a contingency for the case that the Chrome Headless Shell that
 * Remotion downloads cannot print a deck (it hangs on --print-to-pdf on the build droplet). The first browser gets a short time; if
 * it hangs, crashes or writes nothing, the second prints in a fresh profile. Stand-in browsers here; nothing is sent anywhere.
 */
const FONTS = path.resolve("remotion/public/fonts");
const doc = pitchDoc({ title: "Deck", sections: [{ heading: "One", paragraphs: ["Words."] }] }, { date: "16 Oct 2026", size: "a4" });
const spec: PdfSpec = { version: 1, composition: "pdf", pdf: { pages: doc.pages.length, trimMm: { width: 297, height: 210 }, bleedMm: 0, images: [] } };
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), "pdf-fallback-"));
  for (const d of ["input", "output", "work"]) mkdirSync(path.join(root, d));
  writeFileSync(path.join(root, "input", "deck.html"), deckHtml(doc));
  return { input: path.join(root, "input"), output: path.join(root, "output"), work: path.join(root, "work") };
};
const print = (d: ReturnType<typeof setup>, run: ChromeRunner, extra: Record<string, unknown> = {}) =>
  runPdf({ spec, inputDir: d.input, outputDir: d.output, workDir: d.work, fontsDir: FONTS, chrome: "/opt/first", fallback: "/opt/second", run, ...extra });
const target = (args: string[]) => args.find((a) => a.startsWith("--print-to-pdf="))!.slice("--print-to-pdf=".length);
const good = (args: string[]) => writeFileSync(target(args), fakePdf(doc.pages.length, 297, 210));

test("the constants: the second browser lives beside the image's own, and the first has half a minute", () => {
  expect(PRINT_FALLBACK).toBe("/opt/chrome-print/chrome-headless-shell");
  expect(PRIMARY_PRINT_MS).toBe(30_000);
});

test("the first browser prints: the second is never started", async () => {
  const calls: string[] = [];
  const result = await print(setup(), async (exe, args) => { calls.push(exe); good(args); return { code: 0, timedOut: false, stderr: "" }; });
  expect(result).toMatchObject({ ok: true });
  expect((result as { usedFallback?: boolean }).usedFallback).toBeUndefined();
  expect(calls).toEqual(["/opt/first"]);
});

test("the first browser hangs: it is stopped after its short time, and the second prints in a fresh profile with the same flags", async () => {
  const d = setup();
  const seen: { exe: string; args: string[]; timeoutMs: number }[] = [];
  const result = await print(d, async (exe, args, { timeoutMs }) => {
    seen.push({ exe, args, timeoutMs });
    if (exe === "/opt/first") return { code: null, timedOut: true, stderr: "" };
    good(args);
    return { code: 0, timedOut: false, stderr: "" };
  }, { timeoutMs: 120_000 });
  expect(result).toMatchObject({ ok: true, usedFallback: true, pages: doc.pages.length });
  expect(seen.map((s) => s.exe)).toEqual(["/opt/first", "/opt/second"]);
  expect(seen[0].timeoutMs).toBe(PRIMARY_PRINT_MS);
  expect(seen[1].timeoutMs).toBeGreaterThan(80_000);
  expect(seen[1].args).toEqual(chromeArgs(d.work, path.join(d.work, "deck.pdf"), "profile-fallback"));
  expect(seen[1].args.filter((a) => a.startsWith("--user-data-dir="))).toEqual([`--user-data-dir=${path.join(d.work, "profile-fallback")}`]);
  expect(existsSync(path.join(d.output, "deck.pdf"))).toBe(true);
});

test("the first browser crashes or writes nothing: the second is tried; a half-written file of the first is not kept", async () => {
  for (const first of [{ code: 133, write: false }, { code: 0, write: false }, { code: 1, write: true }]) {
    const d = setup();
    const result = await print(d, async (exe, args) => {
      if (exe === "/opt/first") { if (first.write) writeFileSync(target(args), "%PDF-1.4 broken"); return { code: first.code, timedOut: false, stderr: "crash" }; }
      expect(existsSync(target(args))).toBe(false);
      good(args);
      return { code: 0, timedOut: false, stderr: "" };
    });
    expect(result, JSON.stringify(first)).toMatchObject({ ok: true, usedFallback: true });
  }
});

test("both hang: one answer, in the same words as before, after the first's short time and the second's turn", async () => {
  const exes: string[] = [];
  const result = await print(setup(), async (exe) => { exes.push(exe); return { code: null, timedOut: true, stderr: "" }; });
  expect(result).toMatchObject({ ok: false, code: "render_failed", errors: ["Printing took too long."] });
  expect(exes).toEqual(["/opt/first", "/opt/second"]);
});

test("no second browser (or the same one named twice): the first's answer is the answer, with its full time", async () => {
  for (const fallback of [null, undefined, "/opt/first"]) {
    const seen: number[] = [];
    const result = await print(setup(), async (_exe, _args, { timeoutMs }) => { seen.push(timeoutMs); return { code: null, timedOut: true, stderr: "" }; }, { fallback, timeoutMs: 90_000 });
    expect(result).toMatchObject({ ok: false, errors: ["Printing took too long."] });
    expect(seen).toEqual([90_000]);
  }
});

test("a PDF the second prints is checked like any other: a wrong page count is refused", async () => {
  const result = await print(setup(), async (exe, args) => {
    if (exe === "/opt/first") return { code: null, timedOut: true, stderr: "" };
    writeFileSync(target(args), fakePdf(doc.pages.length + 2, 297, 210));
    return { code: 0, timedOut: false, stderr: "" };
  });
  expect(result).toMatchObject({ ok: false, code: "render_failed" });
});

test("a hung browser's helper processes end with it: the real runner stops the whole process group", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pdf-group-"));
  const shell = path.join(dir, "fake-browser");
  const marker = path.join(dir, "helper.pid");
  /* A stand-in that starts a helper of its own (as a browser starts its zygote) and then hangs. */
  writeFileSync(shell, `#!/bin/sh\nsleep 300 &\necho $! > ${marker}\nsleep 300\n`);
  chmodSync(shell, 0o755);
  const d = setup();
  const result = await runPdf({ spec, inputDir: d.input, outputDir: d.output, workDir: d.work, fontsDir: FONTS, chrome: shell, timeoutMs: 5_000 });
  expect(result).toMatchObject({ ok: false, errors: ["Printing took too long."] });
  const pid = Number(readFileSync(marker, "utf8").trim());
  expect(pid).toBeGreaterThan(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(spawnSync("kill", ["-0", String(pid)]).status, "the helper is gone").not.toBe(0);
});

function headlessShell(): string | null {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(homedir(), ".cache", "ms-playwright")].filter((x): x is string => Boolean(x));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate = path.join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (entry.startsWith("chromium_headless_shell") && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

test("with a real browser as the second: a first browser that hangs is stopped and the deck still prints, to the page count and size it asked for", async () => {
  const second = headlessShell();
  test.skip(!second, "no Chrome Headless Shell on this machine");
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), "pdf-real-fb-"));
  const hung = path.join(dir, "hung-browser");
  writeFileSync(hung, "#!/bin/sh\nsleep 300\n");
  chmodSync(hung, 0o755);
  const d = setup();
  const result = await runPdf({ spec, inputDir: d.input, outputDir: d.output, workDir: d.work, fontsDir: FONTS, chrome: hung, fallback: second, primaryMs: 3_000, timeoutMs: 90_000 });
  expect(result).toMatchObject({ ok: true, usedFallback: true, pages: doc.pages.length });
  expect(readFileSync(path.join(d.output, "deck.pdf")).subarray(0, 5).toString("latin1")).toBe("%PDF-");
});
