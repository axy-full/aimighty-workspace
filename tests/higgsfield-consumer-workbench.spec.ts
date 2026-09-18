import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

type Connection = { connected: boolean; requiresReconnect: boolean };
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
    calls, unexpected, external, errors,
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
  expect(state.calls.every((call) => call.method === "GET" && call.path.endsWith("/connection"))).toBe(true);
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
  await card.screenshot({ path: info.outputPath("higgsfield-consumer-discovery.png") });
  await card.getByRole("button", { name: "Disconnect marketing account", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Higgsfield consumer connection removed from this Particl workspace.");
  await expect(card.getByRole("button", { name: "Connect Higgsfield account", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Check available workflows", exact: true })).toHaveCount(0);
  await expect(definitions).toHaveCount(0);
  await expect(qualification).toHaveCount(0);
  expect(state.calls.filter((call) => call.method !== "GET").map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/higgsfield/consumer/capabilities", "POST /api/higgsfield/consumer/qualification", "DELETE /api/higgsfield/consumer/connection",
  ]);
  await page.reload();
  await expect(consumerCard(page).getByRole("button", { name: "Connect Higgsfield account", exact: true })).toBeEnabled();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(3);
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
