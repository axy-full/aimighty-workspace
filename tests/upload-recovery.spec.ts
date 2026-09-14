import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";

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
    !["customer-1440x900", "customer-390x844"].includes(testInfo.project.name),
    "real desktop and phone upload recovery",
  );
  const account = await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let finishes = 0,
    chunks = 0,
    original = "";
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
  await page.goto("/generate?mode=video");
  const referencePicker = page.locator(
    'input[type="file"][accept="image/*,video/*"]',
  );
  await expect(referencePicker).toBeEnabled();
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
  const uploaded = await page.request
    .get("/api/uploads")
    .then((response) => response.json());
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
  await page.goto("/generate?mode=video");
  const referencePicker = page.locator(
    'input[type="file"][accept="image/*,video/*"]',
  );
  await expect(referencePicker).toBeEnabled();
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
  const rows = await page.request
    .get("/api/uploads")
    .then((response) => response.json());
  expect(rows.uploads).toHaveLength(1);
  expect(rows.uploads[0].filename).toBe(original.name);
  expect(rows.uploads[0].bytes).toBe(bytes.length);
});
