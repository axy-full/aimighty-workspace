import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { signInLocally } from "./helpers/workbenchLocal";

test("Atomik sampled-still upload uses real storage and rejects stale scope, foreign draft and corrupt media", async ({
  request,
}) => {
  await signInLocally(request);
  const me = await request.get("/api/me").then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const clip = await request.post("/api/uploads", {
    headers: { "X-Workbench-Scope": scope },
    multipart: {
      file: {
        name: "review.mp4",
        mimeType: "video/mp4",
        buffer: await readFile("public/fixtures/clip.mp4"),
      },
    },
  });
  expect(clip.ok(), await clip.text()).toBe(true);
  const source = await clip.json();
  const project = newProject("Visual reference route rehearsal");
  project.assets.push({
    id: "video-reference",
    name: "Video reference",
    kind: "video",
    category: "Reference",
    url: source.url,
    uploadId: source.id,
    mime: "video/mp4",
    description: "",
    prompt: "",
    status: "Draft",
    locked: false,
    version: 1,
    refs: [],
  });
  const saved = await request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": scope },
    data: { project, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const url =
    "/api/workbench/atomik/frames?" +
    new URLSearchParams({ projectId: project.id, assetId: "video-reference" });
  const data = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#19a6bc" },
  })
    .jpeg()
    .toBuffer();
  const headers = { "Content-Type": "image/jpeg", "X-Workbench-Scope": scope };
  expect(
    (
      await request.post(url, {
        data,
        headers: { ...headers, "X-Workbench-Scope": scope + "-stale" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post(url.replace(project.id, randomUUID()), {
        data,
        headers,
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.post(url, { data: Buffer.from("not an image"), headers })
    ).status(),
  ).toBe(422);
  const uploaded = await request.post(url, { data, headers });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const frame = await uploaded.json();
  const media = await request.get("/api/uploads/" + frame.id);
  expect(media.ok()).toBe(true);
  expect(await sharp(await media.body()).metadata()).toMatchObject({
    format: "jpeg",
    width: 320,
    height: 180,
  });
  const state = await request.get(
    "/api/workbench/atomik?projectId=" + project.id,
  );
  expect(state.ok(), await state.text()).toBe(true);
  expect(await state.text()).not.toMatch(
    /estimateUsd|costUsd|inputPerMillion|outputPerMillion|budgets/,
  );
  const unsupported = await request.post("/api/workbench/atomik", {
    headers: { "X-Workbench-Scope": scope },
    data: {
      projectId: project.id,
      requestId: randomUUID(),
      request: "Review the video composition",
      refs: ["video-reference"],
      quoteOnly: true,
    },
  });
  expect(unsupported.status()).toBe(422);
  expect(await unsupported.text()).toContain("three representative frames");
});
