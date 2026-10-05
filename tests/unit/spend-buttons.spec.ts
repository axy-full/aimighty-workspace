import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { scanSpend, type SpendReport } from "../helpers/spendScan";
import { SPEND_SURFACES, gapsByFile, spendSurfaceOf } from "../helpers/spendSurfaces";
import { compare, expired, growth, lowered, onMain, readJson, shapeProblems, type Section } from "../helpers/ratchet";
import { NOT_SPENDING, PAID_ROUTES, SPEND_LABEL, SPEND_MARKERS, routePattern } from "../helpers/paidRoutes";
import { hasCreditFigure, priceLabel, spendAttrs } from "../../lib/spend";
import { SpendButton } from "../../components/graphite/SpendButton";

/**
 * Every button that spends shows a price in credits (owner's D0 review, item 13).
 *
 * How it works (how a new paid button opts in: docs/ui-checks.md):
 *  - A paid control carries `data-spend` (through <SpendButton> or {...spendAttrs(price)}) and its text carries a
 *    credit figure: "N cr", "up to N cr", "about N cr, at most 3N cr" or "free". With no price it is disabled.
 *  - tests/helpers/paidRoutes.ts lists the routes that spend. A test below closes that list against the server: a route
 *    whose source carries a spend marker has to be listed (or excused, with a reason).
 *  - tests/helpers/spendScan.ts follows every string that names a paid route, through helpers and hooks and across
 *    files, to the component files that can spend. Each must carry the opt-in. A button whose own label is a spend verb
 *    (Make, Render, Recreate, Again…) must carry it too.
 *  - tests/spend-buttons-workbench.spec.ts checks the rendered pages, one element at a time.
 *
 * STRICT SURFACES (the Make panel and quick tools, the model sheet, Make › Recent, the right-click menu, the board's paid actions)
 * allow nothing. What the D0 pull requests have not yet fixed is allowed per file in tests/unit/spend-ratchet.json ("strict" section,
 * by: D0, until: Thu 8 Oct), so this spec is green on main, can never get worse, and fails on the date. Every other file is on the
 * "ratchet" section with a count, a date and an owner from docs/old-design-inventory.md ("Thu 8 Oct" for what the board PR deletes).
 * A file moves off by marking its paid button; then UPDATE_SPEND_RATCHET=1 lowers the count. The list per PR of what remains:
 * S/demo/ci-checks-d0-heads.md.
 */

const ROUTE_DIR = "app/api";
const routeFiles = () =>
  spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", `${ROUTE_DIR}/**/route.ts`], { encoding: "utf8", maxBuffer: 1 << 26 })
    .stdout.split("\n").filter((path) => path && existsSync(path))
    .map((path) => path.slice(ROUTE_DIR.length + 1, -"/route.ts".length));

test("the paid-route list is closed against the server: a route that can spend is listed, or excused with a reason", () => {
  const routes = routeFiles();
  const listed = new Set(PAID_ROUTES.map((route) => route.dir));
  expect(PAID_ROUTES.filter((route) => !routes.includes(route.dir)).map((route) => route.dir), "listed routes that do not exist").toEqual([]);
  expect(Object.keys(NOT_SPENDING).filter((dir) => !routes.includes(dir)), "excused routes that do not exist").toEqual([]);
  expect(Object.keys(NOT_SPENDING).filter((dir) => listed.has(dir)), "a route is paid or excused, not both").toEqual([]);
  expect(Object.entries(NOT_SPENDING).filter(([, why]) => why.trim().length < 12).map(([dir]) => dir), "each excuse says why").toEqual([]);
  const unknown = routes.filter((dir) => SPEND_MARKERS.test(readFileSync(`${ROUTE_DIR}/${dir}/route.ts`, "utf8")) && !listed.has(dir) && !(dir in NOT_SPENDING));
  expect(unknown, "these routes can spend or price a spend and are neither in PAID_ROUTES nor in NOT_SPENDING (tests/helpers/paidRoutes.ts)").toEqual([]);
});

