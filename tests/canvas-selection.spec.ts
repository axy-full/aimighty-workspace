import sharp from "sharp";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { newProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

async function fixture(page: Page, nativeRender = false) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  let project: Project = {
    ...newProject("Canvas interaction test"),
    id: "canvas-test",
    productionProjectId: "production-test",
    nodes: [
      {
        id: "a",
        title: "Alpha",
        type: "note",
        x: 60,
        y: 80,
        width: 150,
        linked: [],
        collapsed: true,
      },
      {
        id: "b",
        title: "Beta",
        type: "note",
        x: 250,
        y: 80,
        width: 150,
        linked: ["a"],
        collapsed: true,
      },
      {
        id: "locked",
        title: "Locked",
        type: "note",
        x: 60,
        y: 250,
        width: 150,
        linked: [],
        collapsed: true,
        locked: true,
      },
    ],
  };
  const nativeSource = nativeRender
    ? await sharp({
        create: {
          width: 4096,
          height: 2160,
          channels: 3,
          background: { r: 120, g: 80, b: 30 },
        },
      })
        .png()
        .toBuffer()
    : null;
  if (nativeRender) {
    project.assets = [
      {
        id: "source-image",
        name: "Trained source",
        kind: "image",
        category: "Character",
        url: "/canvas-native-source.png",
        mime: "image/png",
        description: "Original still",
        prompt: "Portrait",
        status: "Selected",
        locked: true,
        version: 1,
        refs: [],
        soulIdentityId: "trained-identity",
        generationId: "original-job",
        productionShotId: "original-shot",
        nodeId: "original-node",
      },
    ];
    project.nodes = [
      {
        id: "grade",
        title: "Native finish",
        type: "grade",
        assetId: "source-image",
        x: 60,
        y: 80,
        width: 236,
        linked: [],
        operations: [
          {
            id: "grade-op",
            kind: "grade",
            enabled: true,
            values: { brightness: 120, contrast: 100, saturation: 100 },
          },
        ],
      },
    ];
    await page.route("**/canvas-native-source.png", (route) =>
      route.fulfill({ contentType: "image/png", body: nativeSource! }),
    );
  }
  project.sharedNodes = structuredClone(project.nodes);
  project.sharedNodeIds = project.nodes.map((n) => n.id);
  let revision = 1;
  const saves: Project[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/me") return json(me);
    if (nativeRender && path === "/api/uploads/chunk")
      return json({ ok: true });
    if (nativeRender && path === "/api/uploads/finish")
      return json({
        id: "rendered-upload",
        url: "/api/uploads/rendered-upload",
        filename: "Native_finish.png",
        mime: "image/png",
        kind: "image",
        bytes: nativeSource!.length,
        width: 4096,
        height: 2160,
        durationS: null,
        sha256: "fixture-sha",
      });
    if (
      nativeRender &&
      (path.startsWith("/api/uploads/") ||
        path.startsWith("/api/workbench/preview/"))
    )
      return route.fulfill({ contentType: "image/png", body: nativeSource! });
    if (path === "/api/workbench/projects") {
      if (req.method() === "PUT") {
        project = req.postDataJSON().project;
        saves.push(structuredClone(project));
        return json({
          revision: ++revision,
          productionProjectId: project.productionProjectId,
          shotMappings: {},
        });
      }
      return json({
        project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/workbench/engines")
      return json({ models: [], credits: 0 });
    if (path === "/api/productions") return json({ productions: [] });
    return json({});
  });
  await page.goto(await legacyShell(page, "/workbench"));
  await goWorkbenchStage(page, "canvas");
  await expect(page.getByLabel("Project node canvas")).toBeVisible();
  const library = page.getByRole("button", {
    name: "Close node library",
    exact: true,
  });
  if (await library.isVisible()) await library.click();
  const inspector = page.getByRole("button", {
    name: "Close inspector",
    exact: true,
  });
  if (await inspector.isVisible()) await inspector.click();
  // Fit uses actual viewport space after both panels close.
  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  return { current: () => project, saves };
}
const card = (page: Page, name: string) =>
  page.getByRole("article", { name: "Direction node: " + name, exact: true });
async function point(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
async function marquee(page: Page, targets: Locator[], touch = false) {
  const boxes = await Promise.all(targets.map(point));
  const x = Math.min(...boxes.map((b) => b.x)) - 12,
    y = Math.min(...boxes.map((b) => b.y)) - 12,
    right = Math.max(...boxes.map((b) => b.x + b.width)) + 12,
    bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 12;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 71 }],
    });
    for (let step = 1; step <= 8; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: x + ((right - x) * step) / 8,
            y: y + ((bottom - y) * step) / 8,
            id: 71,
          },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 8 });
    await page.mouse.up();
  }
}

