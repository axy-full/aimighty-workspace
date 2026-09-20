import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project, type Plan } from "../lib/workbench/studio";
import { projectSchema } from "../lib/workbench/studio-schema";
import { legacyShell } from "./helpers/legacyShell";

async function fixture(page: Page, rejectSave = false) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  let project: Project = {
    ...newProject("Launch project"),
    id: "marketing-flow",
    productionProjectId: "production-flow",
    shotMappings: {},
    brief: "An independent film about finding a way home.",
    assets: [
      {
        id: "reference",
        name: "Brand reference",
        kind: "link",
        category: "Reference",
        url: "https://example.test/reference",
        prompt: "Quiet, natural, warm.",
        description: "Approved brand guidance",
        refs: [],
        version: 1,
        status: "Selected",
        locked: true,
      },
    ],
    nodes: [
      {
        id: "source-node",
        title: "Brand guide",
        type: "note",
        assetId: "reference",
        text: "Keep the original.",
        x: 60,
        y: 60,
        width: 300,
        linked: [],
      },
    ],
  };
  let revision = 1;
  const quotes: Record<string, unknown>[] = [],
    submissions: Record<string, unknown>[] = [];
  const snapshots: Project[] = [];
  let job: {
    id: string;
    requestId: string;
    status: string;
    role: string;
    model: string;
    request: string;
    plan: Plan;
  } | null = null;
  const models = [
    {
      id: "openai/gpt-5.4",
      name: "GPT-5.4",
      efforts: [{ value: "high", label: "High" }],
    },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        if (rejectSave)
          return route.fulfill({
            status: 409,
            json: { error: "Fixture: resolve the draft conflict first." },
          });
        const data = request.postDataJSON();
        project = projectSchema.parse(data.project) as Project;
        revision = data.revision + 1;
        return json({
          revision,
          productionProjectId: project.productionProjectId,
          shotMappings: project.shotMappings,
        });
      }
      return json({
        project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (path === "/api/workbench/atomik") {
      if (request.method() === "GET")
        return json({ models, jobs: job ? [job] : [] });
      const data = request.postDataJSON();
      if (data.quoteOnly) {
        quotes.push(data);
        snapshots.push(structuredClone(project));
        return json({
          estimateCredits: 2,
          model: data.model === "auto" ? models[0].id : data.model,
          effort: data.effort,
        });
      }
      submissions.push(data);
      const plan: Plan = {
        id: "marketing-result",
        role: "marketing",
        request: data.request,
        model: data.model,
        effort: data.effort,
        depth: data.depth,
        refs: data.refs,
        applied: false,
        intent: "campaign",
        summary: "A quiet invitation to find your way home.",
        steps: [
          "HOOK A\nFind the place that finds you.\nCTA: Watch the trailer.",
          "LAUNCH\nDay -7: Share the character portrait.\nDay 0: Release the trailer.",
        ],
      };
      job = {
        id: plan.id,
        requestId: data.requestId,
        status: "succeeded",
        role: "marketing",
        model: data.model,
        request: data.request,
        plan,
      };
      return json({ job });
    }
    if (path === "/api/workbench/development")
      return json({ models: [], jobs: [] });
    if (path === "/api/jobs")
      return json({ generations: [], nextCursor: null });
    if (path === "/api/engines" || path === "/api/workbench/engines")
      return json({ models: [], vendors: [] });
    if (request.method() === "POST")
      return route.fulfill({
        status: 409,
        json: { error: "Unexpected paid route in local fixture." },
      });
    return json({});
  });
  await page.goto(
    await legacyShell(page, "/workbench?project=marketing-flow&atomik=marketing&stage=brief"),
  );
  const panel = page.getByRole("region", {
    name: "Marketing Studio",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Campaign objective")).toBeEnabled();
  return {
    panel,
    quotes,
    submissions,
    snapshots,
    get project() {
      return project;
    },
  };
}

test("campaign brief → context → quote → recovered result → export and editable canvas", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await fixture(page),
    panel = state.panel;
  await panel
    .getByRole("button", { name: "Hooks & copy", exact: false })
    .click();
  await panel
    .getByLabel("Campaign objective")
    .fill("Drive trailer views for the premiere.");
  await panel
    .getByLabel("Product or offer")
    .fill("A cinematic independent film.");
  await panel
    .getByLabel("Campaign audience")
    .fill("Independent cinema audiences.");
  await panel.getByLabel("Instagram", { exact: true }).check();
  await panel.getByLabel("Email", { exact: true }).check();
  await panel.getByLabel("Brand voice").fill("Warm and cinematic.");
  await panel
    .getByLabel("Mandatories & constraints")
    .fill("No invented reviews or awards.");
  await panel
    .getByLabel("Creative direction", { exact: false })
    .fill("Write in English. Focus on the emotional hook.");
  await panel.getByRole("button", { name: /Choose assets/ }).click();
  await expect(page.getByRole("tab", { name: /^Context/ })).toHaveAttribute(
    "data-state",
    "active",
  );
  await page.getByRole("tab", { name: "Marketing", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /Hooks & copy/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByLabel("Creative direction", { exact: false }),
  ).toHaveValue("Write in English. Focus on the emotional hook.");
  await panel.getByRole("button", { name: "Review campaign estimate" }).click();
  const dialog = page.getByRole("dialog", { name: "Run Marketing Studio" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Atomik request depth").selectOption("Deep");
  await expect(
    dialog.getByRole("button", { name: "Run · 2 cr estimated" }),
  ).toBeEnabled();
  expect(state.submissions).toHaveLength(0);
  expect(state.quotes.at(-1)).toMatchObject({
    projectId: "marketing-flow",
    role: "marketing",
    refs: ["reference"],
    depth: "Deep",
  });
  expect(state.snapshots.at(-1)?.marketingBrief).toMatchObject({
    objective: "Drive trailer views for the premiere.",
    channels: ["Instagram", "Email"],
    tone: "Warm and cinematic.",
  });
  expect(state.snapshots.at(-1)?.brief).toBe(
    "An independent film about finding a way home.",
  );
  await dialog.getByRole("button", { name: "Run · 2 cr estimated" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("tab", { name: "Marketing", exact: true }).click();
  await expect(
    panel.getByText("A quiet invitation to find your way home.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0]).toMatchObject({
    maxCredits: 2,
    role: "marketing",
    depth: "Deep",
    model: "openai/gpt-5.4",
  });
  expect(String(state.submissions[0].request)).toContain(
    "Write in English. Focus on the emotional hook.",
  );
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Markdown", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/_marketing_.*\.md$/);
  const markdown = await readFile((await download.path())!, "utf8");
  expect(markdown).toContain("Find the place that finds you.");
  expect(markdown).toContain("Brand reference");
  await panel
    .getByRole("button", { name: "Add to canvas", exact: true })
    .click();
  await expect.poll(() => state.project.nodes.length).toBe(3);
  const notes = state.project.nodes.filter(
    (node) => node.role === "Marketing strategist",
  );
  expect(notes).toHaveLength(2);
  expect(
    notes.every(
      (node) =>
        node.type === "note" &&
        !node.assetId &&
        node.linked.includes("source-node"),
    ),
  ).toBe(true);
  expect(state.project.nodes[0].text).toBe("Keep the original.");
  expect(state.project.assets).toHaveLength(1);
  await page.reload();
  await expect(panel.getByLabel("Campaign objective")).toHaveValue(
    "Drive trailer views for the premiere.",
  );
  await expect(
    panel.getByRole("button", { name: "On canvas", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("tab", { name: "Marketing", exact: true })
    .scrollIntoViewIfNeeded();
  const fit = await page
    .locator(".atomik-tabs")
    .filter({ visible: true })
    .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.width + 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("marketing-studio.png") });
});

test("an unsaved campaign conflict cannot request an estimate or submit work", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "desktop save gate");
  const state = await fixture(page, true);
  await state.panel.getByLabel("Campaign objective").fill("An unsaved change.");
  await state.panel
    .getByRole("button", { name: "Review campaign estimate" })
    .click();
  await expect(
    page
      .getByText("Fixture: resolve the draft conflict first.", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Run Marketing Studio" }),
  ).not.toBeVisible();
  expect(state.quotes).toHaveLength(0);
  expect(state.submissions).toHaveLength(0);
});
