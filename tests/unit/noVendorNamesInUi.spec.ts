import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { AUDIO_LABELS, MODELS, displayModelName, shortLabel } from "../../lib/models";
import { ATOMIK_MODEL_IDS } from "../../lib/atomikModelPolicy";
import { PROVIDERS } from "../../lib/providers";
import { VENDOR_KEYS } from "../../lib/vendorKeys";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import { parseConnectedCatalogue } from "../../lib/higgsfield-consumer/catalogue";
import { hasVendorName, neutralModelText, providerDisplayName, vendorNameIn } from "../../lib/vendorNames";

/**
 * No vendor or competitor name is visible in the product (owner decision,
 * 19 September 2026). Internal ids, API paths, env vars and code identifiers
 * keep their names; what a person reads does not.
 *
 * Legal pages must name sub-processors and are exempt.
 */
const ROOT = path.resolve(__dirname, "../..");
const EXEMPT = [
  /^app\/\(app\)\/(privacy|terms|policy)\//,
  /^app\/api\//,
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

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".tsx") ? [full] : [];
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

function scan(file: string): Hit[] {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
    const name = vendorNameIn(text);
    if (name) hits.push({ where: `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text: text.trim().slice(0, 120), name });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
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
  const scanned = [...files(path.join(ROOT, "components")), ...files(path.join(ROOT, "app"))]
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
