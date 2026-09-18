import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";

test("paid writing recovers the same body after reload and is isolated from another account", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one generic durability regression; responsive customer coverage runs separately",
  );
  const first = await signInLocally(page.request),
    me = await page.request.get("/api/me").then((r) => r.json());
  const requests: {
    body: unknown;
    key: string | undefined;
    workspace: string | undefined;
    actor: string | undefined;
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200, complete = false) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: complete ? { "Idempotency-Status": "complete" } : {},
        body: JSON.stringify(value),
      });
    if (path === "/api/atomik/ideas") return json({ ideas: [] });
    if (path === "/api/atomik")
      return json({
        chats: [],
        engines: [],
        models: { featured: [], rest: [] },
      });
    if (path === "/api/atomik/ideas/draft") {
      const r = route.request();
      if (r.postDataJSON().quoteOnly === true) {
        expect(r.headers()["idempotency-key"]).toBeUndefined();
        return json({ model: "anthropic/claude-sonnet-4.6", effort: "auto", estimateCredits: 2 });
      }
      requests.push({
        body: r.postDataJSON(),
        key: r.headers()["idempotency-key"],
        workspace: r.headers()["x-workspace-id"],
        actor: r.headers()["x-actor-email"],
      });
      return requests.length === 1
        ? json(
            { error: "The response was lost; recover the saved request." },
            503,
          )
        : json(
            {
              logline: "The recovered idea is ready.",
              tone: ["Quiet"],
              model: "mock-writer",
              costUsd: 1,
            },
            200,
            true,
          );
    }
    if (route.request().method() !== "GET")
      throw new Error(`Unexpected mutation: ${path}`);
    return route.fallback();
  });
  await page.goto("/atomik/ideas");
  await page.getByRole("button", { name: "New idea", exact: true }).click();
  const logline = page.locator(".ak-idea.is-new textarea");
  await logline.fill("Original paid writing brief.");
  await page.getByRole("button", { name: /WRITE IT · 2 CR RESERVED/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Recover writing request", exact: true }),
  ).toBeVisible();
  await expect(logline).toBeDisabled();
  await signInLocally(page.request);
  await page.goto("/atomik/ideas");
  await expect(
    page.getByRole("button", { name: "Recover writing request", exact: true }),
  ).toHaveCount(0);
  const login = await page.request.post("/api/auth/login", {
    data: { email: me.email, password: "a local browser test passphrase 42" },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/atomik/ideas");
  await expect(logline).toHaveValue("Original paid writing brief.");
  await page
    .getByRole("button", { name: "Recover writing request", exact: true })
    .click();
  await expect(logline).toHaveValue("The recovered idea is ready.");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({
    workspace: first.workspace.id,
    actor: me.email,
    body: { brief: "Original paid writing brief.", tone: "", model: "anthropic/claude-sonnet-4.6", effort: "auto", maxCredits: 2 },
  });
  expect(requests[0].key).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("recovered-writing.png") });
  await signInLocally(page.request);
  await page.goto("/atomik/ideas");
  await expect(
    page.getByRole("button", { name: "Recover writing request", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New idea", exact: true }).click();
  await expect(logline).toHaveValue("");
});

test("asset training retains its identity through close and retries one asset creation", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "bounded training and asset handoff regression",
  );
  const signed = await signInLocally(page.request),
    me = await page.request.get("/api/me").then((r) => r.json());
  const image = await readFile("public/campaign/hero.webp");
  let identities = 0;
  const trains: { key: string | undefined; body: unknown }[] = [],
    assets: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname;
    const json = (value: unknown, status = 200, complete = false) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: complete ? { "Idempotency-Status": "complete" } : {},
        body: JSON.stringify(value),
      });
    if (path === "/api/settings")
      return json({ settings: { trainOnCreate: "always" } });
    if (path === "/api/identities") {
      if (r.method() === "GET")
        return json({
          identities: [],
          terms: { configured: true, minPhotos: 1, trainCostUsd: 14 },
        });
      identities++;
      return json({ identity: { id: "identity-browser" } }, 201);
    }
    if (path === "/api/identities/identity-browser/train") {
      expect(r.headers()["x-workspace-id"]).toBe(signed.workspace.id);
      expect(r.headers()["x-actor-email"]).toBe(me.email);
      trains.push({
        key: r.headers()["idempotency-key"],
        body: r.postDataJSON(),
      });
      return trains.length === 1
        ? json({ error: "Training response was lost." }, 503)
        : json(
            { identity: { id: "identity-browser", status: "training" } },
            200,
            true,
          );
    }
    if (path === "/api/rig/elements") {
      if (r.method() === "GET") return json({ elements: [] });
      assets.push({
        key: r.headers()["idempotency-key"],
        body: r.postDataJSON(),
      });
      expect(r.headers()["x-workspace-id"]).toBe(signed.workspace.id);
      expect(r.headers()["x-actor-email"]).toBe(me.email);
      return assets.length === 1
        ? json({ error: "Asset response was lost." }, 503)
        : json(
            {
              element: {
                id: "element-browser",
                name: "Recoverable face",
                kind: "character",
              },
            },
            201,
            true,
          );
    }
    if (path === "/api/uploads/chunk") return json({ ok: true });
    if (path === "/api/uploads/finish" && r.method() === "POST")
      return json(
        {
          id: "upload-face",
          filename: "face.webp",
          mime: "image/webp",
          kind: "image",
          bytes: image.length,
          width: 100,
          height: 100,
          durationS: null,
          sha256: "local-test",
          url: "/api/uploads/upload-face",
        },
        201,
      );
    if (path === "/api/uploads/upload-face")
      return route.fulfill({ contentType: "image/webp", body: image });
    if (r.method() !== "GET") throw new Error(`Unexpected mutation: ${path}`);
    return route.fallback();
  });
  await page.goto("/library?all=1");
  const assetViews = page.getByRole("group", { name: "Asset library views", exact: true });
  await expect(assetViews).toBeVisible();
  await assetViews.getByRole("button", { name: "Elements", exact: true }).click();
  await expect(page).toHaveURL(/\/library\?all=1&view=elements$/);
  await page.getByRole("button", { name: /^New asset/ }).click();
  const sheet = page.getByRole("dialog", { name: "New asset", exact: true });
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Recoverable face");
  await sheet.locator("input[type=file]").setInputFiles({
    name: "face.webp",
    mimeType: "image/webp",
    buffer: image,
  });
  await sheet
    .getByRole("checkbox", { name: "Consent to train", exact: true })
    .check();
  await sheet.locator("[data-create]").click();
  await expect(sheet.locator("[data-create]")).toContainText(
    "Recover training for",
  );
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^New asset/ }).click();
  await expect(
    sheet.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Recoverable face");
  await sheet.locator("[data-create]").click();
  await expect.poll(() => assets.length).toBe(1);
  await expect(sheet.locator("[data-create]")).toBeEnabled();
  await sheet.locator("[data-create]").click();
  await expect(sheet).not.toBeVisible();
  expect(identities).toBe(1);
  expect(trains).toHaveLength(3);
  expect(trains.every((item) => item.key === trains[0].key)).toBeTruthy();
  expect(assets).toHaveLength(2);
  expect(assets[1]).toEqual(assets[0]);
  expect(assets[0].key).toBe(`asset-from-training:${trains[0].key}`);
});