test("a client string names a paid route: ids, templates, queries; quotes and reads are not paid", () => {
  const generate = routePattern("generate");
  expect(generate.test("/api/generate")).toBe(true);
  expect(generate.test("/api/generate?x=1")).toBe(true);
  expect(generate.test("/api/generate/quote")).toBe(false);
  expect(generate.test("/api/generate/check")).toBe(false);
  const release = routePattern("jobs/[id]/release");
  expect(release.test("/api/jobs/{}/release")).toBe(true);
  expect(release.test("/api/jobs/{}")).toBe(false);
  expect(routePattern("atomik/steps/[id]/claim").test("/api/atomik/steps/{}/claim")).toBe(true);
  expect(routePattern("audio").test("/api/audio/voices")).toBe(false);
});

/* ---------------------------------------------------------------------------------------------- */
/* The scanner, on fixtures                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function scanFixture(files: Record<string, string>): SpendReport {
  return scanSpend(Object.keys(files), (path) => files[path]);
}

test("the scan follows a paid route through a helper and a hook, across files, to the component with the button", () => {
  const report = scanFixture({
    "lib/send.ts": `export async function send(body: unknown) { return fetch("/api/generate", { method: "POST", body: JSON.stringify(body) }); }`,
    "lib/use-make.ts": `import { send } from "./send";\nexport function useMake() { return { make: () => send({}) }; }`,
    "components/Make.tsx": `import { useMake } from "@/lib/use-make";\nexport function Make() { const m = useMake(); return <button onClick={m.make}>Go</button>; }`,
    "components/Plain.tsx": `export function Plain() { return <button onClick={() => {}}>Close</button>; }`,
  });
  expect(report.sites.map((site) => [site.path, site.routes, site.optedIn])).toEqual([["components/Make.tsx", ["generate"], false]]);
  expect(report.sites[0].chains.generate.length).toBe(3);
});

test("the scan reads a URL constant, a template with a hole, and a re-export", () => {
  const report = scanFixture({
    "lib/urls.ts": `export const RELEASE = "/api/jobs/x/release";\nexport const release = (id: string) => fetch(\`/api/jobs/\${id}/release\`, { method: "POST" });`,
    "lib/index.ts": `export { release } from "./urls";`,
    "components/A.tsx": `import { release } from "@/lib/index";\nexport function A() { return <button onClick={() => release("1")}>Release</button>; }`,
  });
  expect(report.sites.map((site) => [site.path, site.routes])).toEqual([["components/A.tsx", ["jobs/[id]/release"]]]);
});

test("the scan does not follow rendering a component, reading a table, a quote, or a file with nothing to press", () => {
  const report = scanFixture({
    "lib/send.ts": `export const TABLE = { gen: "/api/generate" };\nexport const quote = () => fetch("/api/generate/quote");`,
    "components/Child.tsx": `import { send } from "@/lib/send2";\nexport function Child() { return <button onClick={() => send()}>Go</button>; }`,
    "lib/send2.ts": `export const send = () => fetch("/api/audio", { method: "POST" });`,
    "components/Parent.tsx": `import { Child } from "./Child";\nexport function Parent() { return <section><Child /></section>; }`,
    "components/Reader.tsx": `import { TABLE, quote } from "@/lib/send";\nexport function Reader() { quote(); return <button onClick={() => console.log(Object.keys(TABLE))}>Show</button>; }`,
    "components/Provider.tsx": `import { send } from "@/lib/send2";\nexport function Provider({ children }: { children: unknown }) { send(); return <div>{children as never}</div>; }`,
  });
  expect(report.sites.map((site) => site.path)).toEqual(["components/Child.tsx"]);
});

test("the opt-in is read: data-spend, spendAttrs, SpendButton; and a spend verb on a button without it is caught", () => {
  const files = {
    "lib/send.ts": `export const send = () => fetch("/api/generate", { method: "POST" });`,
    "components/A.tsx": `import { send } from "@/lib/send";\nexport function A() { return <button data-spend="priced" onClick={send}>Make · 4 cr</button>; }`,
    "components/B.tsx": `import { send } from "@/lib/send";\nimport { spendAttrs } from "@/lib/spend";\nexport function B() { return <button {...spendAttrs(null)} onClick={send}>x</button>; }`,
    "components/C.tsx": `import { send } from "@/lib/send";\nimport { SpendButton } from "@/components/graphite/SpendButton";\nexport function C() { return <SpendButton label="Make" price={null} onClick={send} />; }`,
    "components/D.tsx": `import { send } from "@/lib/send";\nexport function D() { return <div><button onClick={send}>Make</button><button>Cancel</button><button data-spend="priced">Render · 2 cr</button></div>; }`,
  };
  const report = scanFixture(files);
  expect(report.sites.map((site) => [site.path, site.optedIn])).toEqual([["components/A.tsx", true], ["components/B.tsx", true], ["components/C.tsx", true], ["components/D.tsx", true]]);
  expect(report.labels.map((hit) => [hit.path, hit.label])).toEqual([["components/D.tsx", "Make"]]);
});

test("the spend verbs: the labels of paid buttons, and not the words that are free elsewhere", () => {
  for (const label of ["Make", "Make · 43 cr", "Generate", "Render", "Recreate", "Again", "Again · 1 cr", "Upscale video", "Transfer motion", "Swap object", "Release", "Train identity", "Approve & run"]) expect(SPEND_LABEL.test(label), label).toBe(true);
  for (const label of ["Cancel", "Retry", "Run", "Send", "Maker", "Make member", "Make admin", "Try again", "Save", "Delete"]) expect(SPEND_LABEL.test(label), label).toBe(false);
});

/* ---------------------------------------------------------------------------------------------- */
/* The price on the control                                                                        */
/* ---------------------------------------------------------------------------------------------- */

