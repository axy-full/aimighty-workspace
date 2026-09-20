import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { AUDIO_LABELS, MODELS, displayModelName, shortLabel } from "../../lib/models";
import { ATOMIK_MODEL_IDS } from "../../lib/atomikModelPolicy";
import { PROVIDERS } from "../../lib/providers";
import { VENDOR_KEYS } from "../../lib/vendorKeys";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import { parseConnectedCatalogue } from "../../lib/higgsfield-consumer/catalogue";
import { connectedFamilyNameIn, hasVendorName, neutralModelText, providerDisplayName, vendorNameIn } from "../../lib/vendorNames";
import { vendorNameIn as workspaceVendorNameIn } from "../../lib/workspace/vendor-names";

/**
 * The naming rule, guarded (owner decision, 20 September 2026 — it reverses
 * part of #231 for MODEL names only; the rule itself is written out in
 * lib/vendorNames.ts).
 *
 * What this file bans is the CONNECTED-ACCOUNT vocabulary and nothing else:
 * the connected account, its own brands (Higgsfield, Supercomputer, Genjutsu,
 * Soul ID) and the provider companies that are not part of any model's real
 * name (BytePlus, ModelArk, fal, Vercel).
 *
 * It no longer flags a DIRECT model's real name. "Seedance 2.5", "Kling 3.0
 * Pro", "Nano Banana 2", "Eleven v3", "Claude Fable 5.1" and "GPT-6 Astra"
 * are what those engines are called, and the product says so. The connected
 * account's catalogue is the other half of the rule, checked separately below:
 * its families are still renamed, so the same family can read "Seedance 2.5"
 * on our surface and "Motion 2.5" on the connected one.
 *
 * Internal ids, API paths, env vars and code identifiers keep every name, and
 * legal pages must name sub-processors, so they are exempt.
 */
const ROOT = path.resolve(__dirname, "../..");

/**
 * Files whose banned names are not copy at all.
 *
 * Legal pages must name sub-processors. Prompt files are read by an engine,
 * not by a person, and a prompt that steers one engine has to name it. The
 * generated Python and the local-install package name the program the reader
 * installs and runs. The banned list itself obviously contains the names.
 */
const EXEMPT = [
  /^app\/\(app\)\/(privacy|terms|policy)\//,
  /^lib\/enhance\.ts$/,
  /^lib\/astra-blender\/agent\.ts$/,
  /^app\/api\/atomik\/shots\/draft\/route\.ts$/,
  /^lib\/astra-blender\/(blender-export|sandbox|render-storage)\.ts$/,
  /^lib\/vendorNames\.ts$/,
  /^lib\/workspace\/vendor-names\.ts$/,
];
/** Visible copy that contains a banned word for a reason other than naming a vendor. */
const ALLOWED_COPY = [
  "WebM · VP9 or VP8 / Opus", // the Opus audio codec, not a model
  // The README inside the downloaded scene package: a local install guide
  // must name the program the person installs and runs. Not product UI.
  "blender --background --factory-startup",
];
/** Attributes a person never reads. */
const HIDDEN_ATTRIBUTES = new Set([
  "className", "key", "id", "href", "src", "style", "type", "name", "rel", "target", "role", "htmlFor",
  "action", "method", "accept", "autoComplete", "poster", "sizes", "srcSet", "form", "ref", "download",
  "aria-controls", "aria-describedby", "aria-labelledby", "aria-owns", "aria-activedescendant",
]);
/** Object properties that hold machinery, not copy: never rendered. */
const HIDDEN_PROPERTIES = new Set([
  "sql", "prompt", "system", "instructions", "missingBackend",
]);
/** SQL and schema text: a column default or a provider filter is a DB value. */
const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|COALESCE|json_extract|json_set|CASE\s+WHEN|PRIMARY\s+KEY|NOT\s+NULL|\bAND\s+\w+(\.\w+)?\s*=)/;
/** A bare path or url: API paths keep their vendor names. A word on its own
 *  is NOT pathlike — a one-word label is exactly the leak this guard is for. */
const PATHLIKE = /^\S*\/\S*$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(full) ? [full] : [];
  });
}

type Hit = { where: string; text: string; name: string };

