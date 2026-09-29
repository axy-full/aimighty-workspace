import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project, type Asset } from "../lib/workbench/studio";
import { ASTRA_BLENDER_MODEL, createAstraScene } from "../lib/astra-blender/scene";
import type { AstraRenderJob, AstraRenderRuntime } from "../lib/astra-blender/render-contract";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Astra — the 3D scene editor, its assistant, the native source, render and export panels — holds the owner's floors
 * on a phone, in the Studio suite's Astra 3D page and in the old shell's stage. Every panel is opened in turn (Scene,
 * Objects, Properties with an animated object selected, Astra with every disclosure open, Output with a render in
 * progress and one finished) and measured where it lands:
 *  - on a touch screen (360×640, 390×844 and a phone on its side, 844×390) every control is a 44×44 target — a
 *    checkbox or the upload picker by its label, a disclosure by its summary — and no text is under 12px;
 *  - at every size nothing runs past the screen or the tool's own edge, sideways scrollers included (code blocks
 *    scroll their long lines, as they should), and every text reads at #7C7C84 or brighter once its colour and any
 *    opacity above it are composited over the ground behind it (a disabled control is exempt);
 *  - on a portrait phone the page's last row ends above the floating tab bar at the end of the page.
 * The UI audit of 28 September found Astra's phone controls at 25–42px and its text at 8–10px. Mocked routes, the
 * mock engine: nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
/* A phone on its side is a touch screen too. */
const TOUCH = [...PORTRAIT, "workbench-844x390"];
const EFFORTS = [{ value: "medium", label: "Medium" }, { value: "max", label: "Maximum" }];
const READY: AstraRenderRuntime = { configured: true, reason: null, blenderVersion: "5.0", timeoutMs: 180000, vcpus: 2, memoryMb: 4096 };

const asset = (id: string, name: string, mime: string, kind: Asset["kind"]): Asset => ({ id, uploadId: `${id}-upload`, name, mime, kind, url: `/api/uploads/${id}-upload`, category: "Astra", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });

function project(): Project {
  /* The orbital template animates its ring, so the timeline has keyframes to show and to list. */
  return {
    ...newProject("Astra phone study"), id: "astra-phone-study", productionProjectId: "astra-phone-production", shotMappings: {},
    astraBlender: createAstraScene("abstract"),
    astraNative: { schemaVersion: 1, name: "Procedural character study", program: "import bpy\n# A long line of Python keeps its own sideways scroll inside the code block and never widens the page around it\nobj = bpy.context.active_object\n", assetIds: ["reference-render"] },
    assets: [asset("reference-render", "Reference render with a long descriptive file name.png", "image/png", "image"), asset("base-blend", "Character rig.blend", "application/x-blender", "document")],
  };
}

function renderJob(fields: Partial<AstraRenderJob> & { id: string }): AstraRenderJob {
  return { requestId: `${fields.id}-request`, projectId: "astra-phone-study", source: "scene", sourceDigest: "b".repeat(64), status: "succeeded", estimateCredits: 12, billedCredits: 9, createdAt: Date.UTC(2026, 8, 28, 10), updatedAt: Date.UTC(2026, 8, 28, 10, 5), error: null, artifacts: [], assetsRegistered: false, ...fields };
}

