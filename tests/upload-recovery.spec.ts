import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * A lost upload is recovered, not repeated: a file whose finish reply was lost is resumed after a reload as the same stored upload
 * (the bytes are not sent again), a paused one asks for the original file and sends only the missing chunk, and another account
 * sees nothing of either. The upload goes in through the board's own file input (the Library's add-a-file), which keeps the
 * project-scoped envelope the old Gen page's reference picker kept; the recovery panel (components/UploadRecovery.tsx) is
 * the shell's. Retargeted from /generate (retired in Release 1); the board is the desktop's.
 */
/** The board's file input: a saved project's board holds one, hidden, which the Library and the empty board press. */
const boardFiles = (page: Page) => page.locator('input[type="file"]:not([accept])').first();

/** A saved project, so recovered originals remain project-scoped. */
async function savedProject(page: Page, scope: string) {
  const headers = { "X-Workbench-Scope": scope };
  const production = await page.request.post("/api/projects", {
    headers,
    data: { name: "Upload recovery project" },
  });
  expect(production.ok(), await production.text()).toBe(true);
  const draft = {
    ...newProject("Upload recovery project"),
    productionProjectId: (await production.json()).id,
  };
  const saved = await page.request.put("/api/workbench/projects", {
    headers,
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return draft.id;
}

async function uploadEntries(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("particl:upload:v1:"))
      .map(([, value]) => JSON.parse(value)),
  );
}

