import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

type Connection = { connected: boolean; requiresReconnect: boolean };
const originalProviderId = "40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061";
const originalGenerationId = `gen_hfc_${"a".repeat(40)}`;
const verifiedOriginal = {
  generationId: originalGenerationId, providerJobId: originalProviderId, sha256: "b".repeat(64), bytes: 1234,
  width: 1280, height: 720, seconds: 15, credits: 75, creditUnit: "higgsfield_credits",
  asset: { generationId: originalGenerationId, kind: "video", mime: "video/mp4", url: `/api/media/${originalGenerationId}` },
};
async function fixture(page: Page, options: { owner?: boolean; initialError?: boolean; reconnect?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const scope = workbenchScopeFor(me.workspace.id, me.id);
  const calls: { path: string; method: string; scope: string | undefined }[] = [];
  const unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  let connection: Connection = { connected: !options.reconnect, requiresReconnect: !!options.reconnect };
  let statusError = !!options.initialError;
  let connectResult: { status: number; json: unknown } = { status: 503, json: { error: "Higgsfield authorization is not configured on this deployment." } };
  let discoveryRelease: (() => void) | undefined;
  let discoveryGate: Promise<void> | undefined;
  const verificationJob = { id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test", status: "quoted", workspaceId: "73834e6d-e147-4a22-826a-d60776d59b61", workspaceName: "Test studio", quoteCredits: 75, quoteExpiresAt: Date.now() + 300000, providerJobId: null as string | null, providerReceipt: null as Record<string, unknown> | null, result: null as unknown, originalAvailable: false as boolean | undefined, originalAvailability: "not_collected" as string | undefined };
  let videoJob: typeof verificationJob | null = null;
  let completedResult: unknown;
  const mediaRequests: string[] = [];
  let uncertain = false;
  let recoverableReceipt = false;
  const videoActions: Record<string, unknown>[] = [];
  const catalog = {
    discoveryOnly: true, capabilitiesVerified: false, protocolVersion: "2025-11-25",
    tools: [
      { name: "marketing_video", description: "Advertised definition only; requires separate review.", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } },
      { name: "brand_extract", description: '<img src="https://untrusted.example.com/tracker.png">', inputSchema: { type: "object", properties: { url: { type: "string" } } } },
    ],
    summary: { marketingVideo: ["marketing_video"], brandExtraction: ["brand_extract"], adReference: [], virality: [], workspace: [], uploads: [], jobs: [], pricing: [] },
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
    external.push(url.href);
    return route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === `/api/media/${originalGenerationId}`) {
      mediaRequests.push(`${path}${url.search}`);
      return route.fulfill({ path: "public/fixtures/clip.mp4", contentType: "video/mp4",
        ...(url.searchParams.get("download") === "1" ? { headers: { "Content-Disposition": 'attachment; filename="verified-marketing-original.mp4"' } } : {}) });
    }
    if (path.startsWith("/api/higgsfield/consumer/")) {
      const call = { path, method: request.method(), scope: request.headers()["x-workbench-scope"] };
      calls.push(call);
      expect(call.scope).toBe(scope);
      if (path.endsWith("/connection") && call.method === "GET")
        return statusError ? json({ error: "Connection status temporarily unavailable." }, 503) : json(connection);
      if (path.endsWith("/connection") && call.method === "DELETE") {
        connection = { connected: false, requiresReconnect: false };
        return json(connection);
      }
      if (path.endsWith("/capabilities") && call.method === "POST") {
        await discoveryGate;
        return json(catalog);
      }
      if (path.endsWith("/qualification") && call.method === "POST") return json({readOnly:true,results:[{tool:"marketing_studio_v2_costs",arguments:{},result:{cost_units_per_credit:100,note:'<img src="https://untrusted.example.com/cost.png">'}},{tool:"list_workspaces",arguments:{},error:{code:"unavailable"}}]});
      if (path.endsWith("/analysis-qualification") && call.method === "POST") return json({readOnly:true,scope:"analysis-models",results:[{tool:"models_explore",arguments:{action:"get",model_id:"brain_activity"},result:{note:'<img src="https://untrusted.example.com/analysis.png">'}},{tool:"models_explore",arguments:{action:"get",model_id:"virality_predictor"},result:{model:"virality_predictor"}}]});
      if (path.endsWith("/video") && call.method === "GET") return json({ jobs: videoJob ? [videoJob] : [] });
      if (path.endsWith("/video") && call.method === "POST") {
        const body = request.postDataJSON(); videoActions.push(body);
        if (body.action === "quote-rehearsal") { videoJob = { ...verificationJob }; return json({ job: videoJob }); }
        if (body.action === "submit") { videoJob = { ...verificationJob, status: uncertain ? "uncertain" : "accepted", providerJobId: uncertain ? null : "40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061", providerReceipt: recoverableReceipt ? { response: { results: [{ id: "40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061", model: "marketing_studio_video", type: "video", status: "pending" }] } } : null }; return json({ job: videoJob }); }
        if (body.action === "status") {
          if (completedResult !== undefined && videoJob) {
            videoJob = { ...videoJob, status: "completed", result: completedResult, originalAvailable: true, originalAvailability: "available" };
            return json({ job: videoJob, pollAfterSeconds: 30 });
          }
          if (recoverableReceipt && videoJob?.status === "uncertain") videoJob = { ...videoJob, status: "accepted", providerJobId: "40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061" };
          return json({ job: videoJob, providerStatus: { status: "running", note: '<img src="https://untrusted.example.com/result.png">' }, pollAfterSeconds: 30 });
        }
      }
      if (path.endsWith("/connect") && call.method === "POST") return json(connectResult.json, connectResult.status);
      unexpected.push(`${call.method} ${path}`);
      return json({ error: "No operation allowed in fixture." }, 409);
    }
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${path}`);
      return json({ error: "No provider dispatch allowed in fixture." }, 409);
    }
    if (path === "/api/me") return json({ ...me, ...(options.owner === false ? { owner: false, role: "member" } : {}) });
    if (path === "/api/settings") return json({ settings: {}, defaults: {} });
    if (path === "/api/engines") return json({ engines: [] });
    if (path === "/api/limits") return json({ limits: { storageBytes: 1e9 }, standing: { usedBytes: 0 } });
    if (path === "/api/me/notify") return json({ prefs: {} });
    if (path === "/api/workspaces/keys") return json({ mode: "workspace", keyring: true, keys: [] });
    return json({});
  });
  return {
    calls, unexpected, external, errors, videoActions, mediaRequests,
    seedAcceptedOriginal: (original: unknown) => {
      videoJob = { ...verificationJob, status: "accepted", providerJobId: originalProviderId,
        providerReceipt: { response: { results: [{ id: originalProviderId, model: "marketing_studio_video", type: "video", status: "pending" }] } } };
      completedResult = { original };
    },
    removeOriginal: (availability: "deleted" | undefined) => {
      if (videoJob) videoJob = { ...videoJob, originalAvailable: availability ? false : undefined, originalAvailability: availability };
    },
    setUncertain: () => { uncertain = true; },
    setRecoverableReceipt: () => { uncertain = true; recoverableReceipt = true; },
    setStatusError: (value: boolean) => { statusError = value; },
    setConnectResult: (value: typeof connectResult) => { connectResult = value; },
    holdDiscovery: () => { discoveryGate = new Promise<void>((resolve) => { discoveryRelease = resolve; }); },
    releaseDiscovery: () => discoveryRelease?.(),
  };
}
const consumerCard = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Higgsfield · Marketing account", exact: true }) });

test("owner checks scoped consumer definitions explicitly, then disconnects without starting any media work", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/settings#engines");
  const card = consumerCard(page);
  await expect(card.getByText("Account connected to this workspace owner.")).toBeVisible();
  expect(state.calls.every((call) => call.method === "GET" && /\/(connection|video)$/.test(call.path))).toBe(true);
  await expect(card.getByText(/tools advertised by the connected account/)).toHaveCount(0);
  state.holdDiscovery();
  // Two synchronous user activations must still enter only one request.
  await card.getByRole("button", { name: "Check available workflows", exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(card.getByRole("button", { name: "Checking workflows…", exact: true })).toBeDisabled();
  expect(state.calls.filter((call) => call.path.endsWith("/capabilities"))).toHaveLength(1);
  state.releaseDiscovery();
  await expect(card.getByText("2 tools advertised by the connected account. Availability still needs workflow qualification.")).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Available tool definitions checked. No generation, upload or scoring was started.");
  await card.getByText("Connection diagnostics", { exact: true }).click();
  const definitions = card.getByLabel("Higgsfield workflow definitions");
  await expect(definitions).toContainText('"marketing_video"');
  expect(JSON.parse((await definitions.textContent())!).tools[1].description).toBe('<img src="https://untrusted.example.com/tracker.png">');
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.getByText("No matching tool name found", { exact: true })).toHaveCount(6);
  await card.getByRole("button",{name:"Check account options and pricing",exact:true}).click();
  await expect(card.getByRole("status")).toHaveText("Account options and available pricing checked. No workspace was switched and no paid job was started.");
  await card.getByText("Account capability diagnostics",{exact:true}).click();
  const qualification = card.getByLabel("Higgsfield account capabilities");
  expect(JSON.parse((await qualification.textContent())!).results[0].result.note).toBe('<img src="https://untrusted.example.com/cost.png">');
  await expect(card.locator("img")).toHaveCount(0);
  await card.getByRole("button", { name: "Check analysis model definitions", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("higgsfield-consumer-analysis-controls.png") });
  await card.getByRole("button", { name: "Check analysis model definitions", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Analysis model definitions checked. No video was uploaded and no scoring job was started.");
  await card.getByText("Analysis model diagnostics", { exact: true }).click();
  const analysis = card.getByLabel("Higgsfield analysis model definitions");
  expect(JSON.parse((await analysis.textContent())!).results.map((read: { arguments: { model_id: string } }) => read.arguments.model_id)).toEqual(["brain_activity", "virality_predictor"]);
  await expect(card.locator("img")).toHaveCount(0);
  await card.screenshot({ path: info.outputPath("higgsfield-consumer-discovery.png") });
  await card.getByRole("button", { name: "Disconnect marketing account", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Higgsfield consumer connection removed from this Particl workspace.");
  await expect(card.getByRole("button", { name: "Connect Higgsfield account", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Check available workflows", exact: true })).toHaveCount(0);
  await expect(definitions).toHaveCount(0);
  await expect(qualification).toHaveCount(0);
  await expect(analysis).toHaveCount(0);
  expect(state.calls.filter((call) => call.method !== "GET").map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/higgsfield/consumer/capabilities", "POST /api/higgsfield/consumer/qualification", "POST /api/higgsfield/consumer/analysis-qualification", "DELETE /api/higgsfield/consumer/connection",
  ]);
  await page.reload();
  await expect(consumerCard(page).getByRole("button", { name: "Connect Higgsfield account", exact: true })).toBeEnabled();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(4);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("status and reconnect errors require explicit retries and reject unexpected OAuth navigation", async ({ page }, info) => {
  const state = await fixture(page, { initialError: true, reconnect: true });
  await page.goto("/settings?higgsfield=authorization_failed#engines");
  const card = consumerCard(page);
  await expect(card.getByText("Connection status temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect Higgsfield account", exact: true })).toBeDisabled();
  await expect(card.getByText(/The Higgsfield connection was not completed/)).toBeVisible();
  state.setStatusError(false);
  await card.getByRole("button", { name: "Retry connection status", exact: true }).click();
  await expect(card.getByText("Reconnect your Higgsfield account to restore access.", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Check available workflows", exact: true })).toHaveCount(0);
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await card.getByRole("button", { name: "Connect Higgsfield account", exact: true }).click();
  await expect(card.getByText("Higgsfield authorization is not configured on this deployment.", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.path.endsWith("/connect"))).toHaveLength(1);
  await expect(card.getByText(/The Higgsfield connection was not completed/)).toHaveCount(0);
  state.setConnectResult({ status: 200, json: { url: "https://untrusted.example.com/oauth/authorize" } });
  await card.getByRole("button", { name: "Connect Higgsfield account", exact: true }).click();
  await expect(card.getByText("Higgsfield returned an unexpected sign-in address.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?higgsfield=authorization_failed#engines$/);
  await card.screenshot({ path: info.outputPath("higgsfield-consumer-reconnect.png") });
  expect(state.calls.filter((call) => call.path.endsWith("/connect"))).toHaveLength(2);
  expect(state.calls.filter((call) => call.path.endsWith("/capabilities"))).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("member settings do not mount owner consumer connection controls or load owner status", async ({ page }) => {
  const state = await fixture(page, { owner: false });
  await page.goto("/settings#engines");
  await expect(page.getByRole("heading", { name: "Available engines", exact: true })).toBeVisible();
  await expect(consumerCard(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Higgsfield account|Disconnect marketing account|Check available workflows/ })).toHaveCount(0);
  expect(state.calls).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("verification quotes are inert until exact wallet approval; accepted jobs survive reload without resubmission", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  await expect(panel.getByRole("button", { name: "Get verification quote", exact: true })).toBeVisible();
  expect(state.videoActions).toEqual([]);
  await panel.getByRole("button", { name: "Get verification quote", exact: true }).click();
  const submit = panel.getByRole("button", { name: "Run verification · 75 credits", exact: true });
  await expect(submit).toBeDisabled();
  expect(state.videoActions.map(x => x.action)).toEqual(["quote-rehearsal"]);
  await panel.getByRole("checkbox", { name: "Charge 75 Higgsfield credits to Test studio for this one test.", exact: true }).check();
  await submit.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(panel.getByText(/Higgsfield accepted the video request/)).toBeVisible();
  expect(state.videoActions.filter(x => x.action === "submit")).toEqual([{ action: "submit", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test", workspaceId: "73834e6d-e147-4a22-826a-d60776d59b61", credits: 75 }]);
  await page.reload();
  await expect(panel.getByRole("button", { name: "Check verification result", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Run verification|Get verification quote/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Check verification result", exact: true }).click();
  await panel.getByText("Verification result details", { exact: true }).click();
  await expect(panel.getByLabel("Higgsfield verification result")).toContainText('"status": "running"');
  await expect(panel.getByRole("button", { name: /Check again in/ })).toBeDisabled();
  await expect(panel.locator("img")).toHaveCount(0);
  await panel.screenshot({ path: info.outputPath("higgsfield-verification.png") });
  expect(state.videoActions.map(x => x.action)).toEqual(["quote-rehearsal", "submit", "status"]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("an uncertain verification cannot create a replacement or retry after reload", async ({ page }) => {
  const state = await fixture(page); state.setUncertain();
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  await panel.getByRole("button", { name: "Get verification quote", exact: true }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Run verification · 75 credits", exact: true }).click();
  await expect(panel.getByText(/Submission needs reconciliation/)).toBeVisible();
  await page.reload();
  await expect(panel.getByText(/Submission needs reconciliation/)).toBeVisible();
  await expect(panel.getByRole("button")).toHaveCount(0);
  expect(state.videoActions.map(x => x.action)).toEqual(["quote-rehearsal", "submit"]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("saved uncertain submission recovers its provider receipt after reload through status only", async ({ page }, info) => {
  const state = await fixture(page); state.setRecoverableReceipt();
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  await panel.getByRole("button", { name: "Get verification quote", exact: true }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Run verification · 75 credits", exact: true }).click();
  await expect(panel.getByText(/Submission needs reconciliation/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Check saved submission", exact: true })).toBeVisible();
  expect(state.videoActions.map(action => action.action)).toEqual(["quote-rehearsal", "submit"]);

  await page.reload();
  await expect(panel.getByText(/Submission needs reconciliation/)).toBeVisible();
  const recover = panel.getByRole("button", { name: "Check saved submission", exact: true });
  await expect(recover).toBeEnabled();
  await expect(panel.getByRole("button", { name: /Run verification|Get verification quote/ })).toHaveCount(0);
  expect(state.videoActions.map(action => action.action)).toEqual(["quote-rehearsal", "submit"]);
  await panel.getByText("Verification result details", { exact: true }).click();
  await expect(panel.getByLabel("Higgsfield verification result")).toContainText('"results"');
  await expect(panel.getByLabel("Higgsfield verification result")).toContainText("40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061");
  await recover.click();
  await expect(panel.getByText(/Higgsfield accepted the video request/)).toBeVisible();
  await expect(panel.getByLabel("Higgsfield verification result")).toContainText('"status": "running"');
  await expect(panel.getByRole("button", { name: /Check again in/ })).toBeDisabled();
  await expect(panel.getByRole("button", { name: /Run verification|Get verification quote|Check saved submission/ })).toHaveCount(0);
  expect(state.videoActions).toEqual([
    expect.objectContaining({ action: "quote-rehearsal" }),
    { action: "submit", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test", workspaceId: "73834e6d-e147-4a22-826a-d60776d59b61", credits: 75 },
    { action: "status", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test" },
  ]);
  expect(state.videoActions.filter(action => action.action === "submit")).toHaveLength(1);
  await expect(panel.locator("img")).toHaveCount(0);
  await panel.getByRole("status").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("higgsfield-saved-submission-recovered.png") });
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("completed verification retains its verified local original and download after reload without new submission", async ({ page }, info) => {
  const state = await fixture(page);
  state.seedAcceptedOriginal(verifiedOriginal);
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  const preview = panel.getByLabel("Verified Marketing Video original", { exact: true });
  const download = panel.getByRole("link", { name: "Download original video", exact: true });
  await expect(panel.getByRole("button", { name: "Check verification result", exact: true })).toBeEnabled();
  await expect(preview).toHaveCount(0);
  expect(state.videoActions).toEqual([]);
  await panel.getByText("Verification result details", { exact: true }).click();
  const details = panel.getByLabel("Higgsfield verification result", { exact: true });
  await expect(details).toContainText('"status": "pending"');
  await panel.getByRole("button", { name: "Check verification result", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Verification: completed");
  await expect(details).toContainText(verifiedOriginal.sha256);
  expect(JSON.parse((await details.textContent())!)).toEqual({ original: verifiedOriginal });
  await expect(details).not.toContainText('"status": "pending"');
  await expect(preview).toHaveAttribute("src", `/api/media/${originalGenerationId}`);
  await expect(preview).toHaveAttribute("controls", "");
  await expect(download).toHaveAttribute("href", `/api/media/${originalGenerationId}?download=1`);
  await expect(panel.getByText(/Original retained.*SHA-256 recorded/)).toBeVisible();
  await expect.poll(() => state.mediaRequests.length).toBeGreaterThan(0);
  await page.reload();
  await expect(preview).toHaveAttribute("src", `/api/media/${originalGenerationId}`);
  await expect(download).toHaveAttribute("href", `/api/media/${originalGenerationId}?download=1`);
  await panel.getByText("Verification result details", { exact: true }).click();
  await expect(details).toContainText(verifiedOriginal.sha256);
  expect(JSON.parse((await details.textContent())!)).toEqual({ original: verifiedOriginal });
  await expect(details).not.toContainText('"status": "pending"');
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("higgsfield-verification-local-original.png") });
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toBe("verified-marketing-original.mp4");
  expect(state.videoActions).toEqual([{ action: "status", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test" }]);
  expect(state.mediaRequests).toContain(`/api/media/${originalGenerationId}?download=1`);
  expect(state.mediaRequests.every(path => path === `/api/media/${originalGenerationId}` || path === `/api/media/${originalGenerationId}?download=1`)).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

for (const invalid of [
  { name: "provider job mismatch", original: { ...verifiedOriginal, providerJobId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  { name: "approved credits mismatch", original: { ...verifiedOriginal, credits: 76 } },
  { name: "external media URL", original: { ...verifiedOriginal, asset: { ...verifiedOriginal.asset, url: "https://untrusted.example.com/original.mp4" } } },
]) test(`completed verification rejects ${invalid.name} instead of showing a verified preview`, async ({ page }) => {
  const state = await fixture(page);
  state.seedAcceptedOriginal(invalid.original);
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  await panel.getByRole("button", { name: "Check verification result", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Verification: completed");
  await expect(panel.getByLabel("Verified Marketing Video original", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "Download original video", exact: true })).toHaveCount(0);
  await expect(panel.locator("video, img")).toHaveCount(0);
  await page.reload();
  await expect(panel.getByRole("status")).toHaveText("Verification: completed");
  await expect(panel.getByLabel("Verified Marketing Video original", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "Download original video", exact: true })).toHaveCount(0);
  expect(state.videoActions).toEqual([{ action: "status", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test" }]);
  expect(state.mediaRequests).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

for (const availability of ["deleted", undefined] as const) test(`management hides a ${availability ?? "missing"} original availability after reload while preserving its audit receipt`, async ({ page }) => {
  const state = await fixture(page);
  state.seedAcceptedOriginal(verifiedOriginal);
  await page.goto("/settings#engines");
  const panel = page.getByRole("region", { name: "Marketing Video verification", exact: true });
  await panel.getByRole("button", { name: "Check verification result", exact: true }).click();
  await expect(panel.getByLabel("Verified Marketing Video original", { exact: true })).toBeVisible();
  await expect.poll(() => state.mediaRequests.length).toBeGreaterThan(0);
  state.removeOriginal(availability);
  await page.reload();
  await expect(panel.getByRole("status")).toHaveText("Verification: completed");
  await expect(panel.getByLabel("Verified Marketing Video original", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "Download original video", exact: true })).toHaveCount(0);
  await expect(panel.getByText(availability ? /The original video was deleted from the library/ : /The original video is unavailable/)).toBeVisible();
  await panel.getByText("Verification result details", { exact: true }).click();
  expect(JSON.parse((await panel.getByLabel("Higgsfield verification result").textContent())!)).toEqual({ original: verifiedOriginal });
  expect(state.mediaRequests).not.toContain(`/api/media/${originalGenerationId}?download=1`);
  expect(state.videoActions).toEqual([{ action: "status", id: "a811e162-cf6c-4073-8fe8-99e4dbb23547", draftId: "hf-verification-test" }]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
