import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import type { PublicPipelineRun } from "../lib/pipeline/public";

async function fixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request
      .get("/api/me")
      .then((response) => response.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  const project = {
    ...newProject("Atomik film"),
    id: "atomik-draft",
    productionProjectId: "actual-production",
  };
  const run: PublicPipelineRun = {
    id: "run-original",
    owner: me.id,
    pipelineId: "saved-plan",
    pipelineVersion: 1,
    revision: 2,
    state: "awaiting_approval",
    name: "Dawn plan",
    context: { projectId: project.productionProjectId, bibleVersion: 1 },
    maximumUnits: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stages: [
      {
        definition: {
          id: "images",
          label: "Dawn keyframe",
          kind: "image",
          model: "gemini-3-pro-image",
          prompt: { source: "brief" },
          inputs: [],
          ratio: "16:9",
          resolution: "2k",
          seed: null,
          units: 1,
        },
        dependencies: [],
        outputKind: "image",
        prompt: "A quiet city at dawn.",
      },
    ],
    attempts: [],
    quotes: [
      {
        id: "quote-one",
        stageId: "images",
        baseRevision: 2,
        inputHash: "input",
        fingerprint: "approved-exact-plan",
        units: [{ unit: 0, number: 1 }],
        estimatedCredits: 7,
        price: 7,
        currency: "cr",
        expiresAt: Date.now() + 600000,
        approvedAt: null,
      },
    ],
    selections: [],
    assemblies: {},
  };
  const runs = [run],
    requests: { path: string; body: Record<string, unknown> }[] = [];
  let cap = 100;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      body = request.method() === "GET" ? undefined : request.postDataJSON();
    if (path === "/api/me") return route.fulfill({ json: me });
    if (path === "/api/workbench/projects")
      return route.fulfill({
        json: {
          project:
            !url.searchParams.get("id") ||
            url.searchParams.get("id") === project.id
              ? project
              : null,
          projects: [{ id: project.id, name: project.name }],
          revision: 1,
          productions: [],
        },
      });
    if (path === "/api/pipelines") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET") {
        expect(url.searchParams.get("projectId")).toBe(
          project.productionProjectId,
        );
        return route.fulfill({
          json: {
            runs,
            publications: [],
            models: [
              {
                id: "gemini-3-pro-image",
                label: "Image Pro",
                kind: "image",
                resolutions: ["2k"],
                ratios: ["16:9"],
                durations: [],
                supportsAudio: false,
                configured: true,
              },
            ],
            audioModels: {
              speech: [],
              sound: "sound_effects_v1",
              music: "music_v1",
            },
          },
        });
      }
      requests.push({ path, body });
      expect(body).toEqual({
        expectedVersion: 0,
        spec: {
          schemaVersion: 1,
          name: run.name,
          context: run.context,
          stages: run.stages.map((stage) => stage.definition),
        },
      });
      const created = {
        ...run,
        id: "run-cloned",
        pipelineId: "new-plan",
        revision: 1,
        state: "draft",
        attempts: [],
        quotes: [],
      };
      runs.unshift(created as PublicPipelineRun);
      return route.fulfill({ status: 201, json: { run: created } });
    }
    if (path.startsWith("/api/pipelines/")) {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      const found = runs.find((item) => item.id === path.split("/").at(-1));
      if (request.method() !== "GET")
        throw new Error("This UI test must not approve or submit paid stages.");
      return route.fulfill({ json: { run: found } });
    }
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [
            {
              id: project.productionProjectId,
              name: project.name,
              spend: 1.2,
              credits: 12,
              capCredits: cap,
              capUsd: 10,
              capUnlocked: false,
            },
          ],
        },
      });
    if (path === `/api/projects/${project.productionProjectId}`) {
      expect(request.method()).toBe("PATCH");
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      requests.push({ path, body });
      cap = body.capCredits;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/jobs") {
      expect(url.searchParams.get("sync")).toBe("0");
      return route.fulfill({ json: { generations: [], nextPageCursor: null } });
    }
    if (path === "/api/atomik")
      return route.fulfill({
        json: {
          chats: [],
          engines: [],
          models: {
            featured: [
              {
                id: "anthropic/claude-sonnet-4.6",
                name: "Sage 4.6",
                efforts: [{ value: "high", label: "High" }],
              },
            ],
            rest: [],
          },
        },
      });
    if (path === "/api/workbench/atomik") return route.fulfill({ json: { configured: false, models: [], jobs: [] } });
    if (path === "/api/settings")
      return route.fulfill({
        json: {
          settings: {},
          models: {
            image: "gemini-3-pro-image",
            video: "seedance-2-0",
            text: { idea: "anthropic/claude-sonnet-4.6" },
          },
        },
      });
    if (request.method() !== "GET")
      throw new Error(`Unexpected mutation ${path}`);
    return route.fulfill({ json: {} });
  });
  return { project, run, requests };
}

