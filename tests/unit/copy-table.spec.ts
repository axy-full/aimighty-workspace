import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { COPY, BUTTONS } from "../../lib/copy";
import { bannedNamesIn, lockedCopyIn, retiredLines, thinkingModelNames, RETIRED_LINES, uiTextIn } from "../helpers/uiStrings";
import { repoFiles, scannedFiles } from "../helpers/uiSurfaces";

/**
 * The copy table and the strings test (Amendment, 22 October 2026 (iii), C5, D12, D13 and L2).
 *
 *  1. Every value in lib/copy.ts holds to the design's voice: a button is one word ("Decide for me" is the one multi-word button,
 *     R3), no line is over eight words, "free" is lowercase, and none of the design's forbidden words, the retired names, the
 *     retired lines or a thinking model's name or effort setting appears.
 *  2. No string a person reads anywhere in app/, components/ or lib/ carries a retired line (L2).
 *  3. No string a person reads in app/ or components/ names a thinking model, its version or its effort setting (E: "never
 *     disclose to the user the models and effort settings"). lib/ holds the policy's ids as code (lib/atomikModelPolicy.ts and the
 *     routes that read it), so it is not read here: what reaches a person or an API response from it is checked at run time by the
 *     model-policy PR. Until that PR replaces the model picker with Thinking, its five lines are allowed below, each by name; an
 *     allowance that no longer matches fails, so it is deleted as its line goes, and the list only shrinks.
 *  4. A component of the v31.16 build (components/v31/) writes no string of its own: its words come from lib/copy.ts.
 */

/** The design's forbidden words (docs/design/prompts, every CHECKS line), as whole words in any case. */
const FORBIDDEN = ["Atomik produces", "directed by Atomik", "AI-powered", "made with AI", "token", "markup", "margin", "seed", "model", "template"];
const forbiddenIn = (text: string) => FORBIDDEN.filter((word) => new RegExp(`\\b${word.replace(/[-]/g, "\\-")}s?\\b`, "i").test(text));

const entries = Object.entries(COPY).flatMap(([section, table]) => Object.entries(table).map(([key, text]) => ({ at: `${section}.${key}`, text: text as string })));
const words = (text: string) => text.replace(/[·…?.,!]/g, " ").split(/\s+/).filter(Boolean);

test("the copy table: one-word buttons, short lines, lowercase free, no forbidden word, no retired line, no model", () => {
  const problems: string[] = [];
  for (const { at, text } of entries) {
    if (!text.trim()) problems.push(`${at}: empty`);
    if (words(text).length > 8) problems.push(`${at}: over eight words: ${text}`);
    if (/\bFree\b/.test(text)) problems.push(`${at}: "free" is lowercase: ${text}`);
    for (const word of forbiddenIn(text)) problems.push(`${at}: forbidden word "${word}": ${text}`);
    for (const line of retiredLines(text)) problems.push(`${at}: retired line "${line}": ${text}`);
    for (const name of thinkingModelNames(text)) problems.push(`${at}: thinking model "${name}": ${text}`);
    for (const hit of bannedNamesIn("lib/copy.ts", JSON.stringify(text))) problems.push(`${at}: retired name "${hit.word}": ${text}`);
  }
  for (const [key, text] of Object.entries(BUTTONS)) {
    if (key === "decideForMe") expect(text).toBe("Decide for me");
    else if (words(text).length !== 1) problems.push(`BUTTONS.${key}: a button is one word: ${text}`);
  }
  expect(problems).toEqual([]);
});

test("the matchers: the retired lines and the thinking models are caught, the Director's engines are not", () => {
  expect(retiredLines("Just make it")).toEqual(["Just make it"]);
  expect(retiredLines("how many takes a shot?")).toEqual(["How many"]);
  expect(retiredLines("Invite-only, built for small teams.")).toEqual(["built for small teams"]);
  expect(retiredLines("the editor is the director’s")).toEqual(["the editor is the director's"]);
  expect(retiredLines("Count · 1 · 2 · 3 · 4")).toEqual([]);
  expect(retiredLines("Just make\n    it")).toEqual(["Just make it"]);
  for (const name of [
    "claude-opus-5-5", "anthropic/claude-sonnet-5.5", "Claude Fable 5.1", "Opus 5.5", "opus 5.5", "fable 5", "gpt-6.1-sol", "GPT 6.1", "GPT‑6",
    "gpt-4o", "GPT-4o mini", "o3", "o4-mini", "grok-4.7", "gemini-3.5-flash", "Gemini 3.5 Flash", "Reasoning effort", "effort: high", "effort high",
    "high effort", "Opus 5.5 and GPT Image 2", "Claude Opus 5.5 plans the image", "Sonnet 5.5 for image work", "gpt-6.1-sol writes the image prompt",
  ]) {
    expect(thinkingModelNames(name), name).not.toEqual([]);
  }
  for (const engine of [
    "Seedance 2.5 · 1080p · 5 s", "Kling 3.0 Pro", "GPT Image 2", "gpt-image-2", "GPT 5.1 Image", "gpt-4.1-image", "Grok Imagine 2", "Ideogram 4.5",
    "World Labs Marble", "Nano Banana Pro", "Gemini 2.5 Flash Image", "Gemini 3 Pro Image", "Gemini 3.5 Image", "gemini-2.5-flash-image",
    "gemini-3-pro-image-preview", "Thinking · Medium", "Medium",
  ]) {
    expect(thinkingModelNames(engine), engine).toEqual([]);
  }
  expect(RETIRED_LINES).toContain("Describe the node");
});

