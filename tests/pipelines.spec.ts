import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import type { PublicPipelineRun } from "../lib/pipeline/service";

test("published production → individually approved image/video/audio stages → selected timeline and movie handoff", async ({
  page,
  playwright,
}, info) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = {
    "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}`,
  };
  const platform = createClient({ url: localPlatformDbUrl() });
  await platform.execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    args: [
      randomUUID(),
      me.workspace.id,
      10000,
      "Local mock pipeline test",
      "admin",
      "test",
      Date.now(),
    ],
  });
  platform.close();
  const project = newProject("Pipeline acceptance");
  project.brief = "A quiet desert at dawn.";
  project.script = "Soft wind in the sand.";
  const saved = await page.request.put("/api/workbench/projects", {
    headers,
    data: { project, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const savedBody = await saved.json();
  const published = await page.request.post("/api/workbench/projects", {
    headers,
    data: { action: "publish", projectId: project.id, expectedBibleVersion: 0 },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  const catalog = await page.request
    .get(`/api/pipelines?projectId=${savedBody.productionProjectId}`, {
      headers,
    })
    .then((r) => r.json());
  const imageModel = catalog.models.find(
    (m: { id: string; kind: string }) =>
      m.kind === "image" && m.id.startsWith("gemini"),
  );
  const videoModel = catalog.models.find(
    (m: { id: string; kind: string }) =>
      m.kind === "video" && m.id.includes("seedance"),
  );
  expect(imageModel).toBeTruthy();
  expect(videoModel).toBeTruthy();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/pipelines?projectId=${savedBody.productionProjectId}`);
  await expect(
    page.getByRole("heading", { name: "Build a pipeline" }),
  ).toBeVisible();
  await page.getByLabel("Pipeline name").fill("Morning production");
  await page
    .getByLabel("Image engine", { exact: true })
    .selectOption(imageModel.id);
  await page
    .getByLabel("Video engine", { exact: true })
    .selectOption(videoModel.id);
  await page
    .getByRole("combobox", { name: "Image options", exact: true })
    .selectOption("1");
  await page
    .getByRole("combobox", { name: "Audio stage", exact: true })
    .selectOption("sound");
  await page.getByLabel("Audio duration (seconds)").fill("5");
  await page.screenshot({
    path: info.outputPath("pipeline-builder.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/pipelines") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create private run" }).click();
  const response = await created;
  expect(response.ok(), await response.text()).toBeTruthy();
  let run = (await response.json()).run as PublicPipelineRun;
  const current = async () =>
    (
      await page.request
        .get(`/api/pipelines/${run.id}`, { headers })
        .then((r) => r.json())
    ).run as PublicPipelineRun;
  const action = async (body: Record<string, unknown>) => {
    const res = await page.request.post(`/api/pipelines/${run.id}`, {
      headers,
      data: body,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).run as PublicPipelineRun;
  };
  expect(run.context).toEqual({
    projectId: savedBody.productionProjectId,
    bibleVersion: 1,
  });
  expect(run.attempts).toHaveLength(0);
  expect(JSON.stringify(run)).not.toContain('"prepared"');
  expect(JSON.stringify(run)).not.toContain('"compiled"');
  for (const scope of [
    `particl-active-${me.workspace.id}-other-account`,
    `particl-active-other-workspace-${me.id}`,
  ]) {
    const stale = await page.request.post(`/api/pipelines/${run.id}`, {
      headers: { "X-Workbench-Scope": scope },
      data: { action: "quote", revision: run.revision, stageId: "images" },
    });
    expect(stale.status()).toBe(409);
  }
  const imageStage = page.getByRole("article", {
    name: "Keyframe options",
    exact: true,
  });
  await imageStage
    .getByRole("button", { name: "Quote stage", exact: true })
    .click();
  await expect(
    imageStage.getByRole("button", { name: /^Approve stage/ }),
  ).toBeVisible();
  run = await current();
  const quote = run.quotes.at(-1)!;
  await imageStage.getByRole("button", { name: /^Approve stage/ }).click();
  // Replaying the exact approved quote after a lost response must recover the same IDs.
  run = await action({
    action: "approve",
    revision: quote.baseRevision,
    quoteId: quote.id,
    fingerprint: quote.fingerprint,
  });
  const originalAttempt = run.attempts[0].id;
  const settle = async (stageId: string) => {
    await expect
      .poll(
        async () => {
          await page.request.get(
            `/api/jobs?projectId=${savedBody.productionProjectId}`,
          );
          run = await action({ action: "recover" });
          run = await current();
          return run.attempts.find((a) => a.stageId === stageId)?.state;
        },
        { timeout: 60000, intervals: [500, 1000, 2000] },
      )
      .toBe("succeeded");
  };
  await settle("images");
  expect(run.attempts.filter((a) => a.stageId === "images")).toHaveLength(1);
  expect(run.attempts[0].id).toBe(originalAttempt);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Morning production", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Choose a keyframe", exact: true })
    .getByRole("button", { name: "Select take 1" })
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const motionStage = page.getByRole("article", {
    name: "Motion",
    exact: true,
  });
  await motionStage
    .getByRole("button", { name: "Quote stage", exact: true })
    .click();
  await motionStage.getByRole("button", { name: /^Approve stage/ }).click();
  run = await current();
  expect(run.state).toBe("paused");
  expect(run.attempts.find((a) => a.stageId === "motion")?.state).toBe(
    "queued",
  );
  await page.getByRole("button", { name: "Resume approved work" }).click();
  await settle("motion");
  await page.reload();
  const audioStage = page.getByRole("article", { name: "Sound", exact: true });
  await audioStage
    .getByRole("button", { name: "Quote stage", exact: true })
    .click();
  await audioStage.getByRole("button", { name: /^Approve stage/ }).click();
  await settle("audio");
  await expect
    .poll(
      async () => {
        run = await current();
        return run.state;
      },
      { timeout: 15000 },
    )
    .toBe("succeeded");
  expect(run.attempts.map((a) => a.kind).sort()).toEqual([
    "audio",
    "image",
    "video",
  ]);
  for (const attempt of run.attempts) {
    expect(attempt.url).toMatch(/^\/api\/media\//);
    const media = await page.request.get(attempt.url!);
    expect(media.status()).toBe(200);
    expect((await media.body()).length).toBeGreaterThan(100);
  }
  if (info.project.name === "customer-1440x900") {
    const collaborator = await playwright.request.newContext({
      baseURL: process.env.PW_BASE_URL || "http://localhost:4551",
    });
    try {
      await signInLocally(collaborator);
      const other = await collaborator.get("/api/me").then((r) => r.json());
      const platform = createClient({ url: localPlatformDbUrl() });
      await platform.execute({
        sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'member',0,?)",
        args: [me.workspace.id, other.id, Date.now()],
      });
      platform.close();
      const switched = await collaborator.post("/api/workspaces/switch", {
        headers: {
          "X-Workbench-Scope": `particl-active-${other.workspace.id}-${other.id}`,
        },
        data: { id: me.workspace.id },
      });
      expect(switched.ok(), await switched.text()).toBeTruthy();
      const otherHeaders = {
        "X-Workbench-Scope": `particl-active-${me.workspace.id}-${other.id}`,
      };
      expect(
        (
          await collaborator.get(`/api/pipelines/${run.id}`, {
            headers: otherHeaders,
          })
        ).status(),
      ).toBe(404);
      expect(
        (
          await collaborator.post(`/api/pipelines/${run.id}`, {
            headers: otherHeaders,
            data: { action: "recover" },
          })
        ).status(),
      ).toBe(404);
      const otherCatalog = await collaborator
        .get(`/api/pipelines?projectId=${run.context.projectId}`, {
          headers: otherHeaders,
        })
        .then((r) => r.json());
      expect(otherCatalog.runs).toHaveLength(0);
      expect(otherCatalog.publications).toHaveLength(1);
      const own = await collaborator.post("/api/pipelines", {
        headers: otherHeaders,
        data: {
          spec: {
            schemaVersion: 1,
            name: "Collaborator run",
            context: run.context,
            stages: run.stages.map((s) => s.definition),
          },
          expectedVersion: 0,
        },
      });
      expect(own.ok(), await own.text()).toBeTruthy();
      const ownRun = (await own.json()).run;
      expect(ownRun.attempts).toHaveLength(0);
      expect(
        (
          await page.request.get(`/api/pipelines/${ownRun.id}`, { headers })
        ).status(),
      ).toBe(404);
    } finally {
      await collaborator.dispose();
    }
  }
  const jobs = await page.request
    .get(`/api/jobs?projectId=${savedBody.productionProjectId}`)
    .then((r) => r.json());
  expect(jobs.generations).toHaveLength(3);
  await page.reload();
  const delivery = page.getByRole("article", {
    name: "Delivery edit",
    exact: true,
  });
  await expect(
    delivery.getByRole("button", { name: "Render final movie" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("pipeline-completed.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await delivery.getByRole("button", { name: "Render final movie" }).click();
  await expect(page).toHaveURL(/\/workbench\/movie\?snapshot=/);
  await expect(
    page.getByRole("heading", { name: /final movie/i }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