test("Atomik maps the saved draft, shows real plan/quote states, reuses recipes for free and exposes project budget and model controls", async ({
  page,
}, info) => {
  test.skip(
    !["workbench-360x640", "workbench-1440x900"].includes(info.project.name),
    "bounded mobile and desktop suite coverage",
  );
  const f = await fixture(page),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/atomik?project=${f.project.id}&page=runs`);
  const suite = page.getByRole("region", { name: "Atomik Super Agent suite", exact: true });
  await expect(
    suite.getByRole("heading", { name: "Runs", exact: true }),
  ).toBeVisible();
  const plan = suite.getByRole("table", {
    name: "Production plan",
    exact: true,
  });
  await expect(plan).toContainText("Dawn keyframe");
  await expect(plan).toContainText("7 cr");
  await expect(plan).toContainText("Pending / unavailable");
  await expect(
    suite.getByRole("button", { name: "Approve stage · 7 cr", exact: true }),
  ).toBeVisible();
  expect(f.requests).toEqual([]);
  const downloading = page.waitForEvent("download");
  await suite.getByRole("button", { name: "Save recipe", exact: true }).click();
  const file = await downloading;
  const recipe = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(recipe.context.projectId).toBe("actual-production");
  expect(recipe).not.toHaveProperty("quotes");
  expect(recipe).not.toHaveProperty("attempts");
  await page.screenshot({
    path: info.outputPath("atomik-runs.png"),
    animations: "disabled",
  });
  await page.goto(`/atomik?project=${f.project.id}&page=recipes`);
  await suite
    .getByRole("button", { name: "Create new run · 0 cr", exact: true })
    .click();
  await expect(page).toHaveURL(/page=runs/);
  await expect(page).toHaveURL(/run=run-cloned/);
  expect(f.requests).toHaveLength(1);
  await expect(
    suite.getByRole("button", { name: "Quote stage", exact: true }),
  ).toBeVisible();
  await page.goto(`/atomik?project=${f.project.id}&page=budget`);
  await expect(suite.getByText("12 cr", { exact: true })).toBeVisible();
  await expect(suite.getByText("100 cr", { exact: true })).toBeVisible();
  await suite.getByLabel("Project cap (credits)", { exact: true }).fill("125");
  await suite.getByRole("button", { name: "Save cap", exact: true }).click();
  await expect(suite.getByText("125 cr", { exact: true })).toBeVisible();
  expect(f.requests.at(-1)?.body).toEqual({ capCredits: 125 });
  await page.goto(`/atomik?project=${f.project.id}&page=models`);
  await expect(
    suite.getByRole("heading", { name: "Effective routing", exact: true }),
  ).toBeVisible();
  await expect(
    suite.getByRole("table", { name: "Production model catalogue" }),
  ).toContainText("Connected");
  await suite
    .getByRole("button", { name: "Thinking model", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Sage 4.6", exact: true })
    .click();
  await expect(
    suite.getByRole("combobox", { name: "Reasoning effort", exact: true }),
  ).toBeEnabled();
  await page.goto(`/atomik?project=${f.project.id}&page=runs`);
  await expect(suite.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await page.goto("/atomik?project=unavailable&page=runs");
  await expect(suite.getByRole("heading", { name: "Choose a saved project", exact: true })).toBeVisible();
  await page.goto(`/?project=${f.project.id}`);
  await expect(
    page.locator(".suite-home-card").filter({
      has: page.getByText("Atomik Super Agent", { exact: true }),
      visible: true,
    }),
  ).toHaveAttribute("href", `/atomik?project=${f.project.id}&page=runs`);
  await expect(
    page.getByRole("link", { name: "Start from a saved recipe", exact: true }),
  ).toHaveAttribute("href", `/atomik?project=${f.project.id}&page=recipes`);
  await page.goto("/?project=unavailable");
  await expect(
    page.getByLabel("Your next production brief", { exact: true }),
  ).toBeDisabled();
  await page.goto("/atomik?project=unavailable&page=runs");
  await expect(
    suite.getByRole("heading", { name: "Choose a saved project", exact: true }),
  ).toBeVisible();
  await expect(suite.getByRole("table")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