/*
 * What the model-policy PR (Amendment (iii) L3) removes with the model picker: until then these lines are allowed, each by file, text
 * and the number of times it is found there, so a new one in the same file still fails.
 */
const UNTIL_MODEL_POLICY: readonly { path: string; text: string; count: number }[] = [
  /* The crew's per-member agent and its effort setting: the owner's call in the model-policy PR (Crew runs on xAI; E says xAI leaves Atomik). */
  { path: "app/api/crew/members/route.ts", text: "Choose low, medium or high effort.", count: 1 },
];

const files = () => scannedFiles(repoFiles());

test("no string a person reads carries a retired line", () => {
  const hits = files().flatMap((path) => lockedCopyIn(path, readFileSync(path, "utf8")).retired.map((hit) => `${path}:${hit.line} "${hit.word}" in ${hit.text}`));
  expect(hits).toEqual([]);
});

test("no string a person reads in app/ or components/ names a thinking model or its effort", () => {
  const found = new Map<string, string[]>();
  for (const path of files().filter((file) => file.startsWith("app/") || file.startsWith("components/"))) {
    for (const hit of lockedCopyIn(path, readFileSync(path, "utf8")).models) {
      const key = `${path}|${hit.text}`;
      found.set(key, [...(found.get(key) ?? []), `${path}:${hit.line} "${hit.word}" in ${hit.text}`]);
    }
  }
  const hits: string[] = [];
  for (const [key, lines] of found) {
    const entry = UNTIL_MODEL_POLICY.find((allowance) => `${allowance.path}|${allowance.text}` === key);
    /* A string with two names in it is one line found twice: count the lines, not the names. */
    const count = new Set(lines.map((line) => line.split(" ")[0])).size;
    if (!entry || count > entry.count) hits.push(...lines);
  }
  expect(hits).toEqual([]);
  const stale = UNTIL_MODEL_POLICY.filter((entry) => !found.has(`${entry.path}|${entry.text}`) || new Set(found.get(`${entry.path}|${entry.text}`)!.map((line) => line.split(" ")[0])).size < entry.count);
  expect(stale.map((entry) => `${entry.path}: ${entry.text} × ${entry.count}`), "an allowance whose lines are gone is lowered or deleted").toEqual([]);
});

/* Where the v31.16 build lives (the lead's choice, 23 Oct 2026; recorded in lib/copy.ts): the step PRs build their screens here. */
const V31 = "components/v31/";

test("a v31.16 component writes no string of its own: its words come from lib/copy.ts", () => {
  const sample = `"use client";\nimport { BUTTONS } from "@/lib/copy";\nexport const A = () => <button aria-label="Keep it" className="pill" data-state="idle">{BUTTONS.keep} · <b>Keep</b>{"Again"}</button>;`;
  expect(uiTextIn("components/v31/Sample.tsx", sample).map((hit) => hit.text)).toEqual(["Keep it", "Keep", "Again"]);
  const code = `"use client";\nexport function B() { const [s] = useState("idle"); void fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" } }); return <i className={cn("pill")} style={{ color: "var(--gx-accent)" }} />; }`;
  expect(uiTextIn("components/v31/Code.tsx", code), "code strings are not words").toEqual([]);
  expect(uiTextIn("components/v31/Sample.tsx", `export const B = () => <span>{BUTTONS.keep} · {price}</span>;`)).toEqual([]);
  const hits = files().filter((path) => path.startsWith(V31)).flatMap((path) => uiTextIn(path, readFileSync(path, "utf8")).map((hit) => `${path}:${hit.line} ${hit.text}`));
  expect(hits).toEqual([]);
});
