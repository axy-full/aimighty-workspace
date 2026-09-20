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
import { hasVendorName, neutralModelText, providerDisplayName, vendorNameIn } from "../../lib/vendorNames";
import { vendorNameIn as workspaceVendorNameIn } from "../../lib/workspace/vendor-names";

/**
 * No vendor or competitor name is visible in the product (owner decision,
 * 19 September 2026). Internal ids, API paths, env vars and code identifiers
 * keep their names; what a person reads does not.
 *
 * Legal pages must name sub-processors and are exempt.
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

test("no vendor or competitor name in component or page copy", () => {
  const scanned = [...files(path.join(ROOT, "components")), ...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "lib"))]
    .filter((file) => !EXEMPT.some((pattern) => pattern.test(path.relative(ROOT, file).split(path.sep).join("/"))));
  expect(scanned.length).toBeGreaterThan(100);
  const hits = scanned.flatMap(scan);
  expect(hits.map((hit) => `${hit.where} [${hit.name}] ${hit.text}`)).toEqual([]);
});

test("the guard itself catches names in JSX text, props and toasts", () => {
  expect(vendorNameIn("Render with Seedance 2.5")).toBe("Seedance");
  expect(vendorNameIn("GPT-6 Astra")).toBe("GPT");
  expect(vendorNameIn("Soul-ID ready")).toBe("Soul-ID");
  expect(vendorNameIn("Eleven Multilingual v2")).toBe("Eleven Multilingual");
  expect(hasVendorName("eleven takes, twelve months of runway")).toBe(false);
  expect(hasVendorName("Motion 2.5 · connected credits · 3D runtime")).toBe(false);
});

/**
 * The shapes the guard used to walk straight past. Before this, it read only
 * .tsx files under components/ and app/, so every label table, stage hint,
 * plan line and thrown error under lib/ was invisible to it, and app/api was
 * exempt wholesale. It also parsed every file as TSX, which mangles generics
 * in a .ts file. Each sample below is a real leak and must be reported.
 */
const LEAK_SAMPLES: [string, string, string][] = [
  ["stage hint in a lib label table", "sample.ts", `
    export const STAGES = [
      { id: "astra-blender", label: "Astra", hint: "Shape your scene with GPT-6 Astra" },
    ];
  `],
  ["array of option labels in a lib file", "sample.ts", `
    export const EFFORTS = ["Fast", "Balanced", "GPT-6 Astra"];
  `],
  ["thrown error in a route", "sample.ts", `
    export function go() { throw new Error("Connect your Higgsfield account first."); }
  `],
  ["template literal with a name in the text", "sample.ts", `
    export const line = (n: number) => \`Rendering \${n} takes on Seedance 2.5\`;
  `],
  ["a name after a generic call, which TSX parsing used to swallow", "sample.ts", `
    export const read = <T,>(v: T) => v;
    export const note = read<string>("Rendered by Kling 3.0 Pro");
  `],
  ["JSX text", "sample.tsx", `
    export const C = () => <span>Claude or ChatGPT · model and effort</span>;
  `],
  ["a ternary arm inside JSX", "sample.tsx", `
    export const C = ({ on }: { on: boolean }) => <p>{on ? "Blender is ready" : "Idle"}</p>;
  `],
  ["concatenated copy", "sample.tsx", `
    export const C = () => <p>{"Powered by " + "Topaz upscaling"}</p>;
  `],
  ["an aria-label", "sample.tsx", `
    export const C = () => <button aria-label="Open the Blender viewport" />;
  `],
  ["a placeholder, title and alt", "sample.tsx", `
    export const C = () => <img title="Made with Veo 3.1" alt="A Midjourney still" placeholder="Ask ChatGPT" />;
  `],
];

/** Shapes that are machinery, not copy: reporting these would make the guard noise. */
const QUIET_SAMPLES: [string, string, string][] = [
  ["a console line", "sample.ts", `
    export function go() { console.warn("stills: the Google door failed"); }
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
  for (const name of ["Seedance", "Higgsfield", "Wan", "fal", "Blender", "GPT", "Claude"])
    expect(vendorNameIn(`Rendered with ${name} today`), name).not.toBeNull();
});

test("every model the product can name has a neutral display name", () => {
  const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/connected-models.json"), "utf8")), 1);
  const ids = [
    ...MODELS.map((model) => model.id), ...Object.keys(AUDIO_LABELS), ...ATOMIK_MODEL_IDS,
    ...Object.values(GENJUTSU_MODELS), "marketing_studio_video", "hf_mult_motion_control", "hf_mult_replace_object",
    "dreamina-seedance-1-0-pro-250528", "claude-opus-5", "claude-sonnet-5", "seed-2-0-pro-250415", "google/veo-3.1-generate-001",
    ...catalogue.models.map((model) => model.id),
  ];
  const leaks = ids.flatMap((id) => [displayModelName(id), shortLabel(id)].filter(hasVendorName).map((name) => `${id} → ${name}`));
  const catalogueLeaks = catalogue.models.flatMap((model) =>
    [model.name, model.description, ...model.parameters.map((p) => p.description ?? ""), ...model.medias.map((m) => m.description ?? "")]
      .filter(hasVendorName).map((text) => `${model.id}: ${text}`));
  const copy = [
    ...MODELS.flatMap((model) => [model.label, model.short, model.note ?? "", model.use ?? ""]),
    ...Object.values(AUDIO_LABELS).flatMap((label) => [label.label, label.short]),
    ...PROVIDERS.flatMap((provider) => [provider.label, provider.serves, provider.rateLimit ?? ""]),
    ...VENDOR_KEYS.flatMap((key) => [key.label, key.does]),
    ...["byteplus", "google", "fal", "elevenlabs", "vercel", "openai", "higgsfield", "higgsfield-consumer"].map(providerDisplayName),
  ].filter(hasVendorName);
  expect([...leaks, ...catalogueLeaks, ...copy]).toEqual([]);
  expect(displayModelName("dreamina-seedance-2-5-260628")).toBe("Motion 2.5");
  expect(displayModelName("dreamina-seedance-2-0-260128")).toBe("Motion 2.0");
  expect(displayModelName("gemini-3.1-flash-image")).toBe("Image 2");
  expect(displayModelName("openai/gpt-6-astra")).toBe("Astra");
  expect(neutralModelText("Seedance 2.0 Mini")).toBe("Motion 2.0 Mini");
});
