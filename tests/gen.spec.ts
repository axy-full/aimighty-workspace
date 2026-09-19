import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { newProject } from "../lib/workbench/studio";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";

test("Gen Seedance Edit recovers a lost submission after returning to Studio without buying a second edit", async ({
  page,
}, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const draft = { ...newProject("Gen fixture"), id: "gen-draft", productionProjectId: "project-fixture" };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const submissions: { body: string | null; key: string }[] = [];
  let quotes = 0,
    uploaded = false;
  const reference = {
    id: "edit-look",
    filename: "Blue hour.png",
    mime: "image/png",
    kind: "image",
    width: 256,
    height: 256,
    bytes: 1000,
    durationS: null,
    url: "/api/uploads/edit-look",
    sha256: "fixture",
  };
  const source = {
    id: "edit-source",
    filename: "Camera original.mp4",
    mime: "video/mp4",
    kind: "video",
    width: 1280,
    height: 720,
    bytes: 1000,
    durationS: 12.5,
    url: "/api/uploads/edit-source",
    sha256: "fixture",
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      pathname = url.pathname;
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (pathname === "/api/me") return json(me);
    if (pathname === "/api/workbench/projects") return json({ project: draft, revision: 1, projects: [{ id: draft.id, name: draft.name }], productions: [] });
    if (pathname === "/api/workbench/development") return json({ configured: true, models: [], jobs: [] });
    if (pathname === "/api/workbench/library") {
      expect(req.headers()["x-workbench-scope"]).toBe(`particl-active-${me.workspace.id}-${me.id}`);
      if (req.method() === "POST") { expect(req.postDataJSON()).toEqual({ projectId: draft.id, uploadId: source.id }); return json({ ok: true }); }
      return json({ uploads: uploaded ? [reference, source] : [reference], generations: [], nextCursor: null, nextPageCursor: null });
    }
    if (pathname === "/api/jobs") return json({ generations: [] });
    if (pathname === "/api/cast") return json({ cast: [] });
    if (pathname === "/api/productions") return json({ productions: [] });
    if (pathname === "/api/uploads" && req.method() === "GET")
      return json({ uploads: uploaded ? [reference, source] : [reference] });
    if (pathname === "/api/uploads/chunk") return json({ ok: true });
    if (pathname === "/api/uploads/finish") {
      uploaded = true;
      return json(source);
    }
    if (pathname.startsWith("/api/uploads/edit-"))
      return route.fulfill({
        path: pathname.endsWith("source")
          ? "public/fixtures/clip.mp4"
          : "public/fixtures/still.png",
        contentType: pathname.endsWith("source") ? "video/mp4" : "image/png",
      });
    if (pathname === "/api/generate/quote") {
      quotes++;
      expect(req.headers()["x-workbench-scope"]).toBe(
        `particl-active-${me.workspace.id}-${me.id}`,
      );
      expect(req.postDataJSON()).toMatchObject({
        model: "dreamina-seedance-2-5-260628",
        task: "edit",
        sourceUploadId: "edit-source",
        refine: false,
        references: [{ uploadId: "edit-look", role: "reference_image" }],
      });
      return json({
        fingerprint: "a".repeat(64),
        estimatedCredits: 24,
        price: 24,
        unit: "cr",
      });
    }
    if (pathname === "/api/generate") {
      submissions.push({
        body: req.postData(),
        key: req.headers()["idempotency-key"],
      });
      expect(req.headers()["x-workspace-id"]).toBe(me.workspace.id);
      if (submissions.length === 1) return route.abort("failed");
      return json({ id: "recovered-edit", status: "queued" }, 202);
    }
    return route.fallback();
  });
  await page.goto(`/generate?project=${draft.id}`);
  await page.getByRole("button", { name: "Engine", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Choose a model" })
    .getByRole("button", { name: /Seedance 2.5 Edit/ })
    .click();
  const editor = page.getByRole("region", {
    name: "Seedance 2.5 Edit",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /Review edit cost/ }),
  ).toBeDisabled();
  await editor
    .getByLabel("Upload edit source", { exact: true })
    .setInputFiles("public/fixtures/clip.mp4");
  await expect(editor.getByLabel("Source clip", { exact: true })).toHaveValue(
    "upload:edit-source",
  );
  await editor.getByLabel(/Visual references/).selectOption("upload:edit-look");
  await editor
    .getByLabel("Edit direction", { exact: true })
    .fill("Change the daylight to blue hour. Preserve the actor and dialogue.");
  await editor.getByRole("button", { name: /Review edit cost/ }).click();
  await expect(
    editor.getByRole("button", { name: /Generate edit.*24 cr/ }),
  ).toBeEnabled();
  expect(submissions).toHaveLength(0);
  await editor
    .getByLabel("Edit direction", { exact: true })
    .fill(
      "Change the daylight to blue hour. Preserve the actor, camera and dialogue.",
    );
  await expect(
    editor.getByRole("button", { name: /Review edit cost/ }),
  ).toBeEnabled();
  await editor.getByRole("button", { name: /Review edit cost/ }).click();
  const primary = editor.getByRole("button", { name: /Generate edit.*24 cr/ });
  await expect(primary).toBeEnabled();
  const box = await primary.boundingBox(),
    size = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
  const price = primary.locator("strong");
  expect(
    await price.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("seedance-edit.png") });
  await primary.click();
  await expect(
    editor.getByRole("button", { name: /Recover edit/ }),
  ).toBeEnabled();
  const savedGenUrl = page.url();
  await page.getByRole("navigation", { name: "Rooms", exact: true }).getByRole("link", { name: "Production", exact: true }).click();
  await expect(page).toHaveURL(/\/workbench\?.*stage=brief/);
  await expect(editor).toHaveCount(0);
  expect(submissions).toHaveLength(1);
  await page.goto(savedGenUrl);
  await expect(
    editor.getByLabel("Edit direction", { exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText("@Image1 · Blue hour.png", { exact: true }),
  ).toBeVisible();
  await editor.getByRole("button", { name: /Recover edit/ }).click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(
    page.getByText("Edit queued. Its progress is in Your takes.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /Recover edit/ }),
  ).toHaveCount(0);
  expect(quotes).toBe(2);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(JSON.parse(submissions[0].body!)).toMatchObject({
    task: "edit",
    sourceUploadId: "edit-source",
    maxCredits: 24,
    quoteFingerprint: "a".repeat(64),
  });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("Gen makes video, images and each audio kind with quoted requests, then reviews and reuses takes", async ({
  page,
}, testInfo) => {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const draft = { ...newProject("Gen fixture"), id: "gen-draft", productionProjectId: "project-fixture" };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const submissions: {
    path: string;
    body: Record<string, unknown>;
    key?: string;
    workspace?: string;
    actor?: string;
  }[] = [];
  const patches: unknown[] = [];
  let uploaded = 0;
  const jobs = (["video", "image", "audio"] as const).map((kind) => ({
    id: `gen-fixture-${kind}`,
    kind,
    model:
      kind === "image"
        ? "gemini-3-pro-image"
        : kind === "video"
          ? "seedance-2.5"
          : "mock-speech",
    prompt: `An existing ${kind} take to reuse.`,
    title: `Fixture ${kind}`,
    status: "succeeded",
    storedUrl: `/api/media/gen-fixture-${kind}`,
    sourceUrl: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creditsBilled: 7,
    costUsd: null,
    refineCostUsd: null,
    params: { duration: 5, resolution: kind === "image" ? "1K" : "1080p" },
    authorName: "Local artist",
    error: null,
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects") return json({ project: draft, revision: 1, projects: [{ id: draft.id, name: draft.name }], productions: [] });
    if (path === "/api/workbench/library") {
      expect(request.headers()["x-workbench-scope"]).toBe(`particl-active-${me.workspace.id}-${me.id}`);
      if (request.method() === "POST") { expect(request.postDataJSON().projectId).toBe(draft.id); return json({ ok: true }); }
      return json({ uploads: [], generations: jobs.filter(g => !url.searchParams.get("q") || g.prompt.includes(url.searchParams.get("q")!)), nextCursor: null, nextPageCursor: null });
    }
    if (path === "/api/uploads/chunk") return json({ ok: true });
    if (path === "/api/uploads/finish" && request.method() === "POST") {
      expect(request.headers()["x-workbench-scope"]).toBe(
        `particl-active-${me.workspace.id}-${me.id}`,
      );
      uploaded++;
      const video = uploaded > 2;
      return json({
        id: `gen-reference-${uploaded}`,
        filename: video ? `clip-${uploaded}.mp4` : `frame-${uploaded}.png`,
        mime: video ? "video/mp4" : "image/png",
        kind: video ? "video" : "image",
        bytes: 1000,
        base64Bytes: 1400,
        width: 256,
        height: 256,
        durationS: uploaded === 4 ? 15 : null,
        sha256: `fixture-${uploaded}`,
        url: `/api/uploads/gen-reference-${uploaded}`,
      });
    }
    if (
      path.startsWith("/api/uploads/gen-reference-") &&
      request.method() === "GET"
    )
      return route.fulfill({
        contentType:
          Number(path.split("-").at(-1)) > 2 ? "video/mp4" : "image/png",
        path:
          Number(path.split("-").at(-1)) > 2
            ? "public/fixtures/clip.mp4"
            : "public/fixtures/still.png",
      });
    if (path === "/api/jobs")
      return json({
        generations: jobs.filter(
          (g) =>
            (!url.searchParams.has("kind") || g.kind === url.searchParams.get("kind")) &&
            (!url.searchParams.get("q") ||
              g.prompt.includes(url.searchParams.get("q")!)),
        ),
      });
    if (path === "/api/productions")
      return json({
        productions: [
          {
            id: "production-fixture",
            name: "Test production",
            projects: [{ id: "project-fixture", name: "Main film", shots: 1 }],
          },
        ],
      });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/cast") return json({ cast: [] });
    if (path === "/api/rig/elements") return json({ elements: [] });
    if (path === "/api/shots")
      return json({
        shots: [
          {
            id: "shot-fixture",
            code: "SH01",
            title: "Opening",
            description: "The opening frame",
          },
        ],
      });
    if (path.startsWith("/api/jobs/") && request.method() === "PATCH") {
      patches.push(request.postDataJSON());
      return json({ ok: true });
    }
    if (path.startsWith("/api/media/"))
      return route.fulfill({
        contentType: path.endsWith("-image") ? "image/png" : "video/mp4",
        path: path.endsWith("-image")
          ? "public/fixtures/still.png"
          : "public/fixtures/clip.mp4",
      });
    if (path === "/api/audio" && request.method() === "GET")
      return json({
        configured: true,
        speechModels: [
          {
            id: "mock-speech",
            label: "Mock speech",
            creditsPerChar: 0.1,
            note: "Local test",
          },
        ],
        defaultSpeechModel: "mock-speech",
        voices: [
          {
            id: "mock-voice",
            name: "Avery",
            labels: { language: "English" },
            description: "Local voice",
            previewUrl: null,
          },
        ],
        voicesError: null,
        account: null,
        terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
      });
    if (
      (path === "/api/audio" || path === "/api/generate") &&
      request.method() === "POST"
    ) {
      const body = request.postDataJSON();
      if (body.quoteOnly)
        return json({ estimatedCredits: 14, price: 14, unit: "cr" });
      submissions.push({
        path,
        body,
        key: request.headers()["idempotency-key"],
        workspace: request.headers()["x-workspace-id"],
        actor: request.headers()["x-actor-email"],
      });
      return json({ id: `gen-new-${submissions.length}`, status: "running" });
    }
    if (request.method() !== "GET")
      throw new Error(`Unexpected mutation ${path}`);
    return route.fallback();
  });
  const mobile = page.viewportSize()!.width < 900;
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  const primary = page.locator("[data-render]").filter({ visible: true });
  const showTakes = async () => {
    if (mobile)
      await page
        .getByRole("group", { name: "Generation view" })
        .getByRole("button", { name: /^Takes/ })
        .click();
    await page.getByRole("group", { name: "Asset source", exact: true }).getByRole("button", { name: "Generations", exact: true }).click();
  };
  const showCreate = async () => {
    if (mobile)
      await page
        .getByRole("group", { name: "Generation view" })
        .getByRole("button", { name: "Create", exact: true })
        .click();
  };
  const viewport = async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBeTruthy();
    const box = await primary.boundingBox(),
      size = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
    const suitePages = page.getByRole("navigation", { name: "Particl Production Studio pages", exact: true });
    if (await suitePages.isVisible()) {
      const navigation = await suitePages.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(navigation!.y + 1);
    }
  };
  await page.goto(`/generate?project=${draft.id}`);
  await expect(
    page.getByRole("heading", { name: page.viewportSize()!.width <= 759 ? "Generation workspace" : /^Gen.*Video$/ }),
  ).toBeVisible();
  await expect(primary).toBeDisabled();
  await prompt.fill("An isolated slow tracking shot through soft light.");
  await viewport();
  await page.getByRole("button", { name: "Engine", exact: true }).click();
  const models = page.getByRole("dialog", { name: "Choose a model" });
  await expect(models).toBeVisible();
  await models.getByRole("button", { name: /Seedance 2.0/ }).click();
  await expect(models).not.toBeVisible();
  await page.getByRole("button", { name: /^Aspect:/ }).click();
  await page.getByRole("menuitem", { name: "9:16", exact: true }).click();
  const frame = await readFile("public/fixtures/still.png");
  const referencePicker = page.getByRole("region", { name: "Video composer", exact: true }).locator('input[type="file"]');
  await referencePicker.setInputFiles([
    { name: "frame-1.png", mimeType: "image/png", buffer: frame },
    { name: "frame-2.png", mimeType: "image/png", buffer: frame },
  ]);
  await expect(
    page.getByRole("button", { name: "Remove frame-2.png" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Generation mode" })
    .getByRole("button", { name: "Video", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Aspect:/ })).toContainText(
    "9:16",
  );
  await expect(
    page.getByRole("button", { name: "Engine", exact: true }),
  ).toContainText("Seedance 2.0");
  await expect(
    page.getByRole("button", { name: "Remove frame-1.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove frame-2.png" }),
  ).toBeVisible();
  await expect(prompt).toHaveValue(
    "An isolated slow tracking shot through soft light.",
  );
  await expect(page.getByLabel("First frame", { exact: true })).toBeVisible();
  await expect(page.getByLabel("First frame", { exact: true })).toHaveValue("");
  await page.getByLabel("First frame", { exact: true }).selectOption("upload:gen-reference-1");
  await expect(primary).toBeDisabled(); // Frames cannot be combined with ordinary references.
  expect(submissions).toHaveLength(0);
  await page.getByLabel("First frame", { exact: true }).selectOption("");
  await expect(primary).toBeEnabled();
  await expect(primary).toContainText(/\d+ cr/);
  const beforeClip = Number((await primary.innerText()).match(/(\d+) cr/)![1]);
  const clip = await readFile("public/fixtures/clip.mp4");
  await referencePicker.setInputFiles({
    name: "clip-3.mp4",
    mimeType: "video/mp4",
    buffer: clip,
  });
  await expect(
    page.getByRole("button", { name: "Remove clip-3.mp4" }),
  ).toBeVisible();
  await expect(primary).toBeDisabled();
  await page.getByRole("button", { name: "Remove clip-3.mp4" }).click();
  await expect(primary).toBeEnabled();
  await referencePicker.setInputFiles({
    name: "clip-4.mp4",
    mimeType: "video/mp4",
    buffer: clip,
  });
  await expect(
    page.getByRole("button", { name: "Remove clip-4.mp4" }),
  ).toBeVisible();
  await expect(primary).toBeEnabled();
  const quotedWithClip = Number(
    (await primary.innerText()).match(/(\d+) cr/)![1],
  );
  expect(quotedWithClip).toBeGreaterThan(beforeClip);
  await primary.click();
  await expect(prompt).toHaveValue("");
  expect(submissions[0].body.ratio).toBe("9:16");
  expect(submissions[0].body.duration).toBe(5);
  expect(submissions[0].body.model).toBe("dreamina-seedance-2-0-260128");
  expect(submissions[0].body.references).toEqual([
    { uploadId: "gen-reference-1", role: "reference_image" },
    { uploadId: "gen-reference-2", role: "reference_image" },
    { uploadId: "gen-reference-4", role: "reference_video" },
  ]);
  expect(submissions[0].body.maxCredits).toBe(quotedWithClip);
  await showTakes();
  await page
    .getByRole("button", { name: "Preview Fixture video", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Fixture video" }).locator("video"),
  ).toHaveJSProperty("readyState", 4);
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  const videoTake = page.locator('[data-library-id="generation:gen-fixture-video"]');
  await videoTake.getByRole("button", { name: "Actions for Fixture video", exact: true }).click();
  await page.getByRole("menuitem", { name: "File to shot", exact: true }).click();
  await page.getByLabel("Project for take", { exact: true }).selectOption("project-fixture");
  await page.getByRole("button", { name: /SH01/ }).click();
  expect(patches).toEqual([{ shotId: "shot-fixture" }]);
  const before = submissions.length;
  await videoTake.getByRole("button", { name: "Actions for Fixture video", exact: true }).click();
  await page.getByRole("menuitem", { name: "Use prompt", exact: true }).click();
  await expect(prompt).toHaveValue("An existing video take to reuse.");
  expect(submissions).toHaveLength(before);
  await page.screenshot({
    path: testInfo.outputPath("gen-video.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Generation mode" })
    .getByRole("button", { name: "Images", exact: true })
    .click();
  await expect(page).toHaveURL(url => url.pathname === "/generate" && url.searchParams.get("mode") === "images" && url.searchParams.get("project") === draft.id);
  await expect(prompt).toHaveValue("");
  await prompt.fill("An isolated still life with a brass key.");
  await viewport();
  await primary.click();
  await expect(prompt).toHaveValue("");
  expect(submissions[1].body.model).toBe("gemini-3-pro-image");
  await showTakes();
  await page
    .getByRole("button", { name: "Preview Fixture image", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Fixture image" }).locator("img"),
  ).toHaveJSProperty("naturalWidth", 256);
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await showCreate();
  await page.screenshot({
    path: testInfo.outputPath("gen-images.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Generation mode" })
    .getByRole("button", { name: "Audio", exact: true })
    .click();
  await expect(page).toHaveURL(url => url.pathname === "/generate" && url.searchParams.get("mode") === "audio" && url.searchParams.get("project") === draft.id);
  for (const [label, task, text] of [
    ["Dialogue", "speech", "A line spoken in a calm voice."],
    ["Music", "music", "Slow strings and quiet piano."],
    ["Ambient", "sound", "Soft rain under a distant train."],
  ] as const) {
    await page
      .getByRole("group", { name: "Track kind" })
      .getByRole("button", { name: label, exact: true })
      .click();
    await prompt.fill(text);
    await expect(primary).toContainText("14 cr");
    await expect(primary).toBeEnabled();
    await viewport();
    await primary.click();
    await expect(prompt).toHaveValue("");
    expect(submissions.at(-1)?.body.task).toBe(task);
    expect(submissions.at(-1)?.body.maxCredits).toBe(14);
  }
  await page.screenshot({
    path: testInfo.outputPath("gen-audio.png"),
    fullPage: true,
  });
  expect(submissions).toHaveLength(5);
  for (const request of submissions) {
    expect(request.key).toBeTruthy();
    expect(request.workspace).toBe(account.workspace.id);
    expect(request.actor).toBe(me.email);
    expect(Number.isInteger(request.body.maxCredits)).toBeTruthy();
  }
  expect(new Set(submissions.map((item) => item.key)).size).toBe(5);
  expect(errors).toEqual([]);
});

test("a stale Gen tab cannot upload into another workspace or another account in the same workspace", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one real local captured-upload regression",
  );
  const first = await signInLocally(page.request);
  const owner = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const captured = `particl-active-${owner.workspace.id}-${owner.id}`;
  const draft = newProject("Captured upload project");
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": captured }, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(`/generate?mode=video&project=${draft.id}`);
  const picker = page.locator('input[type="file"][accept="image/*,video/*"]');
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#5b7280" },
  })
    .png()
    .toBuffer();
  async function select(name: string, stale = false) {
    await expect(picker).toBeEnabled();
    const response = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(stale ? "/api/uploads/chunk" : "/api/uploads/finish") &&
        response.request().method() === "POST",
    );
    await picker.setInputFiles({ name, mimeType: "image/png", buffer: bytes });
    const upload = await response;
    expect(upload.request().headers()["x-workbench-scope"]).toBe(captured);
    return upload;
  }
  const initial = await select("original-reference.png");
  expect(initial.ok(), await initial.text()).toBe(true);
  await signInLocally(page.request); // Cookie changes, while the original document stays mounted.
  const member = await page.request
    .get("/api/me")
    .then((response) => response.json());
  expect(member.workspace.id).not.toBe(first.workspace.id);
  const foreign = await select("private-to-original-workspace.png", true);
  expect(foreign.status()).toBe(409);
  expect((await foreign.json()).error).toMatch(/account or workspace changed/i);
  expect(
    (await page.request.get("/api/uploads").then((response) => response.json()))
      .uploads,
  ).toEqual([]);

  const code = randomBytes(18).toString("base64url");
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        code,
        first.workspace.id,
        member.email,
        "Another crew member",
        "member",
        owner.id,
        Date.now(),
        Date.now() + 3_600_000,
      ],
    });
  } finally {
    platform.close();
  }
  const accepted = await page.request.post("/api/auth/accept", {
    data: { code },
  });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  const current = await page.request
    .get("/api/me")
    .then((response) => response.json());
  expect(current.workspace.id).toBe(first.workspace.id);
  expect(current.id).not.toBe(owner.id);
  expect((await select("private-to-original-account.png", true)).status()).toBe(
    409,
  );
  expect(
    (await page.request.get("/api/uploads").then((response) => response.json()))
      .uploads,
  ).toHaveLength(1);
  const followup = await page.request.post("/api/cast", {
    headers: { "X-Workbench-Scope": captured },
    data: { name: "Old private character", kind: "character" },
  });
  expect(followup.status()).toBe(409);
  expect(
    (await page.request.get("/api/cast").then((response) => response.json()))
      .cast,
  ).toEqual([]);
});
