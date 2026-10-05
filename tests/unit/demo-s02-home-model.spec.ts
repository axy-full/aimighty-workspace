import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  ASPECTS, BLANK, BRIEF_MAX, DEFAULT_ASPECT, DEFAULT_LENGTH, EMPTY_DRAFT, FIRST_CARDS, LENGTHS, NAME_MAX, TEMPLATES,
  appendBrief, cleanDraft, draftAspect, draftLength, editedLine, isStarterDraft, nameFromBrief, needsLine, newProjectFor,
  renderingByProject, reusable, shownProjects, withAspect, withLength,
} from "../../components/graphite/home/home-model";
import { briefKind } from "../../components/graphite/home/brief-file";
import { SAMPLE_ENTRY_ON, sampleCard } from "../../components/graphite/home/sample";
import type { TrayStage } from "../../lib/jobsTray";

/** design/particl-graphite/README.md § 1.1 (Home) and the master's `?view=home`: the templates, in its order and words. */
test("the four templates are the master's, each opening the board of its kind", () => {
  expect(TEMPLATES.map((t) => t.label)).toEqual(["Film", "Ad campaign", "Social clips", "Start from a script"]);
  expect(TEMPLATES.map((t) => t.kind)).toEqual(["studio", "ads", "social", "studio"]);
  expect(TEMPLATES.find((t) => t.id === "script")?.start).toBe("script");
  expect(TEMPLATES.map((t) => t.untitled)).toEqual(["Untitled film", "Untitled ad campaign", "Untitled social clips", "Untitled script"]);
  expect(BLANK).toMatchObject({ kind: "studio", untitled: "Untitled project" });
  expect(ASPECTS).toEqual(["16:9", "9:16", "1:1"]);
  expect(LENGTHS).toEqual(["6 s", "15 s", "30 s", "60 s"]);
  expect([DEFAULT_ASPECT, DEFAULT_LENGTH]).toEqual(["16:9", "15 s"]);
});

test("a new project is named from the brief's first sentence, cut at a word, or the template's neutral name", () => {
  expect(nameFromBrief("A fox crosses a frozen harbour at dusk. The light goes blue.")).toBe("A fox crosses a frozen harbour at dusk");
  expect(nameFromBrief("   \n  ")).toBeNull();
  expect(nameFromBrief("... !!!")).toBeNull();
  expect(nameFromBrief("\n\nA kettle on a stove\nsteam rising")).toBe("A kettle on a stove");
  const long = nameFromBrief("An unusually long opening sentence that keeps going well past the point where a project name should stop");
  expect(long).toBe("An unusually long opening sentence that keeps");
  expect(long!.length).toBeLessThanOrEqual(48);
  expect(nameFromBrief("Supercalifragilisticexpialidociousandthensomemorewithoutanyspaces")!.length).toBe(48);
  expect(nameFromBrief("Cut here, — and not there")).toBe("Cut here, — and not there");
  expect(nameFromBrief("Two words, then a dash — that runs on and on past the limit of the name")).toBe("Two words, then a dash — that runs on and on");
});

test("the seed carries what the box set: the brief, the aspect, the length and the board's kind", () => {
  const film = TEMPLATES[0], ads = TEMPLATES[1];
  expect(newProjectFor(film, EMPTY_DRAFT)).toEqual({ name: "Untitled film", seed: { aspect: "16:9", deliverables: "15 s", boardKind: "studio" } });
  const typed = withLength(withAspect({ ...EMPTY_DRAFT, text: "  A kettle on a stove. Steam rises.  " }, "9:16"), "6 s");
  expect(newProjectFor(ads, typed)).toEqual({
    name: "A kettle on a stove",
    seed: { brief: "A kettle on a stove. Steam rises.", aspect: "9:16", deliverables: "6 s", boardKind: "ads" },
  });
  expect(newProjectFor(film, { ...EMPTY_DRAFT, text: "x".repeat(400) }).name.length).toBeLessThanOrEqual(NAME_MAX);
});

test("the box saves itself as a blank draft until something differs from its defaults; junk reads as empty", () => {
  expect(withAspect(EMPTY_DRAFT, "16:9")).toEqual(EMPTY_DRAFT);
  expect(withAspect(EMPTY_DRAFT, "1:1").aspect).toBe("1:1");
  expect(withLength(withLength(EMPTY_DRAFT, "60 s"), "15 s")).toEqual(EMPTY_DRAFT);
  expect(draftAspect(EMPTY_DRAFT)).toBe("16:9");
  expect(draftLength({ ...EMPTY_DRAFT, length: "30 s" })).toBe("30 s");
  expect(cleanDraft(null)).toEqual(EMPTY_DRAFT);
  expect(cleanDraft({ text: 7, aspect: "4:3", length: "15 s" })).toEqual(EMPTY_DRAFT);
  expect(cleanDraft({ text: "y".repeat(BRIEF_MAX + 10), aspect: "9:16" })).toEqual({ text: "y".repeat(BRIEF_MAX), aspect: "9:16", length: null });
});

test("an attached brief goes after what is in the box, never past the brief's limit", () => {
  expect(appendBrief("", "  From the file.\r\nLine two.  ")).toEqual({ text: "From the file.\nLine two.", cut: false });
  expect(appendBrief("Typed first.  ", "From the file.")).toEqual({ text: "Typed first.\n\nFrom the file.", cut: false });
  expect(appendBrief("Kept as is", "   ")).toEqual({ text: "Kept as is", cut: false });
  const full = appendBrief("a".repeat(BRIEF_MAX - 5), "bbbbbbbbbb");
  expect(full.cut).toBe(true);
  expect(full.text.length).toBe(BRIEF_MAX);
});