test("canvas marquee, additive selection, group move, duplicate edges, delete and single-step undo", async ({
  page,
}) => {
  test.skip(
    page.viewportSize()!.width < 1000,
    "desktop pointer and keyboard interactions",
  );
  const state = await fixture(page);
  const canvas = page.getByLabel("Project node canvas");
  await marquee(page, [card(page, "Alpha"), card(page, "Beta")]);
  await expect(page.getByLabel("Canvas selection")).toContainText("2 selected");
  await expect(card(page, "Locked")).toHaveAttribute("data-selected", "false");
  await card(page, "Locked").click({
    modifiers: ["Shift"],
    position: { x: 35, y: 24 },
  });
  await expect(page.getByLabel("Canvas selection")).toContainText("3 selected");
  // Drag a selected header at the current zoom; both movable nodes share one world delta.
  const a = await point(card(page, "Alpha"));
  await page.mouse.move(a.x + 35, a.y + 22);
  await page.mouse.down();
  await page.mouse.move(a.x + 85, a.y + 62, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => state.current().nodes.find((n) => n.id === "a")!.x)
    .not.toBe(60);
  const moved = state.current().nodes;
  expect(moved[1].x - moved[0].x).toBe(190);
  expect(moved[1].y).toBe(moved[0].y);
  expect(moved[2].x).toBe(60);
  expect(moved[2].y).toBe(250);
  await canvas.press("ControlOrMeta+z");
  await expect.poll(() => state.current().nodes[0].x).toBe(60);
  await expect.poll(() => state.current().nodes[1].x).toBe(250);
  await page.getByRole("button", { name: "Selected node actions" }).click();
  await page
    .getByRole("menuitem", { name: "Duplicate selected nodes", exact: true })
    .click();
  await expect.poll(() => state.current().nodes.length).toBe(5);
  const copies = state.current().nodes.slice(-2);
  expect(copies[1].linked).toEqual([copies[0].id]);
  await canvas.focus();
  await canvas.press("Delete");
  await expect.poll(() => state.current().nodes.length).toBe(3);
  await canvas.press("ControlOrMeta+z");
  await expect.poll(() => state.current().nodes.length).toBe(5);
  await canvas.press("ControlOrMeta+a");
  await expect(page.getByLabel("Canvas selection")).toContainText("5 selected");
  await canvas.press("Escape");
  await expect(page.locator('.ng-node[data-selected="true"]')).toHaveCount(0);
  // Shift toggles a member; text input select-all remains browser-native.
  await card(page, "Alpha").click({ position: { x: 30, y: 20 } });
  await card(page, "Beta").click({
    modifiers: ["Shift"],
    position: { x: 30, y: 20 },
  });
  await card(page, "Alpha").click({
    modifiers: ["Shift"],
    position: { x: 30, y: 20 },
  });
  await expect(card(page, "Alpha")).toHaveAttribute("data-selected", "false");
  await expect(card(page, "Beta")).toHaveAttribute("data-selected", "true");
  await card(page, "Beta").dblclick({ position: { x: 30, y: 20 } });
  const name = page.getByRole("textbox", { name: "Node name", exact: true });
  await name.focus();
  await name.press("ControlOrMeta+a");
  await expect(page.locator('.ng-node[data-selected="true"]')).toHaveCount(1);
});

test("canvas box-select tool works at every viewport and shared view cannot mutate nodes", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  const touch = page.viewportSize()!.width < 900;
  await page
    .getByRole("button", { name: "Box select · B", exact: true })
    .click();
  await marquee(page, [card(page, "Alpha"), card(page, "Beta")], touch);
  await expect(page.getByLabel("Canvas selection")).toContainText("2 selected");
  await page.screenshot({ path: testInfo.outputPath("canvas-selection.png") });
  const snapshot = JSON.stringify(state.current().nodes);
  if (page.viewportSize()!.width < 760) {
    await page.getByRole("combobox", { name: "Canvas space" }).click();
    await page
      .getByRole("option", { name: "Shared view", exact: true })
      .click();
  } else
    await page.getByRole("tab", { name: "Shared view", exact: true }).click();
  const canvas = page.getByLabel("Project node canvas");
  await canvas.focus();
  await canvas.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Selected node actions" }).click();
  await expect(
    page.getByRole("menuitem", {
      name: "Duplicate selected nodes",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Remove selected nodes", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await canvas.focus();
  await canvas.press("Delete");
  await canvas.press("ArrowRight");
  expect(JSON.stringify(state.current().nodes)).toBe(snapshot);
});

test("rendered PNG keeps native source dimensions and saved take drops trained identity and paid job bindings", async ({
  page,
}) => {
  test.skip(
    page.viewportSize()!.width !== 1440,
    "one desktop verifies pixel output and upload integration",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await fixture(page, true);
  await page
    .getByRole("button", { name: "Open inspector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Source-size PNG", exact: true }),
  ).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Source-size PNG", exact: true }).click(),
  ]);
  const file = await download.path();
  expect(file).toBeTruthy();
  const metadata = await sharp(file!).metadata();
  expect([metadata.width, metadata.height]).toEqual([4096, 2160]);
  const pixel = await sharp(file!)
    .extract({ left: 100, top: 100, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  [144, 96, 36].forEach((value, index) =>
    expect(Math.abs(pixel[index] - value)).toBeLessThanOrEqual(2),
  );
  await page
    .getByRole("button", { name: "Save rendered take", exact: true })
    .click();
  await expect
    .poll(() =>
      state.current().assets.find((asset) => asset.id === "rendered-upload"),
    )
    .toBeTruthy();
  const saved = state
    .current()
    .assets.find((asset) => asset.id === "rendered-upload")!;
  expect(saved).toMatchObject({
    kind: "image",
    uploadId: "rendered-upload",
    parentId: "source-image",
    description: "Node render · 4096 × 2160",
  });
  for (const key of [
    "soulIdentityId",
    "generationId",
    "productionShotId",
    "nodeId",
  ])
    expect(saved).not.toHaveProperty(key);
  expect(
    state.current().assets.find((asset) => asset.id === "source-image")!
      .soulIdentityId,
  ).toBe("trained-identity");
  expect(errors).toEqual([]);
});
