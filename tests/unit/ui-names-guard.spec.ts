import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bannedNamesIn } from "../helpers/uiStrings";
import { SURFACES, format, manifestStrings, scanAll, surfaceOf, type Hit, type Scan } from "../helpers/uiSurfaces";
import { compare, expired, growth, lowered, onMain, past, readJson, shapeProblems, type Section } from "../helpers/ratchet";

/**
 * Banned names: every UI string, not only the screens' JSX.
 *
 * The old check (one-design-guard.spec.ts, test c) counted retired words in the JSX text and string literals of
 * components/, app/ and lib/shell/, with a per-file baseline. It missed what is read through data: the ⌘K index,
 * the tab and page label tables, the page titles, the phone bar and the marketing navigation, because those
 * files sat on the baseline or outside its roots, and because "Gen" was never a banned name. This spec reads
 * every string a person can read, in app/, components/ and lib/, and fails on any banned name:
 *
 *   Moleculr, Subatomik, Rig, Genjutsu, Soul, Higgsfield, "Gen" as the name of a place (and "Generate" as a
 *   navigation label), "Astra" unless the same string says Topaz, the old suite phrases, and the same words in capitals.
 *
 * Exempt: code identifiers, comments, tests, design/particl-graphite/, docs/handoff-diff.md and
 * docs/handover-2026-10-05.md. Never read as UI: imports, comparisons, case labels, property keys, types, className/id/href/data-*.
 *
 *  - STRICT surfaces (tests/helpers/uiSurfaces.ts) allow nothing: the shell and avatar menu, ⌘K, tab/page/header labels,
 *    the phone bar, page titles (anywhere), the marketing site and navigation, the manifest.
 *  - Every other old-screen file is on the RATCHET (tests/unit/ui-names-ratchet.json): its count only goes down, and each entry
 *    carries the date the screen is deleted (docs/old-design-inventory.md). After that date the file must be at zero.
 *
 * Until the D0 fixes and the board PR land, what they have not yet removed is allowed per file in the ratchet's "strict" and "titles"
 * sections (by: D0, until: Thu 8 Oct), so this spec is green on main, can never get worse, and fails on the date. Delete an allowance
 * (UPDATE_UI_NAMES_RATCHET=1) as its names go. The list of what remains per PR: S/demo/ci-checks-d0-heads.md.
 *
 * After removing names: UPDATE_UI_NAMES_RATCHET=1 npx playwright test tests/unit/ui-names-guard.spec.ts --project=unit
 * lowers the ratchet (never raises it, never adds a file).
 */

const RATCHET = "tests/unit/ui-names-ratchet.json";
const WAIVERS = "tests/unit/ui-check-waivers.json";
/**
 * `ratchet`: old-screen files. `strict`: files on a strict surface, each with what the D0 pull requests have not yet removed.
 * `titles`: page-title hits in files no strict surface claims. Every entry: { count, until, by }.
 */
type Ratchet = { ratchet: Section; strict: Section; titles: Section };
const ratchetFile = (): Ratchet => readJson<Ratchet>(RATCHET);

let scan: Scan | null = null;
const scanned = () => (scan ??= scanAll());

const list = (hits: Hit[]) => hits.map(format);

/* ---------------------------------------------------------------------------------------------- */
/* The matcher itself: what it must catch and what it must leave alone.                            */
/* ---------------------------------------------------------------------------------------------- */

const R = ["R", "ig"].join("");
const SOUL = ["So", "ul"].join("");
const GEN = ["G", "en"].join("");
const ASTRA = ["As", "tra"].join("");
const MOLECULR = ["Mole", "culr"].join("");

const names = (source: string, navigation = false) => bannedNamesIn("probe.tsx", source, { navigation }).map((hit) => hit.word);

