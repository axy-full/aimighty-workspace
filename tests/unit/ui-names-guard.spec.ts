import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { bannedNamesIn } from "../helpers/uiStrings";
import { SURFACES, format, manifestStrings, scanAll, type Hit, type Scan } from "../helpers/uiSurfaces";

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
 * THE STRICT TESTS ARE EXPECTED TO FAIL until the D0 fixes and the board PR land: their failure message is the list of
 * names still to remove. They are not weakened, and nothing is added to the strict surfaces to make them pass.
 *
 * After removing names: UPDATE_UI_NAMES_RATCHET=1 npx playwright test tests/unit/ui-names-guard.spec.ts --project=unit
 * lowers the ratchet (never raises it, never adds a file).
 */

const RATCHET = "tests/unit/ui-names-ratchet.json";
type Entry = { count: number; until: string; by: string };
type Ratchet = Record<string, Entry>;
const ratchetFile = (): Ratchet => JSON.parse(readFileSync(RATCHET, "utf8"));

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
/* STRICT: zero allowed. Failing today: this is the list the D0 fix agents clear.                  */
/* ---------------------------------------------------------------------------------------------- */

for (const surface of SURFACES) {
  test(`STRICT (zero allowed, fails until the D0 fixes land) · ${surface.name}: no banned name in any UI string`, () => {
    const hits = list(scanned().strict[surface.id]);
    expect(hits, `${hits.length} banned names on ${surface.name}. Remove each one (README section 7 has the new names):`).toEqual([]);
  });
}

test("STRICT (zero allowed, fails until the D0 fixes land) · page titles: no banned name in a <title>, metadata or document.title, in any file", () => {
  const hits = list(scanned().strict.titles);
  expect(hits, `${hits.length} banned names in page titles (the browser tab and the history list):`).toEqual([]);
});

test("STRICT (zero allowed, fails until the D0 fixes land) · public/manifest.json: the name and description on a phone's home screen", () => {
  const bad = manifestStrings().flatMap(({ path, text }) => bannedNamesIn("manifest.ts", `export const x = ${JSON.stringify(text)};`).map((hit) => `${path} [${hit.word}] ${text}`));
  expect(bad, "banned names in the web manifest").toEqual([]);
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

/** Today at the end of the day in UTC, or the day a test pretends it is. */
const today = () => (process.env.UI_NAMES_TODAY ? new Date(process.env.UI_NAMES_TODAY + "T23:59:59Z") : new Date());
const past = (until: string) => new Date(until + "T23:59:59Z").getTime() < today().getTime();

test("RATCHET · old-screen files: a banned name never appears in a new place, and the counts only go down", () => {
  const baseline = ratchetFile();
  const { ratchet } = scanned();
  const worse: string[] = [];
  const better: string[] = [];
  for (const path of [...new Set([...Object.keys(ratchet), ...Object.keys(baseline)])].sort()) {
    const now = ratchet[path]?.length ?? 0;
    const was = baseline[path]?.count ?? 0;
    if (now > was) worse.push(`${path}: ${was} -> ${now}\n    ${list(ratchet[path]).join("\n    ")}`);
    else if (now < was) better.push(`${path}: ${was} -> ${now}`);
  }
  expect(worse, "a banned name in an old-screen file that is not already on the ratchet. New code uses the new names (README section 7); a file on a strict surface belongs to that surface").toEqual([]);

  if (process.env.UPDATE_UI_NAMES_RATCHET) {
    const next: Ratchet = {};
    for (const [path, entry] of Object.entries(baseline)) {
      const now = ratchet[path]?.length ?? 0;
      if (now > 0) next[path] = { ...entry, count: Math.min(entry.count, now) };
    }
    writeFileSync(RATCHET, JSON.stringify(next, null, 2) + "\n");
  } else {
    expect(better, "fewer than the ratchet: lower it with UPDATE_UI_NAMES_RATCHET=1 so the slack cannot be spent on a new name").toEqual([]);
  }
});

test("RATCHET · every entry has a deletion date and an owner, and none has run out", () => {
  const baseline = ratchetFile();
  const { ratchet } = scanned();
  const shape = Object.entries(baseline).filter(([, e]) => !/^\d{4}-\d{2}-\d{2}$/.test(e.until) || !e.by?.trim() || !(e.count > 0)).map(([path]) => path);
  expect(shape, "each ratchet entry needs { count > 0, until: YYYY-MM-DD, by: who deletes it }, from docs/old-design-inventory.md").toEqual([]);
  const expired = Object.entries(baseline)
    .filter(([path, e]) => past(e.until) && (ratchet[path]?.length ?? 0) > 0)
    .map(([path, e]) => `${path}: still has ${ratchet[path].length} banned names after ${e.until} (${e.by})`);
  expect(expired, "past its deletion date: remove the names, or the owner moves the date in the same PR with a reason").toEqual([]);
});

test("RATCHET · a strict-surface file is never on the ratchet", () => {
  const both = Object.keys(ratchetFile()).filter((path) => SURFACES.some((surface) => surface.claims(path)));
  expect(both, "these files are on a strict surface: zero is the only allowance, so take them off the ratchet").toEqual([]);
});

test("RATCHET · the file is no bigger than where this branch left main", () => {
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" });
  test.skip(base.status !== 0, "no origin/main in this checkout (a shallow CI clone): nothing to compare with");
  const before = spawnSync("git", ["show", `${base.stdout.trim()}:${RATCHET}`], { encoding: "utf8", maxBuffer: 1 << 24 });
  test.skip(before.status !== 0, "the ratchet does not exist yet on main");
  const then: Ratchet = JSON.parse(before.stdout);
  const now = ratchetFile();
  const added = Object.keys(now).filter((path) => !(path in then));
  const raised = Object.entries(now).filter(([path, e]) => path in then && e.count > then[path].count).map(([path, e]) => `${path}: ${then[path].count} -> ${e.count}`);
  const later = Object.entries(now).filter(([path, e]) => path in then && e.until > then[path].until).map(([path, e]) => `${path}: ${then[path].until} -> ${e.until}`);
  expect({ added, raised, later }, "files added, counts raised or dates moved later").toEqual({ added: [], raised: [], later: [] });
});

test("the ratchet's own arithmetic: a deletion date that has passed is read in UTC and is inclusive of that day", () => {
  const was = process.env.UI_NAMES_TODAY;
  try {
    process.env.UI_NAMES_TODAY = "2026-10-08";
    expect(past("2026-10-08")).toBe(false);
    process.env.UI_NAMES_TODAY = "2026-10-09";
    expect(past("2026-10-08")).toBe(true);
  } finally {
    if (was === undefined) delete process.env.UI_NAMES_TODAY;
    else process.env.UI_NAMES_TODAY = was;
  }
});