test("a lost upload finish response recovers the same stored upload after reload without sending file bytes again", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "real desktop upload recovery (the board is the desktop's)",
  );
  const account = await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const projectId = await savedProject(page, scope);
  let finishes = 0,
    chunks = 0,
    filings = 0,
    original = "";
  /* The drop that lost its answer never filed the upload; the resume files it into this project, once. */
  await page.route("**/api/workbench/library", async (route) => {
    if (route.request().method() === "POST") {
      filings++;
      expect(route.request().postDataJSON()).toEqual({ projectId, uploadId: original });
    }
    await route.continue();
  });
  await page.route("**/api/uploads/chunk", async (route) => {
    if (route.request().method() === "POST") chunks++;
    await route.continue();
  });
  await page.route("**/api/uploads/finish", async (route) => {
    finishes++;
    expect(route.request().headers()["x-workbench-scope"]).toBe(scope);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    original = (await response.json()).id;
    await route.abort("failed"); // Server committed; only its response is lost.
  });
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#314b68" },
  })
    .png()
    .toBuffer();
  await page.goto(
    `/suites?project=${encodeURIComponent(projectId)}&view=board`,
  );
  const referencePicker = boardFiles(page);
  await expect(page.getByTestId("board")).toBeVisible();
  await referencePicker.setInputFiles({
    name: "recover-reference.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect
    .poll(async () => {
      const entry = (await uploadEntries(page))[0];
      return entry?.state === "pending" && Boolean(entry.error);
    })
    .toBe(true);
  await expect.poll(() => finishes).toBe(1);
  const pending = (await uploadEntries(page))[0];
  expect(pending.scope).toBe(scope);
  expect(pending.projectId).toBe(projectId);
  expect(filings).toBe(0);
  expect(pending.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(pending).length).toBeLessThan(2000);
  await page.reload();
  await page.locator("summary").filter({ hasText: "Uploads" }).click();
  const recovery = page.getByRole("region", { name: "Upload recovery" });
  await recovery
    .getByRole("button", { name: "Resume upload", exact: true })
    .click();
  await expect(
    recovery.getByText("Upload ready", { exact: true }),
  ).toBeVisible();
  await expect(
    recovery.getByRole("link", { name: "Open uploaded file" }),
  ).toHaveAttribute("href", `/api/uploads/${original}`);
  expect(finishes).toBe(1);
  expect(chunks).toBe(1);
  await expect.poll(() => filings).toBe(1);
  await expect.poll(async () => typeof (await uploadEntries(page))[0].filedAt).toBe("number");
  const library = await page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(projectId)}&source=uploads&limit=60`, { headers: { "X-Workbench-Scope": scope } });
  expect(library.ok(), await library.text()).toBe(true);
  expect((await library.json()).uploads.map((u: { id: string }) => u.id)).toEqual([original]);
  // Retry only a transport reset on this read; never repeat a write or HTTP failure.
  const listed = await page.request.get("/api/uploads", { maxRetries: 1 });
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const uploaded = await listed.json();
  expect(uploaded.uploads).toHaveLength(1);
  expect(uploaded.uploads[0].id).toBe(original);
  expect((await uploadEntries(page))[0].session).toBe(pending.session);
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.evaluate(() => innerWidth),
  );
  await page.screenshot({
    path: testInfo.outputPath("upload-recovered.png"),
    fullPage: true,
  });
  // A new account sees neither the old filename nor an action for its pending session.
  await signInLocally(page.request);
  const second = await page.request
    .get("/api/me")
    .then((response) => response.json());
  expect(second.workspace.id).not.toBe(account.workspace.id);
  await page.reload();
  await expect(
    page.getByText("recover-reference.png", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("summary").filter({ hasText: "Uploads" }),
  ).toHaveCount(0);
});

test("a paused upload requires the original file and resends only the missing immutable chunk after reload", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one bounded partial-file recovery regression",
  );
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const projectId = await savedProject(
    page,
    `particl-active-${me.workspace.id}-${me.id}`,
  );
  const chunks: { session: string; index: number; body: Buffer }[] = [];
  let fail = true;
  await page.route("**/api/uploads/chunk", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataBuffer()!;
    const text = body.toString("latin1");
    const index = Number(text.match(/name="index"\r\n\r\n(\d+)/)?.[1]);
    const session = text.match(/name="session"\r\n\r\n([^\r]+)/)?.[1] || "";
    chunks.push({ session, index, body });
    if (index === 1 && fail) {
      fail = false;
      return route.abort("failed");
    }
    return route.continue();
  });
  const bytes = await sharp({
    create: { width: 1280, height: 1280, channels: 3, background: "#556677" },
  })
    .tiff({ compression: "none" })
    .toBuffer();
  expect(bytes.length).toBeGreaterThan(3_500_000);
  const original = {
    name: "original-reference.tiff",
    mimeType: "image/tiff",
    buffer: bytes,
  };
  await page.goto(
    `/suites?project=${encodeURIComponent(projectId)}&view=board`,
  );
  const referencePicker = boardFiles(page);
  await expect(page.getByTestId("board")).toBeVisible();
  await referencePicker.setInputFiles(original);
  await expect
    .poll(async () => {
      const entry = (await uploadEntries(page))[0];
      return entry?.state === "pending" && Boolean(entry.error);
    })
    .toBe(true);
  const entry = (await uploadEntries(page))[0];
  expect(entry.storedChunks).toEqual([0]);
  await page.reload();
  await page.locator("summary").filter({ hasText: "Uploads" }).click();
  const recovery = page.getByRole("region", { name: "Upload recovery" });
  const picker = recovery.getByLabel("Resume original-reference.tiff", {
    exact: true,
  });
  await picker.setInputFiles({ ...original, name: "another-file.tiff" });
  await expect(
    recovery.getByText(/Choose the same file with its original name/),
  ).toBeVisible();
  expect(chunks).toHaveLength(2);
  await picker.setInputFiles(original);
  await expect(
    recovery.getByText("Upload ready", { exact: true }),
  ).toBeVisible();
  expect(
    chunks
      .slice(0, 2)
      .map((chunk) => chunk.index)
      .sort(),
  ).toEqual([0, 1]);
  expect(chunks.slice(2).map((chunk) => chunk.index)).toEqual([1]);
  expect(new Set(chunks.map((chunk) => chunk.session))).toEqual(
    new Set([entry.session]),
  );
  // Retry only a transport reset on this read; never repeat a write or HTTP failure.
  const listed = await page.request.get("/api/uploads", { maxRetries: 1 });
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const rows = await listed.json();
  expect(rows.uploads).toHaveLength(1);
  expect(rows.uploads[0].filename).toBe(original.name);
  expect(rows.uploads[0].bytes).toBe(bytes.length);
});

test("a finished upload shows as done in Uploads, and only an interrupted one asks for its original file", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "real desktop uploads (the board is the desktop's); the phone's panel is below",
  );
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const projectId = await savedProject(
    page,
    `particl-active-${me.workspace.id}-${me.id}`,
  );
  const png = (background: string) =>
    sharp({ create: { width: 512, height: 512, channels: 3, background } })
      .png()
      .toBuffer();
  await page.goto(
    `/suites?project=${encodeURIComponent(projectId)}&view=board`,
  );
  await expect(page.getByTestId("board")).toBeVisible();
  await boardFiles(page).setInputFiles({
    name: "finished-reference.png",
    mimeType: "image/png",
    buffer: await png("#2f6b4a"),
  });
  await expect
    .poll(async () => (await uploadEntries(page)).map((entry) => entry.state), { timeout: 60_000 })
    .toEqual(["complete"]);
  const summary = page.locator("summary").filter({ hasText: "Uploads" });
  const recovery = page.getByRole("region", { name: "Upload recovery" });
  const hint = recovery.getByText(
    "Choose the original file to resume an interrupted upload.",
  );
  await summary.click();
  const finished = recovery.getByRole("article", {
    name: "finished-reference.png",
  });
  await expect(finished.getByText("Upload ready", { exact: true })).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(
    finished.getByRole("button", { name: "Resume upload" }),
  ).toHaveCount(0);
  // The same after a reload: a finished receipt is never read back as interrupted.
  await page.reload();
  await summary.click();
  await expect(finished.getByText("Upload ready", { exact: true })).toBeVisible();
  await expect(hint).toHaveCount(0);

  // A genuinely interrupted upload still asks for its original file.
  await page.route("**/api/uploads/chunk", (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue(),
  );
  await expect(page.getByTestId("board")).toBeVisible();
  await boardFiles(page).setInputFiles({
    name: "interrupted-reference.png",
    mimeType: "image/png",
    buffer: await png("#6b2f4a"),
  });
  await expect
    .poll(async () =>
      (await uploadEntries(page))
        .map((entry) => entry.state + (entry.error ? ":error" : ""))
        .sort(),
      { timeout: 60_000 },
    )
    .toEqual(["complete", "pending:error"]);
  await page.unroute("**/api/uploads/chunk");
  await page.reload();
  await summary.click();
  await expect(hint).toBeVisible();
  const interrupted = recovery.getByRole("article", {
    name: "interrupted-reference.png",
  });
  await expect(
    interrupted.getByRole("button", { name: "Resume upload", exact: true }),
  ).toBeVisible();
  await expect(finished.getByText("Upload ready", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("uploads-finished-and-interrupted.png"),
    fullPage: true,
  });
  // Resumed to the end, nothing is left interrupted and the hint goes.
  await interrupted
    .getByRole("button", { name: "Resume upload", exact: true })
    .click();
  await expect(
    interrupted.getByRole("button", { name: "Resume upload", exact: true }),
  ).toBeVisible();
  await interrupted
    .getByLabel("Resume interrupted-reference.png", { exact: true })
    .setInputFiles({
      name: "interrupted-reference.png",
      mimeType: "image/png",
      buffer: await png("#6b2f4a"),
    });
  await expect(
    interrupted.getByText("Upload ready", { exact: true }),
  ).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("on the phone, Uploads shows a finished upload as done and asks for the original file only while one is interrupted", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-390x844",
    "the phone's Uploads panel; the phone has no board to upload from, so the saved records are the ones uploadFile writes",
  );
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#2f4a6b" },
  })
    .png()
    .toBuffer();
  // A real upload, stored and finished by the server: its receipt is what a finished upload saves.
  const session = randomUUID();
  const chunk = await page.request.post("/api/uploads/chunk", {
    headers,
    multipart: {
      session,
      index: "0",
      chunk: { name: "blob", mimeType: "application/octet-stream", buffer: bytes },
    },
  });
  expect(chunk.ok(), await chunk.text()).toBe(true);
  const finish = await page.request.post("/api/uploads/finish", {
    headers,
    data: { session, count: 1, filename: "phone-finished.png", purpose: "reference", mime: "image/png" },
  });
  expect(finish.ok(), await finish.text()).toBe(true);
  const receipt = await finish.json();
  const envelope = (name: string, identity: string, extra: Record<string, unknown>) => ({
    version: 1,
    scope,
    identity,
    file: { name, type: "image/png", size: bytes.length, lastModified: 1 },
    purpose: "reference",
    chunkBytes: 3_500_000,
    count: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
  const finished = envelope("phone-finished.png", "a".repeat(64), {
    session,
    storedChunks: [0],
    state: "complete",
    started: true,
    result: receipt,
  });
  const interrupted = envelope("phone-interrupted.png", "b".repeat(64), {
    session: randomUUID(),
    storedChunks: [],
    state: "pending",
    started: true,
    error: "The upload was interrupted. Resume it from Uploads.",
  });
  const save = (entries: object[]) =>
    page.evaluate((entries) => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("particl:upload:v1:")) localStorage.removeItem(key);
      for (const entry of entries as { scope: string; identity: string }[])
        localStorage.setItem(
          "particl:upload:v1:" + JSON.stringify([entry.scope, entry.identity]),
          JSON.stringify(entry),
        );
    }, entries);
  await page.goto("/suites");
  await save([finished]);
  await page.reload();
  const summary = page.locator("summary").filter({ hasText: "Uploads" });
  const recovery = page.getByRole("region", { name: "Upload recovery" });
  const hint = recovery.getByText(
    "Choose the original file to resume an interrupted upload.",
  );
  await summary.click();
  const done = recovery.getByRole("article", { name: "phone-finished.png" });
  await expect(done.getByText("Upload ready", { exact: true })).toBeVisible();
  await expect(
    done.getByRole("link", { name: "Open uploaded file" }),
  ).toHaveAttribute("href", receipt.url);
  await expect(hint).toHaveCount(0);
  await expect(done.getByRole("button", { name: "Resume upload" })).toHaveCount(0);

  await save([finished, interrupted]);
  await page.reload();
  await summary.click();
  await expect(hint).toBeVisible();
  await expect(
    recovery
      .getByRole("article", { name: "phone-interrupted.png" })
      .getByRole("button", { name: "Resume upload", exact: true }),
  ).toBeVisible();
  await expect(done.getByText("Upload ready", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.evaluate(() => innerWidth),
  );
  await page.screenshot({
    path: testInfo.outputPath("phone-uploads-finished-and-interrupted.png"),
    fullPage: true,
  });
});
