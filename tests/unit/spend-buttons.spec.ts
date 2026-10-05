import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { scanSpend, type SpendReport } from "../helpers/spendScan";
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
 * THE TWO "TO-DO" TESTS ARE EXPECTED TO FAIL until the D0 fixes land: the failure message is the list of files and
 * buttons that still need a price. They are not weakened; a file moves off the list by marking its paid button.
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
  for (const label of ["Cancel", "Retry", "Run", "Send", "Maker", "Try again", "Save", "Delete"]) expect(SPEND_LABEL.test(label), label).toBe(false);
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
/* TO-DO: the repository as it stands. Failing until the D0 fixes land.                            */
/* ---------------------------------------------------------------------------------------------- */

let report: SpendReport | null = null;
const current = () => (report ??= scanSpend());

test("TO-DO (fails until the D0 fixes land) · every component file that can spend carries data-spend or SpendButton", () => {
  const missing = current().sites.filter((site) => !site.optedIn).map((site) => `${site.path}  reaches ${site.routes.join(", ")}  via ${site.declarations.slice(0, 3).join(", ")}`);
  expect(missing, `${missing.length} files reach a paid route and carry no data-spend. Mark each paid button with <SpendButton price=…> or {...spendAttrs(price)} (docs/ui-checks.md):`).toEqual([]);
});

test("TO-DO (fails until the D0 fixes land) · no button labelled with a spend verb is without data-spend", () => {
  const missing = current().labels.map((hit) => `${hit.path}:${hit.line}  "${hit.label}"`);
  expect(missing, `${missing.length} buttons are labelled Make, Render, Recreate, Again… and carry no price marker:`).toEqual([]);
});
