import { test, expect } from "@playwright/test";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import type { GenerationBatch } from "../lib/useGenerationBatch";
import { newProject } from "../lib/workbench/studio";
import { workbenchScopeFor } from "../lib/workbench/request-scope";
import { claimsServer } from "./helpers/claimsServer";

test("an interrupted batch checks only the pending variant by its key after reload, follows it, and finishes the original ordered requests", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "The shared batch protocol needs one focused desktop regression.",
  );
  const account = await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const draft = newProject("Batch recovery project");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  expect(productionProjectId).toBeTruthy();
  const submissions: {
    key?: string;
    body: string;
    workspace?: string;
    actor?: string;
    scope?: string;
  }[] = [];
  /* A take whose acknowledgement was lost reached the server: Recover asks by its key and follows it. */
  const landed = new Map<string, string>();
  const checks: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/generate/check" && request.method() === "POST") {
      expect(request.headers()["x-workbench-scope"]).toBe(workbenchScopeFor(me.workspace.id, me.id));
      const key = String(request.postDataJSON().key);
      checks.push(key);
      return json(landed.has(key) ? { state: "landed", id: landed.get(key), status: "running" } : { state: "absent" });
    }
    if (path === "/api/generate" && request.method() === "POST") {
      const headers = request.headers();
      submissions.push({
        key: headers["idempotency-key"],
        body: request.postData()!,
        workspace: headers["x-workspace-id"],
        actor: headers["x-actor-email"],
        scope: headers["x-workbench-scope"],
      });
      const body = request.postDataJSON();
      if (body.variation === 2 || body.variation === 4) landed.set(headers["idempotency-key"]!, `mock-image-${body.variation}`);
      if (submissions.length === 2)
        return json(
          {
            error:
              "The second take’s submission response was lost. Recover the batch.",
          },
          503,
        );
      if (body.variation === 3)
        return json(
          {
            id: "mock-image-3",
            status: "failed",
            error: "The third take failed after a provider attempt.",
          },
          502,
        );
      if (submissions.length === 4)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: { "Idempotency-Status": "complete" },
          body: JSON.stringify({
            error: "The fourth take could not be confirmed.",
          }),
        });
      return json({ id: `mock-image-${body.variation}`, status: "running" });
    }
    if (request.method() !== "GET")
      throw new Error(`Unexpected mutation: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto(`/make/images?project=${draft.id}`);
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill(
    "A brass key in a pool of warm light. Four isolated test variations.",
  );
  await page.getByRole("button", { name: /×1/ }).click();
  await page.getByRole("menuitem", { name: "×4", exact: true }).click();
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toBeEnabled();
  await render.click();
  await expect(render).toContainText("Recover batch");
  await expect(
    page.getByRole("status").filter({ hasText: "1 of 4 takes submitted" }),
  ).toBeVisible();
  await expect(prompt).toBeDisabled();
  expect(submissions).toHaveLength(2);
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).find(([key]) =>
      key.startsWith("particl:generation-batch:"),
    ),
  );
  expect(stored).toBeTruthy();
  const [storageKey, raw] = stored!;
  const batch = JSON.parse(raw) as GenerationBatch;
  expect(storageKey).toContain(account.workspace.id);
  expect(storageKey).toContain(me.email);
  expect(storageKey).toContain(draft.id);
  expect(batch.cursor).toBe(1);
  expect(batch.variants).toHaveLength(4);
  expect(batch.variants[0].resultId).toBe("mock-image-1");
  expect(new Set(batch.variants.map((variant) => variant.key)).size).toBe(4);
  expect(
    batch.variants.map((variant) => JSON.parse(variant.body).variation),
  ).toEqual([1, 2, 3, 4]);
  expect(
    batch.variants.every((variant) =>
      Number.isInteger(JSON.parse(variant.body).maxCredits),
    ),
  ).toBeTruthy();
  await page.reload();
  await expect(prompt).toHaveValue(batch.display.prompt);
  await expect(prompt).toBeDisabled();
  await expect(render).toContainText("Recover batch");
  await expect(page.getByRole("button", { name: /×4/ })).toBeDisabled();
  await render.click();
  await expect(
    page.getByRole("status").filter({ hasText: "3 of 4 takes submitted" }),
  ).toBeVisible();
  await expect(render).toContainText("Recover batch");
  const progressed = (await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    storageKey,
  )) as GenerationBatch;
  expect(progressed.cursor).toBe(3);
  expect(progressed.variants[1].resultId).toBe("mock-image-2");
  expect(progressed.variants[2].resultId).toBe("mock-image-3");
  expect(progressed.refusal).toBeUndefined();
  expect(progressed.variants[3].key).toBe(batch.variants[3].key);
  await page.reload();
  await expect(render).toContainText("Recover batch");
  await render.click();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue("");
  /* Each lost take was asked about by its own key and followed; none was sent twice. */
  expect(submissions).toHaveLength(4);
  expect(submissions.map((item) => JSON.parse(item.body).variation)).toEqual([1, 2, 3, 4]);
  expect(checks).toEqual([batch.variants[1].key, batch.variants[3].key]);
  for (const index of [0, 1, 2, 3]) {
    const request = submissions[index];
    const variant = batch.variants[JSON.parse(request.body).variation - 1];
    expect(request.key).toBe(variant.key);
    expect(request.body).toBe(variant.body);
    expect(request.workspace).toBe(account.workspace.id);
    expect(request.actor).toBe(me.email);
    expect(request.scope).toBe(workbenchScopeFor(me.workspace.id, me.id));
    expect(JSON.parse(request.body).projectId).toBe(productionProjectId);
  }
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("batch-recovered.png") });
  expect(errors).toEqual([]);
});

for (const boundary of ["workspace", "account"] as const) {
  test(`a stale batch cannot submit after the active ${boundary} changes`, async ({ page }) => {
    const original = await signInLocally(page.request);
    const owner = await page.request.get("/api/me").then((response) => response.json());
    const captured = workbenchScopeFor(owner.workspace.id, owner.id);
    const draft = newProject("Scoped batch project");
    const saved = await page.request.put("/api/workbench/projects", {
      headers: { "X-Workbench-Scope": captured },
      data: { project: draft, revision: 0 },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await page.goto(`/make/images?project=${draft.id}`);
    const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
    await prompt.fill("A still life of a brass key in warm light.");
    await page.getByRole("button", { name: /×1/ }).click();
    await page.getByRole("menuitem", { name: "×2", exact: true }).click();
    const render = page.locator("[data-render]").filter({ visible: true }).last();
    await expect(render).toBeEnabled();

    // Change the cookie without replacing the document that approved the batch.
    await signInLocally(page.request);
    const member = await page.request.get("/api/me").then((response) => response.json());
    expect(member.workspace.id).not.toBe(original.workspace.id);
    if (boundary === "account") {
      const code = randomBytes(18).toString("base64url");
      const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
      try {
        await db.execute({
          sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          args: [code, original.workspace.id, member.email, "Another crew member", "member", owner.id, Date.now(), Date.now() + 3_600_000],
        });
      } finally { db.close(); }
      const accepted = await page.request.post("/api/auth/accept", { data: { code } });
      expect(accepted.ok(), await accepted.text()).toBe(true);
    }
    const current = await page.request.get("/api/me").then((response) => response.json());
    expect(current.id).not.toBe(owner.id);
    if (boundary === "account") expect(current.workspace.id).toBe(original.workspace.id);
    else expect(current.workspace.id).not.toBe(original.workspace.id);

    const posted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/generate" && response.request().method() === "POST");
    await render.click();
    const rejected = await posted;
    expect(rejected.request().headers()["x-workbench-scope"]).toBe(captured);
    expect(rejected.status()).toBe(409);
    const error = "Your account or workspace changed. Reload this page before continuing.";
    expect(await rejected.json()).toEqual({ error });
    // Rejection happens before the paid claim, without discarding the saved batch.
    expect(rejected.headers()["idempotency-status"]).toBeUndefined();
    await expect(render).toContainText("Recover batch");
    await expect(page.getByText(error, { exact: true }).first()).toBeVisible();
    const pending = await page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("particl:generation-batch:"))
      .map(([key, value]) => ({ key, batch: JSON.parse(value) })));
    expect(pending).toHaveLength(1);
    expect(pending[0].key).toContain(original.workspace.id);
    expect(pending[0].batch.cursor).toBe(0);
    expect(pending[0].batch.variants).toHaveLength(2);
    expect(pending[0].batch.variants.every((variant: { resultId?: string }) => !variant.resultId)).toBe(true);
    const jobs = await page.request.get("/api/jobs").then((response) => response.json());
    expect(jobs.generations).toEqual([]);
  });
}

/* A batch's pending take is asked about by its key before the batch goes on (POST /api/generate/check), never
   re-sent blind: one that never arrived is set aside and re-quoted, and goes only at the price the batch showed. */
test("a batch take that never arrived is not re-sent at a price nobody was shown: it is set aside, and the batch stops at the new price", async ({ page }) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const draft = newProject("Lost batch project");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const server = claimsServer(0);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (await server.handle(route)) return;
    if (request.method() !== "GET") throw new Error(`Unexpected mutation: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto(`/make/images?project=${draft.id}`);
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill("A brass key in a pool of warm light. Two isolated test variations.");
  await page.getByRole("button", { name: /×1/ }).click();
  await page.getByRole("menuitem", { name: "×2", exact: true }).click();
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toBeEnabled();
  const total = Number(/(\d+) cr/.exec((await render.textContent()) ?? "")?.[1]);
  const perTake = total / 2;
  expect(perTake).toBeGreaterThan(1);
  /* The server holds the price the button shows; the first take is answered, the second never arrives. */
  server.price = perTake;
  server.plan = ["answer", "before"];
  await render.click();
  await expect(render).toContainText("Recover batch");
  expect(server.charges).toEqual([perTake]);
  const lost = server.sent[1];

  server.price = perTake - 1;
  await page.reload();
  await expect(render).toContainText("Recover batch");
  const mark = server.sent.length;
  await render.click();
  await expect(prompt).toBeEnabled();
  expect({ sent: server.sent.slice(mark).map((s) => s.path), billed: server.charges }).toEqual({ sent: [], billed: [perTake] });
  expect(server.checks).toEqual([{ key: lost.key, endpoint: "/api/generate" }]);
  await expect(page.getByText(`The price is now ${perTake - 1} cr a take`).first()).toBeVisible();
  expect(errors).toEqual([]);
});