test("a price reads as a credit figure: N cr, up to N cr, about N cr at most 3N cr, free; never a bare number or quoted", () => {
  expect(priceLabel({ cr: 43 })).toBe("43 cr");
  expect(priceLabel({ cr: 1234 })).toBe("1,234 cr");
  expect(priceLabel({ upTo: 69 })).toBe("up to 69 cr");
  expect(priceLabel({ cr: 40, atMost: 120 })).toBe("about 40 cr, at most 120 cr");
  expect(priceLabel("free")).toBe("free");
  expect(priceLabel({ cr: 0 })).toBe("free");
  for (const none of [null, undefined, { cr: Number.NaN }, { cr: -1 }] as never[]) expect(priceLabel(none)).toBeNull();
  for (const text of ["Make · 43 cr", "up to 69 cr", "Transfer motion · up to 69 cr", "about 40 cr, at most 120 cr", "Again · free", "1,234 cr"]) expect(hasCreditFigure(text), text).toBe(true);
  for (const text of ["Make", "Make · quoted", "Make · 43", "43 credits", "Make · $4.30", ""]) expect(hasCreditFigure(text), text).toBe(false);
});

/** The element SpendButton returns, read as data (this runner compiles JSX to plain objects, so nothing is rendered). */
function shown(props: Parameters<typeof SpendButton>[0]) {
  const root = SpendButton(props) as unknown as { type: string; props: Record<string, unknown> };
  const text = (node: unknown): string => {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text((node as { props?: { children?: unknown } }).props?.children);
  };
  expect(root.type).toBe("button");
  return { props: root.props, text: text(root.props.children) };
}

test("a control with no price is disabled and says so; a priced one carries the figure", () => {
  expect(spendAttrs(null)).toEqual({ "data-spend": "unpriced", disabled: true });
  expect(spendAttrs({ cr: 43 })).toEqual({ "data-spend": "priced", "data-spend-price": "43 cr" });

  const priced = shown({ label: "Make", price: { cr: 43 } });
  expect(priced.props["data-spend"]).toBe("priced");
  expect(priced.props["data-spend-price"]).toBe("43 cr");
  expect(priced.props["aria-label"]).toBe("Make · 43 cr");
  expect(priced.props.disabled).toBeFalsy();
  expect(priced.text).toContain("Make");
  expect(priced.text).toContain("43 cr");
  const unpriced = shown({ label: "Make", price: null });
  expect(unpriced.props["data-spend"]).toBe("unpriced");
  expect(unpriced.props.disabled).toBe(true);
  const busy = shown({ label: "Make", price: { cr: 43 }, busy: true });
  expect(busy.props.disabled).toBe(true);
  expect(busy.props["aria-busy"]).toBe(true);
});

/* ---------------------------------------------------------------------------------------------- */
/* The repository as it stands: strict D0 surfaces, then the dated ratchet.                        */
/* ---------------------------------------------------------------------------------------------- */

const RATCHET = "tests/unit/spend-ratchet.json";
type Ratchet = { ratchet: Section; strict: Section };
const ratchetFile = (): Ratchet => readJson<Ratchet>(RATCHET);

