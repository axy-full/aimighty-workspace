import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ts from "typescript";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

async function decoderFixture(page: Page) {
  const compiled = ts.transpileModule(await readFile("lib/videoFrameCapture.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const original = await readFile("tests/fixtures/astra-source.mp4");
  const requests: { path: string; method: string; scope?: string }[] = [];
  await page.route("http://frame.test/**", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/capture.js") return route.fulfill({ contentType: "text/javascript", body: compiled });
    if (url.pathname.startsWith("/api/")) {
      requests.push({ path: url.pathname + url.search, method: req.method(), scope: req.headers()["x-workbench-scope"] });
      if (url.pathname.endsWith("/oversized")) return route.fulfill({ contentType: "video/mp4", headers: { "Content-Length": String(101 * 1024 * 1024) }, body: original });
      if (url.pathname.endsWith("/wrong-mime")) return route.fulfill({ contentType: "text/html", body: "Not a video" });
      if (url.pathname.endsWith("/unavailable")) return route.fulfill({ status: 409, json: { error: "Account changed" } });
      return route.fulfill({ contentType: "video/mp4", body: original });
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local frame extraction regression</title>" });
  });
  await page.goto("http://frame.test/");
  return requests;
}

test("native first and last PNGs decode from uploaded and generated originals with a captured scope", async ({ page }) => {
  const requests = await decoderFixture(page);
  const frames = await page.evaluate(async () => {
    const { captureVideoFrame } = await Function('return import("/capture.js")')();
    const outputs = [];
    for (const origin of ["upload", "generation"]) for (const edge of ["start", "end"]) {
      const frame = await captureVideoFrame({ id: "original", origin, name: "Portrait.mp4", url: `/api/${origin === "upload" ? "uploads" : "media"}/original` }, edge, "captured-workspace");
      outputs.push({ origin, edge, width: frame.width, height: frame.height, time: frame.timeSeconds, duration: frame.durationSeconds, filename: frame.filename, bytes: Array.from(new Uint8Array(await frame.blob.arrayBuffer())) });
    }
    return outputs;
  });
  expect(requests).toEqual([
    { path: "/api/uploads/original", method: "GET", scope: "captured-workspace" },
    { path: "/api/uploads/original", method: "GET", scope: "captured-workspace" },
    { path: "/api/media/original?stream=1", method: "GET", scope: "captured-workspace" },
    { path: "/api/media/original?stream=1", method: "GET", scope: "captured-workspace" },
  ]);
  for (const frame of frames) {
    expect(frame.width).toBe(720); expect(frame.height).toBe(1280);
    expect(frame.duration).toBeCloseTo(1.5, 2);
    expect(frame.filename).toBe(`Portrait-${frame.edge}-frame.png`);
    if (frame.edge === "start") expect(frame.time).toBe(0);
    else { expect(frame.time).toBeLessThan(frame.duration); expect(frame.time).toBeGreaterThan(frame.duration - 0.002); }
    const bytes = Buffer.from(frame.bytes as number[]), image = sharp(bytes);
    expect(await image.metadata()).toMatchObject({ format: "png", width: 720, height: 1280 });
    expect((await image.stats()).channels.some(channel => channel.mean > 10)).toBe(true);
  }
  const hash = (frame: typeof frames[number]) => createHash("sha256").update(Buffer.from(frame.bytes as number[])).digest("hex");
  expect(hash(frames[0])).toBe(hash(frames[2]));
  expect(hash(frames[1])).toBe(hash(frames[3]));
  expect(hash(frames[0])).not.toBe(hash(frames[1]));
});

test("frame extraction rejects external/mismatched originals, absent scope, cancellation, oversized bodies and nonvideo responses", async ({ page }) => {
  const requests = await decoderFixture(page);
  const errors = await page.evaluate(async () => {
    const { captureVideoFrame } = await Function('return import("/capture.js")')();
    const controller = new AbortController(); controller.abort();
    const results = [];
    for (const options of [
      { id: "original", url: "https://external.invalid/video.mp4" },
      { id: "original", url: "/api/uploads/other" },
      { id: "original", scope: "" },
      { id: "original", signal: controller.signal },
      { id: "oversized" }, { id: "wrong-mime" }, { id: "unavailable" },
    ]) {
      try { await captureVideoFrame({ id: options.id, origin: "upload", name: "Original", url: options.url ?? `/api/uploads/${options.id}` }, "start", options.scope ?? "captured-workspace", options.signal); results.push("unexpected success"); }
      catch (error) { results.push((error as Error).message); }
    }
    return results;
  });
  expect(errors).toHaveLength(7); expect(errors).not.toContain("unexpected success");
  expect(requests.map(request => request.path)).toEqual(["/api/uploads/oversized", "/api/uploads/wrong-mime", "/api/uploads/unavailable"]);
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

async function controlsFixture(page: Page, holdSource = false) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const project = { ...newProject("Frame extraction"), id: "frames-draft", productionProjectId: "frames-production" };
  const original = await readFile("tests/fixtures/astra-source.mp4");
  const upload = { id: "frame-source", filename: "Portrait.mp4", kind: "video", mime: "video/mp4", durationS: 1.5, bytes: original.length, width: 720, height: 1280, createdAt: Date.now(), url: "/api/uploads/frame-source" };
  const writes: string[] = [], pngs: Buffer[] = [], filings: unknown[] = [], errors: string[] = [];
  let captures = 0, release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && message.text().includes("[particl] screen failed")) errors.push(message.text()); });
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), name = url.pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (name === "/api/me") return json(me);
    if (name === "/api/workbench/projects") return json({ project, revision: 1, projects: [{ id: project.id, name: project.name }] });
    if (name === "/api/projects") return json({ projects: [{ id: project.productionProjectId, name: project.name }] });
    if (name === "/api/uploads/frame-source/metadata") return json({ upload });
    if (name === "/api/uploads/frame-source") {
      if (req.headers()["x-workbench-scope"]) { expect(req.headers()["x-workbench-scope"]).toBe(scope); captures++; if (holdSource) await held; }
      return route.fulfill({ body: original, contentType: "video/mp4" });
    }
    if (req.method() !== "GET") { writes.push(name); expect(req.headers()["x-workbench-scope"]).toBe(scope); }
    if (name === "/api/uploads/chunk" && req.method() === "POST") {
      const form = await new Request(req.url(), { method: "POST", headers: req.headers(), body: new Uint8Array(req.postDataBuffer()!) }).formData();
      pngs.push(Buffer.from(await (form.get("chunk") as File).arrayBuffer()));
      return json({ ok: true });
    }
    if (name === "/api/uploads/finish") {
      const body = req.postDataJSON();
      return json({ id: `frame-${pngs.length}`, filename: body.filename, mime: "image/png", kind: "image", bytes: pngs.at(-1)!.length, width: 720, height: 1280, durationS: null, sha256: createHash("sha256").update(pngs.at(-1)!).digest("hex"), url: `/api/uploads/frame-${pngs.length}` });
    }
    if (name === "/api/workbench/library") {
      if (req.method() === "POST") { filings.push(req.postDataJSON()); return json({ ok: true }); }
      return json({ uploads: [], generations: [], nextCursor: null, nextPageCursor: null });
    }
    if (name === "/api/uploads") return json({ uploads: [upload], nextCursor: null, nextPageCursor: null });
    if (name.startsWith("/api/uploads/frame-")) return route.fulfill({ contentType: "image/png", body: pngs.at(-1)! });
    if (name === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (name === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "sound_effects_v1", music: "music_v1" } });
    if (name === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (name === "/api/atomik/chats") return json({ chats: [] });
    if (name === "/api/settings") return json({ settings: {}, defaults: {} });
    if (name === "/api/engines" || name === "/api/workbench/engines") return json({ engines: [], models: [] });
    return json({});
  });
  await page.goto("/subatomik?project=frames-draft&page=motion-transfer");
  const data = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData("application/x-particl-asset", JSON.stringify({ kind: "upload", upload: { id: "frame-source" } })); return data; });
  await page.getByLabel("Transform source drop area").dispatchEvent("drop", { dataTransfer: data }); await data.dispose();
  await expect(page.getByRole("button", { name: "Extract start frame", exact: true })).toBeEnabled();
  return { writes, pngs, filings, errors, release, get captures() { return captures; } };
}