/** Strings an expression can put on screen: literals, template text, both arms of a choice. */
function visibleStrings(node: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node);
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head);
    for (const span of node.templateSpans) { out.push(span.literal); visibleStrings(span.expression, out); }
  } else if (ts.isConditionalExpression(node)) { visibleStrings(node.whenTrue, out); visibleStrings(node.whenFalse, out); }
  else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) visibleStrings(node.left, out);
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) visibleStrings(node.right, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) { if (node.expression) visibleStrings(node.expression, out); }
  else if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element) => visibleStrings(element, out));
  return out;
}

function literalText(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return "";
}

/** console.* output is for us, not for a person using the product. */
function isLogCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText() === "console";
}

function propertyName(node: ts.Node): string | null {
  if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    const name = node.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

function scan(file: string): Hit[] {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const seen = new Set<number>();
  const check = (node: ts.Node, prose = false) => {
    if (seen.has(node.getStart())) return;
    seen.add(node.getStart());
    const text = literalText(node);
    // Outside JSX, only prose and capitalised labels are copy; lowercase
    // tokens (ids, paths, query strings) are not.
    const template = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const copy = template ? /\s/.test(text) : /[A-Za-z]\s+[A-Za-z]/.test(text) || /^[A-Z]/.test(text.trim());
    if (!text || (prose && !copy)) return;
    if (ALLOWED_COPY.some((allowed) => text.includes(allowed))) return;
    if (SQL.test(text) || PATHLIKE.test(text.trim())) return;
    const name = vendorNameIn(text);
    if (name) hits.push({ where: `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text: text.trim().slice(0, 120), name });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (isLogCall(node)) return;
    const property = propertyName(node);
    if (property && HIDDEN_PROPERTIES.has(property)) return;
    if (ts.isJsxText(node)) check(node);
    else if (ts.isJsxAttribute(node)) {
      const attribute = node.name.getText(source);
      if (!HIDDEN_ATTRIBUTES.has(attribute) && !attribute.startsWith("data-") && !attribute.startsWith("on") && node.initializer)
        visibleStrings(node.initializer).forEach((literal) => check(literal));
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && node.expression)
      visibleStrings(node.expression).forEach((literal) => check(literal));
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      check(node, true); // toasts, errors, copy tables
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

test("no connected-account name in component, page or lib copy", () => {
  const scanned = [...files(path.join(ROOT, "components")), ...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "lib"))]
    .filter((file) => !EXEMPT.some((pattern) => pattern.test(path.relative(ROOT, file).split(path.sep).join("/"))));
  expect(scanned.length).toBeGreaterThan(100);
  const hits = scanned.flatMap(scan);
  expect(hits.map((hit) => `${hit.where} [${hit.name}] ${hit.text}`)).toEqual([]);
});

test("the guard bans the connected-account vocabulary, and only that", () => {
  expect(vendorNameIn("Connect your Higgsfield account")).toBe("Higgsfield");
  expect(vendorNameIn("Soul-ID ready")).toBe("Soul-ID");
  expect(vendorNameIn("Genjutsu quote")).toBe("Genjutsu");
  expect(vendorNameIn("Supercomputer parity")).toBe("Supercomputer");
  expect(vendorNameIn("Billed by ModelArk")).toBe("ModelArk");
  expect(vendorNameIn("Served on fal")).toBe("fal");
  expect(vendorNameIn("Set VERCEL_TOKEN in Vercel")).toBe("Vercel");
  /* A direct model's real name is required copy, not a leak. */
  for (const name of ["Seedance 2.5", "Kling 3.0 Pro", "Nano Banana 2", "Topaz Astra 2",
    "Luma Ray 2", "Bria Expand", "Flux · Identity", "Eleven Multilingual v2",
    "Claude Fable 5.1", "Claude Opus 5", "GPT-6 Astra", "Gemini 3.1 Pro Preview"])
    expect(hasVendorName(name), name).toBe(false);
  expect(hasVendorName("eleven takes, twelve months of runway")).toBe(false);
  expect(hasVendorName("Seedance 2.5 · connected credits · 3D runtime")).toBe(false);
});

/**
 * The shapes the guard used to walk straight past. Before this, it read only
 * .tsx files under components/ and app/, so every label table, stage hint,
 * plan line and thrown error under lib/ was invisible to it, and app/api was
 * exempt wholesale. It also parsed every file as TSX, which mangles generics
 * in a .ts file. Each sample below is a real leak and must be reported.
 *
 * The samples name the CONNECTED-ACCOUNT vocabulary, because that is what the
 * guard bans now; the shapes they exercise are the point, not the words.
 */
const LEAK_SAMPLES: [string, string, string][] = [
  ["stage hint in a lib label table", "sample.ts", `
    export const STAGES = [
      { id: "connected", label: "Generate", hint: "Shape your scene on Higgsfield" },
    ];
  `],
  ["array of option labels in a lib file", "sample.ts", `
    export const EFFORTS = ["Fast", "Balanced", "Supercomputer parity"];
  `],
  ["thrown error in a route", "sample.ts", `
    export function go() { throw new Error("Connect your Higgsfield account first."); }
  `],
  ["template literal with a name in the text", "sample.ts", `
    export const line = (n: number) => \`Rendering \${n} takes on ModelArk\`;
  `],
  ["a name after a generic call, which TSX parsing used to swallow", "sample.ts", `
    export const read = <T,>(v: T) => v;
    export const note = read<string>("Rendered on fal");
  `],
  ["JSX text", "sample.tsx", `
    export const C = () => <span>Genjutsu or Soul ID · model and effort</span>;
  `],
  ["a ternary arm inside JSX", "sample.tsx", `
    export const C = ({ on }: { on: boolean }) => <p>{on ? "Higgsfield is ready" : "Idle"}</p>;
  `],
  ["concatenated copy", "sample.tsx", `
    export const C = () => <p>{"Powered by " + "Higgsfield Supercomputer"}</p>;
  `],
  ["an aria-label", "sample.tsx", `
    export const C = () => <button aria-label="Open the Genjutsu viewport" />;
  `],
  ["a placeholder, title and alt", "sample.tsx", `
    export const C = () => <img title="Made with Higgsfield" alt="A Soul ID still" placeholder="Ask Supercomputer" />;
  `],
];

/** Shapes that are machinery, not copy: reporting these would make the guard noise. */
const QUIET_SAMPLES: [string, string, string][] = [
  ["a console line", "sample.ts", `
    export function go() { console.warn("stills: the Higgsfield door failed"); }
  `],
  ["SQL", "sample.ts", `
    export const sql = "SELECT id FROM generations WHERE provider='higgsfield' AND deleted=0";
  `],
  ["a schema default", "sample.ts", `
    export const ddl = "CREATE TABLE t (provider TEXT NOT NULL DEFAULT 'byteplus')";
  `],
  ["an API path", "sample.ts", `
    export const route = "/api/workbench/astra-blender/render";
  `],
];

test("the guard reads the shapes it used to walk past, and stays quiet on machinery", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vendor-guard-"));
  const hitsFor = (name: string, body: string) => {
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.${name.split(".").pop()}`);
    writeFileSync(file, body);
    return scan(file);
  };
  const missed = LEAK_SAMPLES.filter(([, name, body]) => hitsFor(name, body).length === 0).map(([label]) => label);
  expect(missed).toEqual([]);
  const noisy = QUIET_SAMPLES.filter(([, name, body]) => hitsFor(name, body).length > 0).map(([label]) => label);
  expect(noisy).toEqual([]);
});

test("one banned-name list, shared by the workspace redesign", () => {
  expect(workspaceVendorNameIn).toBe(vendorNameIn);
  for (const name of ["Higgsfield", "Supercomputer", "Genjutsu", "Soul ID", "BytePlus", "ModelArk", "fal", "Vercel"])
    expect(vendorNameIn(`Rendered with ${name} today`), name).not.toBeNull();
});

test("no model label anywhere names the connected account", () => {
  const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/connected-models.json"), "utf8")), 1);
  const ids = [
    ...MODELS.map((model) => model.id), ...Object.keys(AUDIO_LABELS), ...ATOMIK_MODEL_IDS,
    ...Object.values(GENJUTSU_MODELS), "marketing_studio_video", "hf_mult_motion_control", "hf_mult_replace_object",
    "dreamina-seedance-1-0-pro-250528", "claude-opus-5", "claude-sonnet-5", "seed-2-0-pro-250415", "google/veo-3.1-generate-001",
    ...catalogue.models.map((model) => model.id),
  ];
  const leaks = ids.flatMap((id) => [displayModelName(id), shortLabel(id)].filter(hasVendorName).map((name) => `${id} → ${name}`));
  const copy = [
    ...MODELS.flatMap((model) => [model.label, model.short, model.note ?? "", model.use ?? ""]),
    ...Object.values(AUDIO_LABELS).flatMap((label) => [label.label, label.short]),
    ...PROVIDERS.flatMap((provider) => [provider.label, provider.serves, provider.rateLimit ?? ""]),
    ...VENDOR_KEYS.flatMap((key) => [key.label, key.does]),
    ...["byteplus", "google", "fal", "elevenlabs", "vercel", "openai", "higgsfield", "higgsfield-consumer"].map(providerDisplayName),
  ].filter(hasVendorName);
  expect([...leaks, ...copy]).toEqual([]);
});

/**
 * The two halves of the rule, on the same families. A model we integrate
 * ourselves is named; the connected account's catalogue is not. Both are
 * produced by `displayModelName`, which decides by provenance.
 */
test("a direct model reads its real name and a connected-catalogue model reads a neutral one", () => {
  /* Direct: the real name, everywhere a person reads it. */
  expect(displayModelName("dreamina-seedance-2-5-260628")).toBe("Seedance 2.5");
  expect(displayModelName("dreamina-seedance-2-0-260128")).toBe("Seedance 2.0");
  expect(displayModelName("fal-ai/kling-video/v3/pro")).toBe("Kling 3.0 Pro");
  expect(displayModelName("gemini-3.1-flash-image")).toBe("Nano Banana 2");
  expect(displayModelName("gemini-3-pro-image")).toBe("Nano Banana Pro");
  expect(displayModelName("topaz/upscale/video/creative")).toBe("Topaz Astra 2");
  expect(displayModelName("fal-ai/luma-dream-machine/ray-2-flash/reframe")).toBe("Luma Ray 2");
  expect(displayModelName("fal-ai/bria/expand")).toBe("Bria Expand");
  expect(displayModelName("eleven_multilingual_v2")).toBe("Eleven Multilingual v2");
  expect(displayModelName("openai/gpt-6-astra")).toBe("GPT-6 Astra");
  expect(displayModelName("openai/gpt-5.5-pro")).toBe("GPT-5.5 Pro");
  expect(displayModelName("anthropic/claude-fable-5.1")).toBe("Claude Fable 5.1");
  expect(displayModelName("anthropic/claude-opus-5")).toBe("Claude Opus 5");
  expect(displayModelName("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5");
  expect(displayModelName("google/gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro Preview");
  /* A retired dated build of one of our own families keeps that family's name. */
  expect(displayModelName("dreamina-seedance-1-0-pro-250528")).toBe("Seedance 1.0");
  /* The same families, read from the connected account: neutral, by parse-time
     rename and by the id fallback alike. */
  const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/connected-models.json"), "utf8")), 1);
  const named = (id: string) => catalogue.models.find((model) => model.id === id)?.name;
  expect(named("nano_banana_2")).toBe("Image 2");
  expect(named("seedream_v5_pro")).toBe("Still 5.0 Pro");
  expect(named("soul_2")).toBe("Persona 2.0");
  expect(displayModelName("seedance_2_5")).not.toContain("Seedance");
  expect(displayModelName("soul_2")).not.toContain("Soul");
  const kept = catalogue.models.flatMap((model) =>
    [model.name, model.description, ...model.parameters.map((p) => p.description ?? ""), ...model.medias.map((m) => m.description ?? "")]
      .filter((text) => connectedFamilyNameIn(text) || hasVendorName(text)).map((text) => `${model.id}: ${text}`));
  expect(kept).toEqual([]);
  expect(neutralModelText("Seedance 2.0 Mini")).toBe("Motion 2.0 Mini");
});
