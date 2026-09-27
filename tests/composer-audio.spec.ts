import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { workbenchScopeFor } from "../lib/workbench/request-scope";
import { claimsServer } from "./helpers/claimsServer";

test("audio uses the server quote and recovers a lost request by its key across reload, never re-sent, without sharing drafts", async ({
  page,
}, testInfo) => {
  const first = await signInLocally(page.request);
  let me = await page.request.get("/api/me").then((r) => r.json());
  const createProject = async () => {
    const draft = newProject("Isolated audio project");
    const response = await page.request.put("/api/workbench/projects", {
      headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
      data: { project: draft, revision: 0 },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const saved = await response.json();
    expect(saved.productionProjectId).toBeTruthy();
    return { ...draft, productionProjectId: saved.productionProjectId as string };
  };
  const draft = await createProject();
  const submissions: {
    key: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  /* Recover asks what became of a request by its key (POST /api/generate/check); the one whose answer was lost here landed. */
  const checks: { key: string; endpoint: string; body: string }[] = [];
  let held = false,
    holdQuote = false,
    releaseQuote = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseQuote = resolve;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/generate/check" && request.method() === "POST") {
      const asked = request.postDataJSON();
      checks.push(asked);
      return json(submissions.some((s) => s.key === asked.key) ? { state: "landed", id: "mock-audio-generation", status: "running" } : { state: "absent" });
    }
    if (path === "/api/audio") {
      if (request.method() === "GET")
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
              category: "premade",
              labels: { language: "English" },
              previewUrl: null,
              description: "Mock voice",
            },
          ],
          voicesError: null,
          account: null,
          terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
        });
      const body = request.postDataJSON();
      if (body.quoteOnly) {
        if (body.text.includes("Unavailable"))
          return json(
            { error: "Audio quotes are temporarily unavailable." },
            503,
          );
        if (holdQuote) {
          held = true;
          await barrier;
        }
        return json({
          estimatedCredits: body.text.includes("Revised") ? 21 : 14,
          price: body.text.includes("Revised") ? 21 : 14,
          unit: "cr",
        });
      }
      submissions.push({ key: request.headers()["idempotency-key"], body });
      return submissions.length === 1
        ? json({ error: "Submission response is uncertain. Recover it." }, 503)
        : json({ id: "mock-audio-generation", status: "running" });
    }
    if (request.method() !== "GET")
      throw new Error(`Unexpected paid/mutating browser request: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto(`/make/audio?project=${draft.id}`);
  await page.waitForURL(url => url.pathname === "/generate" && url.searchParams.get("mode") === "audio" && url.searchParams.get("project") === draft.id);
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem(
      "aw_draft:make:audio",
      "A different account’s legacy prompt",
    ),
  );
  await page.reload();
  const open = async () => {
    await expect(
      page.getByRole("textbox", { name: "Prompt", exact: true }),
    ).toBeVisible();
  };
  await open();
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toHaveValue("");
  await prompt.fill("An isolated audio test line.");
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toContainText("14 cr");
  await expect(render).toBeEnabled();
  holdQuote = true;
  await prompt.fill("Revised audio test line.");
  await expect(render).toBeDisabled();
  await expect.poll(() => held).toBeTruthy();
  releaseQuote();
  await expect(render).toContainText("21 cr");
  await expect(render).toBeEnabled();
  await render.click();
  await expect(render).toContainText("Recover submitted audio");
  await expect(prompt).toBeDisabled();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].body.maxCredits).toBe(21);
  expect(submissions[0].body.projectId).toBe(draft.productionProjectId);
  await page.screenshot({ path: testInfo.outputPath("audio-pending.png") });
  await page.reload();
  await open();
  await expect(prompt).toHaveValue("Revised audio test line.");
  await expect(prompt).toBeDisabled();
  const recover = page
    .locator("[data-render]")
    .filter({ visible: true })
    .last();
  await expect(recover).toContainText("Recover submitted audio");
  await expect(recover).toContainText("21 cr");
  await recover.click();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue("");
  /* Followed by its key; nothing was sent again. */
  expect(submissions).toHaveLength(1);
  expect(submissions[0].key).toBeTruthy();
  expect(checks.map((c) => ({ ...c, body: JSON.parse(c.body) }))).toEqual([{ key: submissions[0].key, endpoint: "/api/audio", body: submissions[0].body }]);
  await prompt.fill("Private draft for the first production house.");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith("aw_draft:make:") &&
            value === "Private draft for the first production house.",
        ),
      ),
    )
    .toBeTruthy();
  const savedKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter(
      (key) =>
        key.startsWith("aw_draft:make:") && key !== "aw_draft:make:audio",
    ),
  );
  expect(
    savedKeys.some(
      (key) => key.includes(first.workspace.id) && key.includes(me.email) && key.includes(draft.id),
    ),
  ).toBeTruthy();
  await signInLocally(page.request);
  me = await page.request.get("/api/me").then((r) => r.json());
  const secondDraft = await createProject();
  await page.goto(`/make/audio?project=${secondDraft.id}`);
  await open();
  await expect(prompt).toHaveValue("");
  await prompt.fill("Unavailable quote line.");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Audio quotes are temporarily unavailable." }),
  ).toBeVisible();
  await expect(
    page.locator("[data-render]").filter({ visible: true }).last(),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

/* A recovery is asked about by its key first (POST /api/generate/check) and never re-sent blind: a request that
   never arrived is set aside, re-quoted, and sent only at the price then shown (the same rule as the Rig, #393). */
test("a lost audio request that never arrived is not re-sent at a price nobody was shown: it is set aside and re-quoted", async ({ page }) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const draft = newProject("Lost audio project");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const server = claimsServer(21);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/audio" && request.method() === "GET")
      return json({
        configured: true, speechModels: [{ id: "mock-speech", label: "Mock speech", creditsPerChar: 0.1, note: "Local test" }], defaultSpeechModel: "mock-speech",
        voices: [{ id: "mock-voice", name: "Avery", category: "premade", labels: { language: "English" }, previewUrl: null, description: "Mock voice" }],
        voicesError: null, account: null, terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
      });
    if (await server.handle(route)) return;
    if (request.method() !== "GET") throw new Error(`Unexpected paid/mutating browser request: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto(`/make/audio?project=${draft.id}`);
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill("A line that never reached the server.");
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toContainText("21 cr");
  server.plan = ["before"];
  await render.click();
  await expect(render).toContainText("Recover submitted audio");
  const lost = server.sent[0];
  expect(lost.body).toMatchObject({ maxCredits: 21 });

  /* The price moves while the request is unconfirmed; the page is opened again and Recover pressed. */
  server.price = 14;
  await page.reload();
  await expect(render).toContainText("Recover submitted audio");
  await expect(prompt).toHaveValue("A line that never reached the server.");
  const mark = server.sent.length;
  await render.click();
  await expect(prompt).toBeEnabled();
  expect({ sent: server.sent.slice(mark).map((s) => s.path), billed: server.charges }).toEqual({ sent: [], billed: [] });
  expect(server.checks).toEqual([{ key: lost.key, endpoint: "/api/audio" }]);

  /* The request is the person's again, priced afresh: it goes only from the priced button, under a new key. */
  await expect(prompt).toHaveValue("A line that never reached the server.");
  await expect(render).toContainText("14 cr");
  await render.click();
  await expect.poll(() => server.charges).toEqual([14]);
  expect(server.sent.at(-1)!.key).not.toBe(lost.key);
  expect(server.sent.at(-1)!.body).toMatchObject({ maxCredits: 14, text: "A line that never reached the server." });
  /* The lost request, arriving late, admits nothing: it was set aside when it was checked. */
  const late = await page.evaluate(async ({ key, body }) => {
    const r = await fetch("/api/audio", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    return r.status;
  }, { key: lost.key!, body: lost.body });
  expect(late).toBe(409);
  expect(server.charges).toEqual([14]);
  expect(errors).toEqual([]);
});