/** The assistant's two proposals (a scene, a native program) and the render history: read-only routes, nothing paid. */
async function mockAstra(page: Page, current: Project) {
  const proposed = createAstraScene("abstract");
  proposed.name = "Orbital study, cooler light";
  const plan = { request: "Cool the key light.", model: ASTRA_BLENDER_MODEL, effort: "max", depth: "Deep", refs: [], applied: false, intent: "3D scene", summary: "A cooler key light over the same orbit.", steps: ["Shift the key light towards blue while keeping the geometry."] };
  const jobs = [
    { id: "astra-scene-job", projectId: current.id, requestId: "scene-request", ...plan, status: "succeeded", credits: 3, estimateCredits: 7, astraBlender: { sceneDigest: "a".repeat(64) },
      plan: { id: "astra-scene-job", ...plan, astraBlender: { baseSceneDigest: "a".repeat(64), scene: proposed } } },
    { id: "astra-native-job", projectId: current.id, requestId: "native-request", ...plan, status: "succeeded", credits: 4, estimateCredits: 7, astraBlender: { sceneDigest: "a".repeat(64), mode: "native", nativeDigest: "c".repeat(64) },
      plan: { id: "astra-native-job", ...plan, astraNative: { baseSceneDigest: "a".repeat(64), baseNativeDigest: "c".repeat(64), source: { ...current.astraNative!, name: "Procedural character study, rigged" } } } },
  ];
  await page.route("**/api/workbench/atomik**", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { models: [{ id: ASTRA_BLENDER_MODEL, name: "Astra", efforts: EFFORTS }], jobs } }) : route.fulfill({ status: 409, json: { error: "No Astra request is sent from the floors fixture." } })));
  const artifacts = (["preview", "blend", "glb"] as const).map((kind) => ({ kind, assetId: `render-${kind}`, uploadId: `astra-render-${kind}`, url: `/api/uploads/astra-render-${kind}`, filename: `scene.${kind === "preview" ? "png" : kind}`, mime: kind === "preview" ? "image/png" : "application/octet-stream", bytes: 2048 }));
  const history = [renderJob({ id: "render-running", status: "running", billedCredits: null }), renderJob({ id: "render-done", artifacts, assetsRegistered: true })];
  await page.route("**/api/workbench/astra-blender/render**", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { runtime: READY, jobs: history } }) : route.fulfill({ status: 409, json: { error: "No render is started from the floors fixture." } })));
}

type Host = { root: string; pane: string | null };
const SUITES: Host = { root: "[data-tool-body='astra']", pane: "[data-testid='content']" };
/* AstraStudio's own root in the old shell: its toolbar and the workspace. */
const LEGACY: Host = { root: ".stage-scroll:has(> section[aria-label='Astra'])", pane: null };

async function openSuites(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const current = project();
  await mockProjects(page, { current });
  await mockLibrary(page, { uploads: [], generations: [] });
  await mockAstra(page, current);
  await page.goto(`/suites?suite=studio&page=astra&project=${current.id}`);
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-page", "astra");
}

async function openLegacy(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const current = project();
  await mockProjects(page, { current });
  await mockAstra(page, current);
  await page.goto(await legacyShell(page, `/workbench?project=${current.id}&stage=astra-blender`));
}

/** Everything a thumb can hit, as a thumb meets it: a checkbox and the upload picker by their labels, a disclosure by its summary. */
const TARGETS = "button, a[href], select, textarea, summary, input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), label:has(> input[type=checkbox]), label:has(> input[type=radio]), label:has(> input[type=file])";