let report: SpendReport | null = null;
const current = () => (report ??= scanSpend());

const describe = (path: string) => {
  const site = current().sites.find((s) => s.path === path);
  const labels = current().labels.filter((l) => l.path === path).map((l) => `${path}:${l.line} button "${l.label}" has no data-spend`);
  return [...(site && !site.optedIn ? [`reaches ${site.routes.join(", ")} via ${site.declarations.slice(0, 3).join(", ")} and carries no data-spend or SpendButton`] : []), ...labels].join("\n    ");
};

for (const surface of SPEND_SURFACES) {
  test(`STRICT · ${surface.name}: every button that spends shows its price (what D0 has not fixed yet is allowed per file, and falls to zero on its date)`, () => {
    const gaps = gapsByFile(current());
    const mine = (path: string) => spendSurfaceOf(path)?.id === surface.id;
    const now = Object.fromEntries(Object.entries(gaps).filter(([path]) => mine(path)));
    const allowed = Object.fromEntries(Object.entries(ratchetFile().strict).filter(([path]) => mine(path)));
    const { worse, better } = compare(now, allowed, describe);
    expect(worse, `${surface.name}: a paid control with no price marker that is not already allowed until D0 lands. Use <SpendButton price> or {...spendAttrs(price)} (docs/ui-checks.md)`).toEqual([]);
    expect(expired(allowed, now), `past the date: ${surface.name} must have a price on every control that spends`).toEqual([]);
    if (!process.env.UPDATE_SPEND_RATCHET) expect(better, "fewer than allowed: lower the allowance (UPDATE_SPEND_RATCHET=1) so the slack cannot be spent on a new gap").toEqual([]);
  });
}

test("RATCHET · other files: a file that reaches a paid route or labels a button with a spend verb does not gain a gap, and the counts only go down", () => {
  const baseline = ratchetFile();
  const gaps = gapsByFile(current());
  const others = Object.fromEntries(Object.entries(gaps).filter(([path]) => !spendSurfaceOf(path)));
  const { worse, better } = compare(others, baseline.ratchet, describe);
  expect(worse, "a paid control with no price marker in a file that is not already on the ratchet. Mark it: <SpendButton price> or {...spendAttrs(price)} (docs/ui-checks.md)").toEqual([]);

  if (process.env.UPDATE_SPEND_RATCHET) {
    const next: Ratchet = {
      ratchet: lowered(baseline.ratchet, others),
      strict: lowered(baseline.strict, Object.fromEntries(Object.entries(gaps).filter(([path]) => spendSurfaceOf(path)))),
    };
    writeFileSync(RATCHET, JSON.stringify(next, null, 2) + "\n");
  } else {
    expect(better, "fewer than the ratchet: lower it with UPDATE_SPEND_RATCHET=1 so the slack cannot be spent on a new gap").toEqual([]);
  }
});

test("RATCHET · every entry has a date and an owner, and none has run out", () => {
  const baseline = ratchetFile();
  for (const section of ["ratchet", "strict"] as const) expect(shapeProblems(baseline[section]), `${section}: each entry needs { count > 0, until: YYYY-MM-DD, by }`).toEqual([]);
  const gaps = gapsByFile(current());
  expect(expired(baseline.ratchet, gaps), "past its date: price the buttons, or the owner moves the date in the same PR with a reason").toEqual([]);
});

test("RATCHET · a strict-surface file is only in the strict section, and any other file only in the ratchet", () => {
  const baseline = ratchetFile();
  expect(Object.keys(baseline.ratchet).filter((path) => spendSurfaceOf(path)), "on a strict surface: move it to the strict section").toEqual([]);
  expect(Object.keys(baseline.strict).filter((path) => !spendSurfaceOf(path)), "not on a strict surface: move it to the ratchet section").toEqual([]);
});

test("RATCHET · no section is bigger than where this branch left main", () => {
  const then = onMain<Ratchet>(RATCHET);
  test.skip(then === null, "no origin/main with the ratchet in this checkout (a shallow CI clone, or not on main yet): nothing to compare with");
  const now = ratchetFile();
  for (const section of ["ratchet", "strict"] as const) expect(growth(now[section], then![section]), `${section}: files added, counts raised or dates moved later`).toEqual({ added: [], raised: [], later: [] });
});