test("the matcher reads every kind of UI string: ⌘K data, tab tables, page titles, JSX, attributes, templates", () => {
  /* ⌘K and tab label data: strings in object literals and arrays. */
  expect(names(`export const rows = [{ group: "SUITE", label: "${R}", hint: "x" }];`)).toEqual([R]);
  expect(names(`export const TABS = { a: { label: \`Open in ${GEN}\` } };`)).toEqual([`Open in ${GEN}`]);
  expect(names(`const a = "Make it in ${GEN}";`)).toEqual([GEN]);
  expect(names(`const label = \`\${n} ${MOLECULR} Business\`;`)).toEqual([MOLECULR]);
  /* page titles are found and tagged */
  expect(bannedNamesIn("page.tsx", `export const metadata = { title: "${GEN} · Particl" };`).map((hit) => [hit.word, hit.title])).toEqual([[GEN, true]]);
  expect(bannedNamesIn("page.tsx", `export async function generateMetadata() { return { title: "${R}" }; }`).map((hit) => hit.title)).toEqual([true]);
  expect(bannedNamesIn("c.tsx", `useEffect(() => { document.title = "${R} board"; });`).map((hit) => hit.title)).toEqual([true]);
  expect(bannedNamesIn("c.tsx", `const a = <h1>${R}</h1>;`).map((hit) => hit.title)).toEqual([false]);
  /* JSX text, accessible names, placeholders and alt text are read by people */
  expect(names(`const a = <button aria-label="Open the ${R}" title="${SOUL}">x</button>;`)).toEqual([R, SOUL]);
  expect(names(`const a = <p>Pick a look in ${GEN}</p>;`)).toEqual([GEN]);
  /* capitals: a group heading or a tab uppercased in the data */
  expect(names(`const g = "${R.toUpperCase()}";`)).toEqual([R.toUpperCase()]);
  expect(names(`const g = "${GEN.toUpperCase()}";`)).toEqual([GEN]);
  /* "Generate" alone is a navigation label only in navigation data */
  expect(names(`const a = { label: "Generate" };`, true)).toEqual(["Generate (label)"]);
  expect(names(`const a = { label: "Generate" };`, false)).toEqual([]);
  expect(names(`const a = { label: "Generate a still" };`, true)).toEqual([]);
});

test("the matcher leaves code alone: identifiers, comments, comparisons, keys, imports, class names, model names", () => {
  expect(names(`// ${R} and ${GEN} in a comment\n/* ${SOUL} */ const ${R.toLowerCase()}Ready = 1;`)).toEqual([]);
  expect(names(`if (kind === "${R}") {}\nswitch (x) { case "${GEN}": break; }`)).toEqual([]);
  expect(names(`const o = { ${R}: 1, "${GEN}": 2 }; type T = "${R}" | "${GEN}";`)).toEqual([]);
  expect(names(`import x from "@/components/${R}/Bar"; const y = <div className="${R}" data-kind="${SOUL}" id="${GEN}" />;`)).toEqual([]);
  expect(names(`const a = "${R.toLowerCase()}"; const b = "${SOUL.toUpperCase()}_ID";`)).toEqual([]);
  expect(names(`const m = "Runway ${GEN}-4 Turbo"; const n = "${GEN} 3"; const o = "${GEN} Z";`)).toEqual([]);
  /* Astra is allowed only as Topaz's model name */
  expect(names(`const m = "Topaz ${ASTRA} 2";`)).toEqual([]);
  expect(names(`const m = "${ASTRA} 3D";`)).toEqual([ASTRA]);
  expect(names(`const m = "Choose a video for ${ASTRA} upscale";`)).toEqual([ASTRA]);
});

/* ---------------------------------------------------------------------------------------------- */
/* STRICT surfaces: zero allowed, except what the D0 pull requests still have to remove.          */
/* ---------------------------------------------------------------------------------------------- */

const countsOf = (hits: Hit[]) => hits.reduce<Record<string, number>>((acc, hit) => ({ ...acc, [hit.path]: (acc[hit.path] ?? 0) + 1 }), {});
const hitsOf = (hits: Hit[]) => (path: string) => list(hits.filter((hit) => hit.path === path)).join("\n    ");

/**
 * A strict surface allows nothing. Until the D0 pull requests (and site/copy-names) have merged, each file carries an
 * allowance in the ratchet's "strict" section with the date it must be zero and who removes it: so this check is green
 * on main today, can never get worse, and fails on the date. A file with no allowance, a new file, has an allowance of zero.
 */
