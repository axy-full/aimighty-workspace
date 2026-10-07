import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { uiWordsIn } from "../helpers/uiStrings";

/**
 * One design: design/particl-graphite/ is the only design and app/graphite.css the only token set.
 * The inventory of what is still left of the older designs is docs/old-design-inventory.md; this
 * spec is the guard that keeps that inventory from growing.
 *
 *  (a) Nothing the clean slate deleted comes back, and no second design folder or "round 1" appears.
 *  (b) Style sheets: any sheet outside the allow-list below is a new sheet and may only read
 *      app/graphite.css tokens. The allow-list is every old sheet still live; it only shrinks.
 *  (c) UI text: the retired product names and phrases are counted per file. A new occurrence fails,
 *      and so does a file whose count went down but whose baseline did not: lower it, never raise it.
 *  (d) The inventory names every path this guard still allows.
 *  (e) Where git history is there to ask (a local clone, not CI's shallow checkout), the allow-list and
 *      the counts are no bigger than they were where this branch left main.
 *
 * tests/unit/one-design-baseline.json holds the allow-list and the counts. After deleting an old
 * sheet or removing a retired word, run
 *   UPDATE_ONE_DESIGN_BASELINE=1 npx playwright test tests/unit/one-design-guard.spec.ts --project=unit
 * which rewrites the file downwards only. It never adds a sheet or raises a count.
 *
 * The old names are spelled in pieces so this file does not match the clean slate's own search
 * (tests/unit/demo-clean-slate-one-design.spec.ts).
 */

const BASELINE = "tests/unit/one-design-baseline.json";
const INVENTORY = "docs/old-design-inventory.md";
const TOKEN_SET = "app/graphite.css";
const FONTS = "app/fonts.css";
/* The same exemptions as the clean slate's guard: the design folder names what it replaced, and two documents are history. */
const EXEMPT = ["design/particl-graphite/", "docs/handoff-diff.md", "docs/handover-2026-10-05.md"];
/* UI text lives here (brief: components/, app/ and lib/shell/). */
const UI_ROOTS = ["components/", "app/", "lib/shell/"];

type Baseline = { sheets: string[]; words: Record<string, number> };

