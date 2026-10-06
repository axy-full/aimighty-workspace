import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SITE_SUITES } from "../../lib/marketing/site";
import { retiredFindings } from "../helpers/retiredSignIn";

/**
 * The public site offers nothing that needs a Higgsfield sign-in (owner,
 * 28 September 2026; CLAUDE.md, ground rule 10). Every string its pages can
 * render is read from the source: string and template literals and JSX text,
 * never comments. That covers each page's copy, its title and description and
 * every screenshot's path and caption without a server.
 * tests/marketing-site-workbench.spec.ts checks the rendered pages the same way.
 */
const ROOTS = ["app/(marketing)", "components/marketing", "lib/marketing"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(at) : /\.tsx?$/.test(entry.name) ? [at] : [];
  });
}

/** What a file can put on a page: its string and template literals, and its JSX text. */
function renderable(file: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test("no public page offers what needs a Higgsfield sign-in", () => {
  const files = ROOTS.flatMap(sources);
  expect(files.length, "the site's sources were found").toBeGreaterThan(10);
  const found = files.flatMap((file) => renderable(file).flatMap((text) => retiredFindings(text).map((why) => `${file}: ${why}`)));
  expect(found).toEqual([]);
  /* The page lists the header and the suites strip print: Viral without Shorts, Atomik without its Generate page. */
  expect(SITE_SUITES.find((suite) => suite.id === "viral")!.pages).toEqual(["Motion transfer", "Object swap", "Sources", "Compare", "History"]);
  expect(SITE_SUITES.find((suite) => suite.id === "atomik")!.pages).not.toContain("Generate");
});

test("the guard knows the copy it replaced, and lets the replacements through", () => {
  /* Sentences the site carried before 28 September. */
  for (const line of [
    "Image, video, sound and 3D workflows from the connected account’s catalogue.",
    "Tools: upscale image and video, remove background, extend canvas, reframe, deflicker, lip-sync.",
    "Voice: change voice and dub; Analyse video stays off.",
    "then the connected account’s catalogue, characters, voice, dubbing, social cuts and ad templates",
    "Every character and element is built with a Soul model on the connected account",
    "Environments and props, built the same way, a place with Soul Location.",
    "Save any build as a reference element the account keeps for reuse.",
    "templates from the connected catalogue",
    "Business, Ads: the Marketing Studio video ad composer",
    "/marketing/screens/business-dtc-image-ads.jpg",
    "03 Shorts",
    "one 4–30 s source, up to 30 ordered references, 480p to 1080p",
    "Up to 30, ordered",
    "Studio engines in the model sheet, and the connected catalogue beside them.",
    "Connect the Higgsfield account in Workspace › Engines.",
    "Sign in to Higgsfield to use your plan credits.",
  ]) expect(retiredFindings(line), line).not.toEqual([]);
  /* What replaced them, and Particl's own tools, stay sayable. */
  for (const line of [
    "Standard video. Highest fidelity, native audio, up to 30 s and 30 reference images.",
    "Astra 3D", "Templates", "Change voice", "Dub", "Upscale", "Soul ID",
    "Ads presets for image variants, read live.",
    "Social accounts and posting providers are not connected; Publish leads to review and delivery.",
    "with interface, data, sign-in and generation models wired in",
    "One source of 4 to 8 seconds, ordered references, 480p to 1080p.",
  ]) expect(retiredFindings(line), line).toEqual([]);
});