function strictCheck(hits: Hit[], section: Section, claims: (path: string) => boolean, what: string) {
  const mine = Object.fromEntries(Object.entries(section).filter(([path]) => claims(path)));
  const now = countsOf(hits);
  const { worse, better } = compare(now, mine, hitsOf(hits));
  expect(worse, `a banned name on ${what} that is not already allowed until the D0 fixes land. Use the new names (README section 7)`).toEqual([]);
  expect(expired(mine, now), `past the date: ${what} must have no banned name left`).toEqual([]);
  if (process.env.UPDATE_UI_NAMES_RATCHET) return;
  expect(better, "fewer than allowed: lower the allowance (UPDATE_UI_NAMES_RATCHET=1) so the slack cannot be spent on a new name").toEqual([]);
  test.info().annotations.push({ type: "remaining", description: `${hits.length} banned names in ${Object.keys(now).length} files still allowed until the D0 fixes land` });
}

for (const surface of SURFACES) {
  test(`STRICT · ${surface.name}: no banned name in any UI string (what D0 has not removed yet is allowed per file, and falls to zero on its date)`, () => {
    strictCheck(scanned().strict[surface.id], ratchetFile().strict, (path) => surfaceOf(path)?.id === surface.id, surface.name);
  });
}

test("STRICT · page titles: no banned name in a <title>, metadata or document.title, in any file", () => {
  strictCheck(scanned().strict.titles, ratchetFile().titles, () => true, "a page title");
});

test("STRICT · public/manifest.json: the name and description on a phone's home screen", () => {
  const bad = manifestStrings().flatMap(({ path, text }) => bannedNamesIn("manifest.ts", `export const x = ${JSON.stringify(text)};`).map((hit) => `${path} [${hit.word}] ${text}`));
  expect(bad, "banned names in the web manifest").toEqual([]);
});

test("STRICT · ⌘K lists exactly the design's items: no Generate, Business or Viral, 01-07 stages, or old names", async () => {
  /* design/particl-graphite/ "Particl Suites.dc.html" (the `pal` list) and README section 3.4: Home; the board's regions; Ads and
     Social; Make; Atomik; the Settings sections (Team, Plan & credits, Spending rules, Connections, Advanced). The owner's fix 4 adds
     Make's modes (Motion transfer and Object swap among them) and Atomik's four places. Models and assets are the person's own data. */
  const DESIGN = ["Home", "Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver", "Ads", "Social", "Make", "Atomik", "Team", "Plan & credits", "Spending rules", "Connections", "Advanced"];
  const OWNER_REQUIRED = ["Motion transfer", "Object swap", "Approvals", "Activity", "Skills", "Memory"];
  const OWNER_OPTIONAL = ["Video", "Images", "Audio", "Recent"];
  const palette = await import("../../lib/shell/palette");
  const rows = (palette.paletteIndex as (input: unknown) => { group: string; label: string }[])({ models: [], assets: [] }).filter((row) => !["MODEL", "ASSET", "ATOMIK ASK"].includes(row.group.toUpperCase()));
  /* "Make › Video" and "Atomik › Memory" are the row for Video and Memory under Make and Atomik. */
  const labels = rows.map((row) => row.label.split(/\s*[›:]\s*/).pop()!.trim());
  const missing = [...DESIGN, ...OWNER_REQUIRED].filter((label) => !labels.includes(label));
  const extra = labels.filter((label) => ![...DESIGN, ...OWNER_REQUIRED, ...OWNER_OPTIONAL].includes(label));
  const problem = { missing, extra };
  const waiver = readJson<Record<string, { until: string; by: string }>>(WAIVERS)["command-k-list"];
  const clean = !missing.length && !extra.length;
  if (waiver && !past(waiver.until)) {
    test.info().annotations.push({ type: "waived", description: `${waiver.by} until ${waiver.until}: ${clean ? "the list is right: delete the waiver" : JSON.stringify(problem)}` });
    return;
  }
  expect(problem, "⌘K must list exactly the design's items (rows are in lib/shell/palette.ts)").toEqual({ missing: [], extra: [] });
});