/** The floors, measured inside the Astra tool (`root`) as it is on screen now. */
function measure(page: Page, root: string) {
  return page.evaluate(async ({ root, TARGETS }) => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    const scope = document.querySelector<HTMLElement>(root);
    if (!scope) return { missing: true, targets: [], text: [], labels: [], overflow: [], serif: [], prices: [] };
    const shown = (el: Element) => el.getClientRects().length > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    /* A module class reads by its own name (…__iconButton → iconButton). */
    const name = (el: Element) => `${(el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 36)} (${String((el as HTMLElement).className || el.tagName).split(" ")[0].split("__").pop()!.slice(0, 28)})`;
    const targets = Array.from(scope.querySelectorAll<HTMLElement>(TARGETS)).filter(shown).flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 - 0.5 || r.height < 44 - 0.5 ? [`${name(el)}: ${Math.round(r.width)}×${Math.round(r.height)}`] : [];
    });
    const texts: HTMLElement[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !(node.textContent ?? "").trim() || el.closest("option, script, style") || !shown(el)) continue;
      if (!texts.includes(el)) texts.push(el);
    }
    const text = texts.flatMap((el) => { const size = Number.parseFloat(getComputedStyle(el).fontSize); return size < 12 ? [`${size}px: ${name(el)}`] : []; });
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const labels = texts.flatMap((el) => {
      /* A disabled control says it is unavailable by fading; it is not a label to read. */
      if (el.closest("button:disabled, fieldset:disabled, input:disabled, select:disabled, textarea:disabled")) return [];
      const layers: Rgba[] = [];
      for (let up: HTMLElement | null = el; up; up = up.parentElement) {
        const bg = parse(getComputedStyle(up).backgroundColor);
        if (!bg || bg.a <= 0) continue;
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      const ground = layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
      let opacity = 1;
      for (let up: HTMLElement | null = el; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
      const ink = parse(getComputedStyle(el).color);
      if (!ink) return [`${name(el)}: unreadable colour`];
      const seen = over({ ...ink, a: ink.a * opacity }, ground);
      return luminance(seen) < floor ? [`${name(el)}: reads ${[seen.r, seen.g, seen.b].map(Math.round).join(", ")}`] : [];
    });
    /* Code keeps its own sideways scroll; nothing else scrolls or runs past the tool or the screen. */
    const code = (el: Element) => Boolean(el.closest("pre, textarea"));
    const overflow: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) overflow.push(`the page is ${document.documentElement.scrollWidth - innerWidth}px wider than the screen`);
    const box = scope.getBoundingClientRect(), right = Math.min(box.right, innerWidth);
    for (const el of [scope.closest<HTMLElement>(".pxw-embed"), scope, ...Array.from(scope.querySelectorAll<HTMLElement>("*"))]) {
      if (!el || !shown(el) || code(el)) continue;
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) overflow.push(`${name(el)} scrolls ${el.scrollWidth - el.clientWidth}px sideways`);
      if (el === scope || !scope.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > right + 1 || r.left < box.left - 1)) overflow.push(`${name(el)} runs ${Math.round(Math.max(r.right - right, box.left - r.left))}px past the tool`);
    }
    const serif = texts.flatMap((el) => { const family = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/["']/g, "").toLowerCase(); return /^(serif|times|times new roman|georgia|garamond|palatino|cambria|book antiqua)$/.test(family) ? [`${family}: ${name(el)}`] : []; });
    /* A price is read whole: never cut with an ellipsis or a clamp. */
    const prices = texts.flatMap((el) => {
      if (!/\d\s*cr\b/.test(el.textContent ?? "")) return [];
      for (let up: HTMLElement | null = el; up && scope.contains(up); up = up.parentElement) {
        const s = getComputedStyle(up);
        if ((s.textOverflow === "ellipsis" && up.scrollWidth > up.clientWidth + 1) || (s.webkitLineClamp !== "none" && s.webkitLineClamp !== "")) return [`${name(el)} is cut`];
      }
      return [];
    });
    return { missing: false, targets: [...new Set(targets)], text: [...new Set(text)], labels: [...new Set(labels)], overflow: [...new Set(overflow)], serif, prices };
  }, { root, TARGETS });
}

/** At the page's end, the lowest row of the page ends above the floating tab bar (hf-phone-chrome's measure). */
function lastRow(page: Page, pane: string) {
  return page.evaluate(async (pane) => {
    const root = document.querySelector<HTMLElement>(pane);
    if (!root) return null;
    const own = (el: HTMLElement) => {
      for (let up: HTMLElement | null = el; up && up !== root; up = up.parentElement) {
        const s = getComputedStyle(up);
        if (s.position === "fixed" || s.position === "sticky") return false;
        if (up !== el && (s.overflowY !== "visible" || s.overflowX !== "visible")) return false;
      }
      return true;
    };
    root.scrollTop = root.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && el.checkVisibility({ visibilityProperty: true }) && own(el); });
    if (!rows.length) return null;
    const lowest = rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a));
    const bar = document.querySelector(".gx-tabbar");
    const barTop = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : innerHeight;
    return { bottom: Math.round(lowest.getBoundingClientRect().bottom * 10) / 10, barTop, name: String(lowest.className || lowest.tagName).slice(0, 40) };
  }, pane);
}