test("frame controls upload full-resolution PNGs only after each explicit click and file them in the captured project", async ({ page }, testInfo) => {
  const f = await controlsFixture(page);
  expect(f.captures).toBe(0); expect(f.writes).toEqual([]);
  for (const edge of ["start", "end"]) {
    await page.getByRole("button", { name: `Extract ${edge} frame`, exact: true }).click();
    await expect(page.getByText(`${edge === "start" ? "Start" : "End"} frame saved to this project · 720 × 1280 PNG.`, { exact: true })).toBeVisible();
  }
  expect(f.captures).toBe(2); expect(f.pngs).toHaveLength(2);
  for (const png of f.pngs) expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: 720, height: 1280 });
  expect(f.filings).toEqual([{ projectId: "frames-draft", uploadId: "frame-1" }, { projectId: "frames-draft", uploadId: "frame-2" }]);
  expect(f.writes).toEqual(["/api/uploads/chunk", "/api/uploads/finish", "/api/workbench/library", "/api/uploads/chunk", "/api/uploads/finish", "/api/workbench/library"]);
  expect(f.errors).toEqual([]);
  await page.getByLabel("Extract original video frames", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("frame-controls.png") });
});

test("leaving the selected project while extracting cannot upload or attach a stale frame", async ({ page }) => {
  const f = await controlsFixture(page, true);
  await page.getByRole("button", { name: "Extract start frame", exact: true }).click();
  await expect.poll(() => f.captures).toBe(1);
  await expect(page.getByRole("button", { name: "Remove source", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review transform cost", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link", { name: "Atomik Super Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/atomik\?/);
  f.release();
  await expect(page.getByRole("region", { name: "Atomik Super Agent suite", exact: true }).getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await expect(page.getByLabel("Transform source preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Extract start frame", exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]); expect(f.filings).toEqual([]); expect(f.errors).toEqual([]);
});