function git(args: string[]): string {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  test.skip((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT", "git is not installed");
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

/** Tracked files plus new files not yet staged (so a developer sees the failure before CI does). */
function repoFiles(): string[] {
  return git(["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n").filter(Boolean).filter((path) => existsSync(path));
}

const exempt = (path: string) => EXEMPT.some((prefix) => path === prefix || path.startsWith(prefix));
const baseline = (): Baseline => JSON.parse(readFileSync(BASELINE, "utf8"));

/**
 * What the clean slate (#528) deleted or renamed away. Add to this list when a stream deletes an
 * old screen's files; never remove from it.
 */
const TOMBSTONES = [
  "docs/hand" + "off/",
  "docs/phase" + "-0/",
  "docs/four-suites-v2" + "-plan.md",
  "public/marketing/screens/studio-cast.jpg",
  "public/marketing/screens/studio-takes.jpg",
  "public/marketing/screens/workspace-general-enhancer.jpg",
  /* Old-design site screenshots, replaced by Release 1 captures (7 Oct). */
  "public/marketing/screens/gen-composer-blank.jpg",
  "public/marketing/screens/studio-rig-canvas.jpg",
  "public/marketing/screens/viral-history.jpg",
  "public/marketing/screens/workspace-plans-credits.jpg",
  /* The three renamed sheets, under their old names. */
  "app/workbench/mobile-hand" + "off.css",
  "app/workbench/mobile-hand" + "off-stages.css",
  "components/studio/legacy-" + "graphite.css",
  /* The ten Studio stage pages of /suites, deleted by the board PR (the board is the whole production): their pages, helpers and rows. */
  "components/graphite/StageView.tsx",
  "components/graphite/production/AstraOutputs.tsx",
  "components/graphite/production/BeatGraph.tsx",
  "components/graphite/production/BeatsStage.tsx",
  "components/graphite/production/BriefStage.tsx",
  "components/graphite/production/CastStage.tsx",
  "components/graphite/production/EditStage.tsx",
  "components/graphite/production/EnvironmentStage.tsx",
  "components/graphite/production/StoryboardStage.tsx",
  "components/workspace/rig/VerifyBadge.tsx",
  "lib/production/beat-graph.ts",
  "lib/production/beats-undo.ts",
  "lib/workspace/takes-desk.ts",
  "lib/shell/take-handover.ts",
  /* The orphan sweep (7 Oct): old components and lists that nothing imported and no route reached. */
  "lib/nav.ts",
  "lib/shortcuts.ts",
  "components/Canvas.tsx",
  "components/Cast.tsx",
  "components/CreditStrip.tsx",
  "components/ElementSheet.tsx",
  "components/GenGrid.tsx",
  "components/ModeSwitch.tsx",
  "components/Panel.tsx",
  "components/Review.tsx",
  "components/Runway.tsx",
  "components/SectionNav.tsx",
  "components/Studio.tsx",
  "components/Theatre.tsx",
  "components/TopBar.tsx",
  "components/WorkspaceSettings.tsx",
  "components/graphite/DeveloperApiRow.tsx",
  "components/management/ConsumerVideoVerification.tsx",
  "components/management/HiggsfieldConsumerConnection.tsx",
  "components/shell/AccountMenu.tsx",
  "components/shell/AtomikButton.tsx",
  "components/studio/ProjectStudioHeader.tsx",
  "components/workspace/mobile/pages/FormPage.tsx",
];

test("(a) nothing the clean slate deleted comes back, and design/ holds one design", () => {
  const files = repoFiles();
  const back = files.filter((path) => TOMBSTONES.some((stone) => path === stone || (stone.endsWith("/") && path.startsWith(stone))));
  expect(back, "deleted by the clean slate, so they stay deleted").toEqual([]);

  const otherDesigns = files.filter((path) => path.startsWith("design/") && !path.startsWith("design/particl-graphite/"));
  expect(otherDesigns, "design/particl-graphite/ is the only design").toEqual([]);

  /* Round 1 of the guest Home is never committed, in any folder. */
  const roundOne = files.filter((path) => /(^|[/_ .-])round[-_ ]?1([/_ .-]|$)/i.test(path));
  expect(roundOne, "no file of an earlier design round").toEqual([]);

  /* A Claude Design export (.dc.html, support.js) belongs to the design folder only. */
  const exports = files.filter((path) => /\.dc\.html$|(^|\/)support\.js$/.test(path) && !path.startsWith("design/particl-graphite/"));
  expect(exports, "design exports live in design/particl-graphite/").toEqual([]);
});

/** The custom properties app/graphite.css defines. */
function tokenNames(): Set<string> {
  return new Set([...readFileSync(TOKEN_SET, "utf8").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

/** Why a sheet that is not on the allow-list may not stay: the problems with a NEW sheet, empty when it is fine. */
function newSheetProblems(path: string, tokens: Set<string>): string[] {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const problems: string[] = [];
  const own = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const name of own) {
    if (/^--(gx|graphite)-/.test(name)) problems.push(`defines ${name}: tokens are defined in ${TOKEN_SET} only`);
  }
  /* A :root, html or body rule that declares custom properties is a second token set. */
  for (const rule of css.matchAll(/(?:^|})\s*((?::root|html|body)[^{]*)\{([^}]*)\}/g)) {
    if (/--[\w-]+\s*:/.test(rule[2])) problems.push(`${rule[1].trim()} declares custom properties: that is a second token set`);
  }
  /* A name read without a fallback has to be a Graphite token or one the sheet sets itself on a component. */
  for (const use of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    const [, name, fallback] = use;
    if (!tokens.has(name) && !own.has(name) && !fallback) problems.push(`reads ${name}, which is not in ${TOKEN_SET}`);
  }
  return [...new Set(problems)];
}

test("(b) style sheets: the old ones only shrink, a new one reads graphite.css only", () => {
  const list = baseline();
  const sheets = repoFiles().filter((path) => path.endsWith(".css") && !exempt(path));
  const allowed = new Set([TOKEN_SET, FONTS, ...list.sheets]);
  const tokens = tokenNames();

  expect(sheets, `${TOKEN_SET} must exist`).toContain(TOKEN_SET);
  expect(new Set(list.sheets).size, "the allow-list has no duplicates").toBe(list.sheets.length);
  expect(list.sheets.filter((path) => path === TOKEN_SET), `${TOKEN_SET} is the token set, not an old sheet`).toEqual([]);

  const added = sheets.filter((path) => !allowed.has(path));
  const bad = added.flatMap((path) => newSheetProblems(path, tokens).map((problem) => `${path}: ${problem}`));
  expect(bad, "a new style sheet may use only the tokens of app/graphite.css").toEqual([]);

  /* The allow-list names live sheets only: deleting a sheet takes it off the list in the same PR. */
  const gone = list.sheets.filter((path) => !sheets.includes(path));
  if (process.env.UPDATE_ONE_DESIGN_BASELINE) {
    writeFileSync(BASELINE, JSON.stringify({ ...list, sheets: list.sheets.filter((path) => sheets.includes(path)) }, null, 2) + "\n");
  } else {
    expect(gone, "deleted sheets: remove them from the allow-list (UPDATE_ONE_DESIGN_BASELINE=1)").toEqual([]);
  }
  /* Old names never come back as sheets, even renamed onto the list. */
  expect(list.sheets.filter((path) => TOMBSTONES.includes(path))).toEqual([]);
});

/** Retired words per file, over the UI text of components/, app/ and lib/shell/. */
function wordCounts(): { counts: Record<string, number>; where: Record<string, string[]> } {
  const counts: Record<string, number> = {};
  const where: Record<string, string[]> = {};
  const files = repoFiles().filter((path) => /\.tsx?$/.test(path) && UI_ROOTS.some((root) => path.startsWith(root)) && !exempt(path));
  for (const path of files) {
    const hits = uiWordsIn(path, readFileSync(path, "utf8"));
    if (!hits.length) continue;
    counts[path] = hits.length;
    where[path] = hits.map((hit) => `${path}:${hit.line} ${hit.word} | ${hit.text}`);
  }
  return { counts, where };
}

test("(c) UI text: retired names and phrases never go up, per file", () => {
  test.setTimeout(180_000);
  const list = baseline();
  const { counts, where } = wordCounts();

  const worse: string[] = [];
  const better: string[] = [];
  for (const path of Object.keys({ ...counts, ...list.words }).sort()) {
    const now = counts[path] ?? 0;
    const was = list.words[path] ?? 0;
    if (now > was) worse.push(`${path}: ${was} -> ${now}\n    ${(where[path] ?? []).join("\n    ")}`);
    else if (now < was) better.push(`${path}: ${was} -> ${now}`);
  }
  expect(worse, "a new retired word in UI text (Moleculr, Subatomik, Rig, Genjutsu, Soul, Higgsfield, Astra unless it is Topaz's model, or an old suite phrase). Use the new names: README section 7").toEqual([]);

  if (process.env.UPDATE_ONE_DESIGN_BASELINE) {
    const next: Record<string, number> = {};
    for (const [path, was] of Object.entries(list.words)) {
      const now = counts[path] ?? 0;
      if (now > 0) next[path] = Math.min(was, now);
    }
    writeFileSync(BASELINE, JSON.stringify({ ...baseline(), words: next }, null, 2) + "\n");
  } else {
    expect(better, "fewer than the baseline: lower it (UPDATE_ONE_DESIGN_BASELINE=1) so the slack cannot be spent on a new word").toEqual([]);
  }
  test.info().annotations.push({ type: "baseline", description: `${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} occurrences` });
});

test("(d) the inventory names every sheet and file this guard still allows", () => {
  const inventory = readFileSync(INVENTORY, "utf8");
  const list = baseline();
  const missing = [...list.sheets, ...Object.keys(list.words)].filter((path) => !inventory.includes(path));
  expect(missing, `${INVENTORY} must list them`).toEqual([]);
});

test("(e) the allow-list and the counts are no bigger than where this branch left main", () => {
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" });
  test.skip(base.status !== 0, "no origin/main in this checkout (a shallow CI clone): nothing to compare with");
  const before = spawnSync("git", ["show", `${base.stdout.trim()}:${BASELINE}`], { encoding: "utf8", maxBuffer: 1 << 24 });
  test.skip(before.status !== 0, "the baseline does not exist yet on main");
  const then: Baseline = JSON.parse(before.stdout);
  const now = baseline();
  expect(now.sheets.filter((path) => !then.sheets.includes(path)), "sheets added to the allow-list").toEqual([]);
  const raised = Object.entries(now.words).filter(([path, count]) => count > (then.words[path] ?? 0)).map(([path, count]) => `${path}: ${then.words[path] ?? 0} -> ${count}`);
  expect(raised, "counts raised in the baseline").toEqual([]);
});