test("an untouched project this tab made from the same template is reused, never one that was saved since", () => {
  const made = [{ id: "p-old", template: "film" as const, at: 1 }, { id: "p-new", template: "film" as const, at: 2 }, { id: "p-ads", template: "ads" as const, at: 3 }];
  expect(reusable(made, "film", [{ id: "p-old", name: "Untitled film", revision: 1 }, { id: "p-new", name: "Untitled film", revision: 1 }])).toBe("p-new");
  expect(reusable(made, "film", [{ id: "p-old", name: "Untitled film", revision: 1 }, { id: "p-new", name: "Untitled film", revision: 3 }])).toBe("p-old");
  expect(reusable(made, "film", [{ id: "p-new", name: "Untitled film" }])).toBeNull();
  expect(reusable(made, "social", [{ id: "p-ads", name: "Untitled ad campaign", revision: 1 }])).toBeNull();
  expect(reusable(made, "ads", [])).toBeNull();
});

test("the needs line says only what is counted: rendering until approvals are read, then both, plurals right", () => {
  expect(needsLine({ approvals: null, rendering: 0 })).toBeNull();
  expect(needsLine({ approvals: null, rendering: 2 })).toEqual({ text: "2 rendering", tone: "live" });
  expect(needsLine({ approvals: 2, rendering: 1 })).toEqual({ text: "2 approvals waiting · 1 rendering", tone: "waiting" });
  expect(needsLine({ approvals: 1, rendering: 0 })).toEqual({ text: "1 approval waiting", tone: "waiting" });
  expect(needsLine({ approvals: 0, rendering: 1 })).toEqual({ text: "1 rendering", tone: "live" });
  expect(needsLine({ approvals: 0, rendering: 0 })).toEqual({ text: "Nothing waiting", tone: "quiet" });
  expect(needsLine({ approvals: 1200, rendering: 0 })?.text).toBe("1,200 approvals waiting");
});

test("rendering is counted per project the way the jobs pill counts it", () => {
  const job = (draftId: string | null, stage: TrayStage) => ({ draftId, stage });
  const counts = renderingByProject([
    job("a", "rendering"), job("a", "submitting"), job("a", "confirming"), job("a", "queued"), job("a", "held"),
    job("b", "complete"), job("b", "failed"), job(null, "rendering"), job("c", "rendering"),
  ]);
  expect([...counts.entries()]).toEqual([["a", 3], ["c", 1]]);
});

test("a card says when the project was last edited, and nothing when the list has no time", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  expect(editedLine({ updatedAt: "2026-10-05T11:59:40Z" }, now)).toBe("Edited just now");
  expect(editedLine({ updatedAt: "2026-10-05T11:55:00Z" }, now)).toBe("Edited 5 min ago");
  expect(editedLine({ updatedAt: String(now - 3 * 3600_000) }, now)).toBe("Edited 3 hr ago");
  expect(editedLine({}, now)).toBe("");
});

test("the first nine cards show, then Show all", () => {
  const list = Array.from({ length: 12 }, (_, i) => i);
  expect(shownProjects(list, false)).toEqual({ shown: list.slice(0, FIRST_CARDS), hidden: 3 });
  expect(shownProjects(list, true)).toEqual({ shown: list, hidden: 0 });
  expect(shownProjects(list.slice(0, 4), false)).toEqual({ shown: list.slice(0, 4), hidden: 0 });
});

test("the sample entry stays off until stream 12's placeholder sweep; when on, the person's own draft of it is the card", () => {
  expect(SAMPLE_ENTRY_ON).toBe(false);
  expect(isStarterDraft("starter-0123456789abcdef01234567")).toBe(true);
  expect(isStarterDraft("project-1")).toBe(false);
  expect(sampleCard([{ id: "project-1", name: "Mine" }])).toEqual({ id: null, name: "Sample production" });
  expect(sampleCard([{ id: "project-1", name: "Mine" }, { id: "starter-abc", name: "The starter" }])).toEqual({ id: "starter-abc", name: "The starter" });
});

test("Attach a brief takes a PDF or a text file, nothing else", () => {
  expect(briefKind({ name: "Brief.PDF", type: "" })).toBe("pdf");
  expect(briefKind({ name: "notes", type: "application/pdf" })).toBe("pdf");
  expect(briefKind({ name: "brief.txt", type: "text/plain" })).toBe("text");
  expect(briefKind({ name: "script.fountain", type: "" })).toBe("text");
  expect(briefKind({ name: "brief.md", type: "" })).toBe("text");
  expect(briefKind({ name: "brief.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBeNull();
  expect(briefKind({ name: "frame.png", type: "image/png" })).toBeNull();
});

test("Home's sheet uses only the token set's colours (app/graphite.css)", () => {
  const css = readFileSync("components/graphite/home/home.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  expect(css.match(/\brgba?\(/gi) ?? []).toEqual([]);
  expect(css.match(/\bhsla?\(/gi) ?? []).toEqual([]);
  /* The one gradient is the project swatch's, from posterOf's two stops (README § 2 allows gradients on swatches only). */
  expect(css.match(/gradient\(/g) ?? []).toHaveLength(1);
  expect(css).toContain("linear-gradient(135deg, var(--hm-from), var(--hm-to))");
});