test("the ⌘K waiver is dated and owned", () => {
  const waivers = readJson<Record<string, { until: string; by: string }>>(WAIVERS);
  for (const [name, waiver] of Object.entries(waivers)) {
    expect(waiver.until, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(waiver.by?.trim(), name).toBeTruthy();
  }
});

test("the strict surfaces cover the files they name: a rename cannot quietly empty a surface", () => {
  const strictFiles = Object.keys(scanned().strict);
  expect(strictFiles).toEqual(expect.arrayContaining(["phone-bar", "command-k", "shell", "labels", "marketing", "titles"]));
  /* The scan has to have seen the files that carry the data: if these moved, update tests/helpers/uiSurfaces.ts. */
  const seen = scannedFilesList();
  for (const must of ["lib/shell/ia.ts", "lib/shell/palette.ts", "components/graphite/Header.tsx", "components/graphite/TabBar.tsx", "components/graphite/Palette.tsx", "lib/marketing/site.ts", "components/marketing/SiteChrome.tsx"]) {
    expect(seen, `${must} is a strict-surface file and is no longer scanned (renamed or deleted? update tests/helpers/uiSurfaces.ts)`).toContain(must);
  }
});

function scannedFilesList(): string[] {
  const out = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.stdout.split("\n").filter(Boolean);
}

/* ---------------------------------------------------------------------------------------------- */
/* RATCHET: the old screens, per file, with the date each is deleted.                              */
/* ---------------------------------------------------------------------------------------------- */

test("RATCHET · old-screen files: a banned name never appears in a new place, and the counts only go down", () => {
  const baseline = ratchetFile();
  const { ratchet } = scanned();
  const { worse, better } = compare(countsOf(Object.values(ratchet).flat()), baseline.ratchet, (path) => list(ratchet[path] ?? []).join("\n    "));
  expect(worse, "a banned name in an old-screen file that is not already on the ratchet. New code uses the new names (README section 7); a file on a strict surface belongs to that surface").toEqual([]);

  if (process.env.UPDATE_UI_NAMES_RATCHET) {
    const s = scanned();
    const next: Ratchet = {
      ratchet: lowered(baseline.ratchet, countsOf(Object.values(s.ratchet).flat())),
      strict: lowered(baseline.strict, countsOf(SURFACES.flatMap((surface) => s.strict[surface.id]))),
      titles: lowered(baseline.titles, countsOf(s.strict.titles)),
    };
    writeFileSync(RATCHET, JSON.stringify(next, null, 2) + "\n");
  } else {
    expect(better, "fewer than the ratchet: lower it with UPDATE_UI_NAMES_RATCHET=1 so the slack cannot be spent on a new name").toEqual([]);
  }
});

test("RATCHET · every entry has a deletion date and an owner, and none has run out", () => {
  const baseline = ratchetFile();
  const { ratchet } = scanned();
  for (const section of ["ratchet", "strict", "titles"] as const) {
    expect(shapeProblems(baseline[section]), `${section}: each entry needs { count > 0, until: YYYY-MM-DD, by: who removes it }, from docs/old-design-inventory.md or the D0 PR`).toEqual([]);
  }
  expect(expired(baseline.ratchet, countsOf(Object.values(ratchet).flat())), "past its deletion date: remove the names, or the owner moves the date in the same PR with a reason").toEqual([]);
});

test("RATCHET · a strict-surface file is only in the strict section, and an old-screen file only in the ratchet", () => {
  const baseline = ratchetFile();
  const onSurface = (path: string) => SURFACES.some((surface) => surface.claims(path));
  expect(Object.keys(baseline.ratchet).filter(onSurface), "on a strict surface: move it to the strict section").toEqual([]);
  expect(Object.keys(baseline.strict).filter((path) => !onSurface(path)), "not on a strict surface: move it to the ratchet section").toEqual([]);
  expect(Object.keys(baseline.titles).filter(onSurface), "a page title on a strict surface is counted with that surface").toEqual([]);
});

test("RATCHET · no section is bigger than where this branch left main", () => {
  const then = onMain<Ratchet>(RATCHET);
  test.skip(then === null, "no origin/main with the ratchet in this checkout (a shallow CI clone, or not on main yet): nothing to compare with");
  const now = ratchetFile();
  for (const section of ["ratchet", "strict", "titles"] as const) {
    expect(growth(now[section], then![section]), `${section}: files added, counts raised or dates moved later`).toEqual({ added: [], raised: [], later: [] });
  }
});

test("the ratchet's own arithmetic: a deletion date that has passed is read in UTC and is inclusive of that day", () => {
  const was = process.env.RATCHET_TODAY;
  try {
    process.env.RATCHET_TODAY = "2026-10-08";
    expect(past("2026-10-08")).toBe(false);
    process.env.RATCHET_TODAY = "2026-10-09";
    expect(past("2026-10-08")).toBe(true);
  } finally {
    if (was === undefined) delete process.env.RATCHET_TODAY;
    else process.env.RATCHET_TODAY = was;
  }
});