test("Atomik chat recovers its original message and conversation after reload", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "bounded chat durability regression",
  );
  await signInLocally(page.request);
  let creates = 0;
  const sends: { key: string | undefined; body: unknown }[] = [];
  const model = { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision:true, efforts:[{value:"high",label:"High"}] };
  const loaded = {
    chat: {
      id: "chat-browser",
      projectId: null,
      status: "idle",
      title: "Local chat",
      textCostUsd: 0,
    },
    messages: [],
    steps: [],
  };
  await page.route("**/api/**", async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname;
    const json = (data: unknown, status = 200, complete = false) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: complete ? { "Idempotency-Status": "complete" } : {},
        body: JSON.stringify(data),
      });
    if (r.method() === "POST" && r.postDataJSON().quoteOnly) return json({ model:model.id, effort:r.postDataJSON().effort, estimateCredits:8 });
    if (path === "/api/atomik/ideas") return json({ ideas: [] });
    if (path === "/api/atomik") {
      if (r.method() === "POST") {
        creates++;
        return json({ id: "chat-browser" });
      }
      return json({
        chats: [],
        engines: [],
        models: { featured: [model], rest: [] },
      });
    }
    if (path === "/api/atomik/chat-browser") {
      if (r.method() === "GET") return json(loaded);
      sends.push({
        key: r.headers()["idempotency-key"],
        body: r.postDataJSON(),
      });
      return sends.length === 1
        ? json({ error: "Chat response was lost." }, 503)
        : json(loaded, 200, true);
    }
    if (r.method() !== "GET") throw new Error(`Unexpected mutation: ${path}`);
    return route.fallback();
  });
  await page.goto("/atomik/ideas");
  await page.getByRole("button", { name: "Ask Atomik →", exact: true }).click();
  await page.getByRole("button", {name:"Chat thinking model",exact:true}).click();
  await page.getByRole("option", {name:"Claude Sonnet 4.6",exact:true}).click();
  await page.getByRole("combobox", {name:"Chat reasoning effort",exact:true}).click();
  await page.getByRole("option", {name:"High",exact:true}).click();
  await page
    .getByRole("textbox", { name: "Ask Atomik", exact: true })
    .fill("Plan the original production.");
  await page.getByRole("button", { name: "Send · 8 cr estimated", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover saved request", exact: true }),
  ).toBeVisible();
  await page.reload();
  if (
    !(await page
      .getByRole("textbox", { name: "Ask Atomik", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Ask Atomik →", exact: true })
      .click();
  await expect(
    page.getByRole("textbox", { name: "Ask Atomik", exact: true }),
  ).toHaveValue("Plan the original production.");
  await expect(page.getByRole("combobox", {name:"Chat reasoning effort",exact:true})).toBeDisabled();
  await expect(page.getByRole("combobox", {name:"Chat reasoning effort",exact:true})).toContainText("High");
  await page
    .getByRole("button", { name: "Recover saved request", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Ask Atomik", exact: true }),
  ).toBeEnabled();
  expect(creates).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(sends[0].key).toBeTruthy();
  expect(sends[0].body).toMatchObject({model:model.id,effort:"high",maxCredits:8});
});

test("ordinary drafts belong to each account even inside the same workspace", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "same-workspace private draft regression",
  );
  const first = await signInLocally(page.request),
    owner = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/atomik/ideas", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ideas: [] }),
    }),
  );
  await page.route("**/api/atomik", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        chats: [],
        engines: [],
        models: { featured: [], rest: [] },
      }),
    }),
  );
  await page.route("**/api/atomik/ideas/draft", async (route) => {
    expect(route.request().postDataJSON().quoteOnly).toBe(true);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ model: "anthropic/claude-sonnet-4.6", effort: "auto", estimateCredits: 2 }) });
  });
  await page.goto("/atomik/ideas");
  await page.getByRole("button", { name: "New idea", exact: true }).click();
  const logline = page.locator(".ak-idea.is-new textarea");
  async function openModelsWithinDocument() {
    const sentinel = randomBytes(12).toString("hex");
    await page.evaluate((value) => {
      Reflect.set(window, "__privateDraftNavigation", value);
    }, sentinel);
    const models = page
      .getByRole("navigation", { name: "Atomik Agent pages", exact: true })
      .getByRole("link", { name: "Models", exact: true });
    await expect(models).toBeVisible();
    await models.click();
    await expect(page).toHaveURL(/\/atomik\?page=models$/);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "__privateDraftNavigation"),
      ),
    ).toBe(sentinel);
    await expect(logline).toHaveCount(0);
  }
  await logline.fill("Owner private unsent brief.");
  // Client navigation unmounts before the debounce has to finish.
  await openModelsWithinDocument();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(localStorage).some((value) =>
          value.includes("Owner private unsent brief."),
        ),
      ),
    )
    .toBeTruthy();
  await page.evaluate(
    ({ id }) =>
      localStorage.setItem(
        `aw_draft:${id}:atomik-idea`,
        JSON.stringify({
          v: {
            logline: "Unowned legacy brief.",
            tone: "",
            refs: [],
            model: "auto",
          },
          at: Date.now(),
        }),
      ),
    { id: first.workspace.id },
  );
  await signInLocally(page.request);
  const member = await page.request.get("/api/me").then((r) => r.json());
  const code = randomBytes(18).toString("base64url"),
    db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
  await db.execute({
    sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    args: [
      code,
      first.workspace.id,
      member.email,
      "Second crew member",
      "member",
      owner.id,
      Date.now(),
      Date.now() + 3600000,
    ],
  });
  db.close();
  const joined = await page.request.post("/api/auth/accept", {
    data: { code },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  const current = await page.request.get("/api/me").then((r) => r.json());
  expect(current.workspace.id).toBe(first.workspace.id);
  expect(current.email).toBe(member.email);
  await page.goto("/atomik/ideas");
  await page.getByRole("button", { name: "New idea", exact: true }).click();
  await expect(logline).toHaveValue("");
  await logline.fill("Member private unsent brief.");
  await openModelsWithinDocument();
  const login = await page.request.post("/api/auth/login", {
    data: {
      email: owner.email,
      password: "a local browser test passphrase 42",
    },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/atomik/ideas");
  await expect(logline).toHaveValue("Owner private unsent brief.");
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("aw_draft:v2:"),
    ),
  );
  expect(
    stored.some(
      ([key, value]) =>
        key.includes(owner.email) &&
        value.includes("Owner private unsent brief."),
    ),
  ).toBeTruthy();
  expect(
    stored.some(
      ([key, value]) =>
        key.includes(member.email) &&
        value.includes("Member private unsent brief."),
    ),
  ).toBeTruthy();
});
