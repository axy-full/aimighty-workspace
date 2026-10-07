import { test, expect, type APIRequestContext } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { password, signupInvite } from "../../../tests/helpers/identityAdmin";

/** Local mock server on :4620 only. PHASE: at080 | at010a | at010b. */
const evidence = path.resolve(__dirname, "../../../.data/evidence");
const save = (name: string, data: unknown) => writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
const CUTOVER = "2026-10-03T14:39:00Z";
const OWNER = "platform-owner@example.test";

async function signIn(request: APIRequestContext, email: string, workspace: string) {
  const login = await request.post("/api/auth/login", { data: { email, password } });
  if (!login.ok()) {
    const code = await signupInvite(email);
    const signup = await request.post("/api/auth/signup", { data: { code, name: workspace, email, workspace, password, accept: true } });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await request.get("/api/me").then((r) => r.json());
  return { me, headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` } };
}
const enhance = (request: APIRequestContext, headers: Record<string, string>, data: Record<string, unknown>) =>
  request.post("/api/prompt/enhance", { headers, data: { prompt: "A lighthouse keeper walks the gallery at dusk", mode: "video", ...data } });
const unit = (request: APIRequestContext, data: Record<string, unknown>) => request.post("/api/admin/credit-unit", { data });
const CAPS = { "ws_saltmarsh/api_tokens:tok_s": "x8" };

test("at US$0.80: open, a paid job runs, /pricing reads today's particl.si", async ({ page, request }) => {
  test.skip(process.env.PHASE !== "at080");
  const { headers, me } = await signIn(request, OWNER, "Owner studio");
  expect(me.superAdmin).toBe(true);
  const quote = await (await enhance(request, headers, { quoteOnly: true })).json();
  expect((await enhance(request, headers, { maxCredits: quote.estimateCredits })).ok()).toBe(true);
  await page.goto("/pricing");
  const text = await page.locator("body").innerText();
  save("pricing-at-080.txt", text);
  expect(text).toMatch(/1 credit = US\$0\.80/i);
});

test("at US$0.10, part a: paused; a sign-up during the pause; dry run; one workspace converted", async ({ request, playwright }) => {
  test.skip(process.env.PHASE !== "at010a");
  const { headers } = await signIn(request, OWNER, "Owner studio");
  const log: Record<string, unknown> = {};
  const quote = await enhance(request, headers, { quoteOnly: true });
  log.freeQuoteStatus = quote.status();
  const estimate = (await quote.json()).estimateCredits;
  const refused = await enhance(request, headers, { maxCredits: estimate });
  log.pausedStatus = refused.status();
  log.pausedBody = await refused.json();
  expect(refused.status()).toBe(503);
  expect(JSON.stringify(log.pausedBody)).toContain("Paid work is paused for a few minutes while we update pricing. Nothing has been charged.");
  const state = await request.get("/api/admin/credit-unit").then((r) => r.json());
  log.ledgerBefore = { creditUsd: state.creditUsd, ledgerUnitUsd: state.ledgerUnitUsd, pausedSince: state.pausedSince };
  expect(state.pausedSince).toBeGreaterThan(0);
  // A new sign-up during the pause: its welcome is a $0.10 grant and must stay 250.
  const newcomer = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4620" });
  const joined = await signIn(newcomer, `newcomer-${Date.now()}@example.org`, "Newcomer");
  log.newcomerWorkspace = joined.me.workspace.id;
  await newcomer.dispose();

  const dry = await unit(request, { action: "convert", fromUnitUsd: 0.8, cutoverAt: CUTOVER, caps: CAPS });
  expect(dry.ok(), await dry.text()).toBe(true);
  const dryJson = await dry.json();
  save("credit-unit-dry-run.json", dryJson);
  expect(dryJson.needsDecision.map((d: { workspaceId: string }) => d.workspaceId)).toEqual(["ws_harbour"]);
  expect(dryJson.results.find((r: { workspaceId: string }) => r.workspaceId === joined.me.workspace.id)?.status).toBe("new");
  // Without every decision: refused, nothing written.
  const undecided = await unit(request, { action: "convert", fromUnitUsd: 0.8, cutoverAt: CUTOVER, caps: CAPS, dryRun: false });
  log.undecided = { status: undecided.status(), body: await undecided.json() };
  expect(undecided.status()).toBe(409);
  // One workspace on its own (as a failed half would leave it): the ledger stays at 0.80, paid work stays paused.
  const one = await unit(request, { action: "convert", fromUnitUsd: 0.8, cutoverAt: CUTOVER, caps: CAPS, dryRun: false, workspaceId: "ws_fieldnote" });
  const oneJson = await one.json();
  save("credit-unit-run-1-one-workspace.json", oneJson);
  expect(oneJson.ledgerUnitAfter).toBe(0.8);
  save("credit-unit-log-a.json", log);
});

test("at US$0.10, part b: convert all, run again, reverse before activity, convert, reverse refused after", async ({ request }) => {
  test.skip(process.env.PHASE !== "at010b");
  const { headers } = await signIn(request, OWNER, "Owner studio");
  const log: Record<string, unknown> = {};
  const estimate = (await (await enhance(request, headers, { quoteOnly: true })).json()).estimateCredits;
  const run = (body: Record<string, unknown>) => unit(request, { action: "convert", fromUnitUsd: 0.8, cutoverAt: CUTOVER, caps: CAPS, dryRun: false, ...body });
  const decided = await (await run({ decisions: { ws_harbour: "goodwill" } })).json();
  save("credit-unit-run-2-all.json", decided);
  expect(decided.waiting).toEqual([]);
  expect(decided.ledgerUnitAfter).toBe(0.1);
  const again = await (await run({ decisions: { ws_harbour: "goodwill" } })).json();
  save("credit-unit-run-3-after-completion.json", again);
  expect(again.results).toEqual([]);
  // Reverse before any paid work: exact, and paid work pauses again.
  const reversed = await (await unit(request, { action: "reverse", dryRun: false })).json();
  save("credit-unit-reverse.json", reversed);
  expect(reversed.ledgerUnitAfter).toBe(0.8);
  expect((await enhance(request, headers, { maxCredits: estimate })).status()).toBe(503);
  const rerun = await (await run({ decisions: { ws_harbour: "goodwill" } })).json();
  save("credit-unit-rerun.json", rerun);
  expect(rerun.ledgerUnitAfter).toBe(0.1);
  const ran = await enhance(request, headers, { maxCredits: estimate });
  log.afterConversionStatus = ran.status();
  expect(ran.ok(), await ran.text()).toBe(true);
  // After a paid job: a reversal is refused for everyone, and lists the activity.
  const refusedReverse = await (await unit(request, { action: "reverse", dryRun: false })).json();
  save("credit-unit-reverse-refused.json", refusedReverse);
  expect(refusedReverse.ledgerUnitAfter).toBe(0.1);
  expect(refusedReverse.results.some((r: { status: string }) => r.status === "refused")).toBe(true);
  // The statement foot.
  const month = new Date().toISOString().slice(0, 7);
  const stmt = await request.get(`/api/statements?month=${month}`, { headers }).then((r) => r.json()).catch(() => null);
  log.statementUnitNote = stmt?.unitNote ?? stmt?.statement?.unitNote ?? null;
  save("credit-unit-log-b.json", log);
});
