import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import type { PublicPipelineRun } from "../lib/pipeline/service";
import { buildPipelineSpec, effectivePipelineDraft, emptyPipelineDraft, type PipelineCatalog } from "./helpers/pipelineEditor";

/**
 * A production's pipeline, through its routes: published context -> a private run -> each stage quoted, approved at its quote
 * (a replay of the approval recovers the same attempts), a paused run starts nothing it was not told to, one attempt per stage,
 * every take is the person's own and in their workspace, and a stale scope or another account's session sees nothing.
 *
 * The /pipelines page that built and drove the run is gone in Release 1 (its address opens the control room's Activity), so the
 * page steps are made through the same routes the page called, with the body the page built (tests/helpers/pipelineEditor.ts): the
 * rules a browser showed are held where they live. The movie hand-off ("Render final movie" -> /workbench/movie) went with the
 * page; the run keeps its assembled timeline, which is what is asserted.
 */

test("published production → individually approved image/video/audio stages → selected timeline and movie handoff", async ({
  page,
  playwright,
}, info) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = {
    "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}`,
  };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
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
      // This is the final setup request before cold browser-page compilation.
      // Do not retain its socket across that idle interval: Next can expire it
      // as the first scope-rejection probe starts. Never retry a paid POST.
      headers: { ...headers, Connection: "close" },
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
  /* The body the builder sent: two keyframe options become one, a sound stage of five seconds, the engines chosen above. */
  const draft = effectivePipelineDraft(
    {
      ...emptyPipelineDraft,
      name: "Morning production",
      output: "video",
      imageModel: imageModel.id,
      videoModel: videoModel.id,
      variants: 1,
      audio: "sound",
      audioSeconds: 5,
    },
    catalog as PipelineCatalog,
  );
  const spec = buildPipelineSpec(draft, (catalog as PipelineCatalog).publications[0], catalog as PipelineCatalog);
  const created = await page.request.post("/api/pipelines", { headers, data: { spec, expectedVersion: 0 } });
  expect(created.ok(), await created.text()).toBeTruthy();
  let run = (await created.json()).run as PublicPipelineRun;
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
  /* A quote prices the stage and starts nothing; nothing is made until it is approved. */
  run = await action({ action: "quote", revision: run.revision, stageId: "images" });
  expect(run.attempts).toHaveLength(0);
  const quote = run.quotes.at(-1)!;
  /* Approved at that quote. */
  const approve = { action: "approve", revision: quote.baseRevision, quoteId: quote.id, fingerprint: quote.fingerprint };
  run = await action(approve);
  const originalAttempt = run.attempts[0].id;
  // Replaying the exact approved quote after a lost response must recover the same IDs.
  run = await action(approve);
  expect(run.attempts.filter((a) => a.stageId === "images")).toHaveLength(1);
  expect(run.attempts[0].id).toBe(originalAttempt);
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
  /* The person chooses the keyframe; then the run is paused. */
  const keyframe = run.attempts.find((a) => a.stageId === "images")!;
  run = await action({
    action: "select",
    revision: run.revision,
    stageId: "selected",
    candidate: { stageId: "images", unit: 0 },
    generationId: keyframe.generationId,
  });
  run = await action({ action: "pause", revision: run.revision });
  expect(run.state).toBe("paused");
  run = await action({ action: "quote", revision: run.revision, stageId: "motion" });
  const motionQuote = run.quotes.at(-1)!;
  run = await action({ action: "approve", revision: motionQuote.baseRevision, quoteId: motionQuote.id, fingerprint: motionQuote.fingerprint });
  /* Approved while paused: its paid attempt waits, unstarted, until the run is resumed. */
  run = await current();
  expect(run.state).toBe("paused");
  expect(run.attempts.find((a) => a.stageId === "motion")?.state).toBe("queued");
  run = await action({ action: "resume", revision: run.revision });
  await settle("motion");
  run = await action({ action: "quote", revision: run.revision, stageId: "audio" });
  const audioQuote = run.quotes.at(-1)!;
  run = await action({ action: "approve", revision: audioQuote.baseRevision, quoteId: audioQuote.id, fingerprint: audioQuote.fingerprint });
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
      const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
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
  /* The run ends with its delivery edit assembled from the chosen takes. */
  run = await current();
  expect(Object.keys(run.assemblies)).toEqual(["edit"]);
  expect(errors).toEqual([]);
});