async function expectFloors(page: Page, host: Host, where: string, touch: boolean, portrait: boolean) {
  const found = await measure(page, host.root);
  expect(found.missing, `${where}: the Astra tool is on the page`).toBe(false);
  if (touch) {
    expect.soft(found.targets, `${where}: targets under 44×44 on a touch screen`).toEqual([]);
    expect.soft(found.text, `${where}: text under 12px on a phone`).toEqual([]);
  }
  expect.soft(found.labels, `${where}: text under #7C7C84 once composited`).toEqual([]);
  expect.soft(found.overflow, `${where}: nothing sideways or past the tool`).toEqual([]);
  expect.soft(found.serif, `${where}: no serif`).toEqual([]);
  expect.soft(found.prices, `${where}: prices read whole`).toEqual([]);
  if (portrait && host.pane) {
    const last = await lastRow(page, host.pane);
    expect(last, `${where}: a page with rows`).not.toBeNull();
    expect.soft(last!.bottom, `${where}: ${last!.name} ends above the tab bar`).toBeLessThanOrEqual(last!.barTop + 0.5);
  }
}

/** Opens a panel the way a person does: the phone's panel tabs, or the Inspector's tabs beside the viewport. */
async function openPanel(page: Page, host: Host, name: "Scene" | "Objects" | "Properties" | "Astra" | "Output") {
  const workspace = page.locator(host.root).getByRole("region", { name: "Astra", exact: true });
  const phone = workspace.getByRole("navigation", { name: "3D workspace panels" });
  if (await phone.isVisible()) await phone.getByRole("button", { name, exact: true }).click();
  else if (name !== "Scene" && name !== "Objects") await workspace.getByRole("navigation", { name: "Inspector panels" }).getByRole("button", { name, exact: true }).click();
  return workspace;
}

/** Every disclosure in the open panel, opened. */
async function openDetails(page: Page, host: Host) {
  for (const summary of await page.locator(host.root).locator("details:not([open]) > summary").filter({ visible: true }).all()) await summary.click();
}

async function walk(page: Page, host: Host, size: string) {
  const touch = TOUCH.includes(size), portrait = PORTRAIT.includes(size);
  const tool = page.locator(host.root);
  const workspace = tool.getByRole("region", { name: "Astra", exact: true });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("img", { name: "Interactive 3D viewport" })).toBeVisible();

  await openPanel(page, host, "Objects");
  await workspace.getByRole("button", { name: "Orbit", exact: true }).click();
  await openPanel(page, host, "Scene");
  await expect(workspace.getByRole("button", { name: "Go to keyframe 120", exact: true })).toBeVisible();
  await expectFloors(page, host, `${size} Scene`, touch, portrait);

  await openPanel(page, host, "Objects");
  await expect(workspace.getByRole("button", { name: "Hide Orbit", exact: true })).toBeVisible();
  await expectFloors(page, host, `${size} Objects`, touch, portrait);

  await openPanel(page, host, "Properties");
  await expect(workspace.getByRole("button", { name: "Frame 120", exact: true })).toBeVisible();
  await openDetails(page, host);
  await expectFloors(page, host, `${size} Properties`, touch, portrait);

  await openPanel(page, host, "Astra");
  const assistant = workspace.getByRole("region", { name: "Astra scene assistant", exact: true });
  await expect(assistant.getByRole("button", { name: "Apply scene proposal", exact: true })).toBeEnabled();
  await assistant.getByRole("button", { name: "Native 3D", exact: true }).click();
  await openDetails(page, host);
  await expect(assistant.locator("pre")).toContainText("A long line of Python");
  await expectFloors(page, host, `${size} Astra`, touch, portrait);

  await openPanel(page, host, "Output");
  const renders = workspace.getByRole("region", { name: "Native 3D renders", exact: true });
  await expect(renders.getByText("3D runtime 5.0 · Ready", { exact: true })).toBeVisible();
  await expect(renders.getByRole("button", { name: "Cancel render", exact: true })).toBeVisible();
  await openDetails(page, host);
  await expectFloors(page, host, `${size} Output`, touch, portrait);
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

test("Astra 3D in the Studio suite: 44px targets and 12px text on touch, labels at the floor, nothing sideways, the last row above the tab bar", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openSuites(page);
  await walk(page, SUITES, info.project.name);
  await page.screenshot({ path: info.outputPath("astra-suites-output.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("Astra in the old shell's stage holds the same floors inside its own tool", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLegacy(page);
  await walk(page, LEGACY, info.project.name);
  expect(errors).toEqual([]);
});
