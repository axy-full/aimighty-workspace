import { test, expect } from "@playwright/test";
import { runTool, TOOLS } from "../../lib/mcp";

/**
 * render_shot is a paid call made by an agent over MCP. It is quoted first and
 * sent with that quote as its ceiling, so it can never bill more than the price
 * it reports; and an optional request_id is its Idempotency-Key, so a client
 * that retries a call after losing its reply gets the render it started back,
 * never a second one. A stubbed workspace API; nothing is billed.
 */
type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
const FINGERPRINT = "a".repeat(64);
/* The caller's token has a monthly ceiling an admin set (owner, 20 Oct 2026): only then is the quote sent as its maxCredits. */
const SPENDS = { spends: true };
function workspace(quote: Record<string, unknown> = { estimatedCredits: 18, price: 18, unit: "cr", fingerprint: FINGERPRINT }) {
  const calls: { path: string; body?: unknown; key?: string }[] = [];
  const call = async (path: string, init: Init = {}) => {
    calls.push({ path, body: init.body, key: init.headers?.["Idempotency-Key"] });
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/generate/quote") return quote;
    if (path === "/api/generate") return { id: "gen_1", status: "queued" };
    throw new Error(`unexpected ${path}`);
  };
  return { call, calls };
}

test("render_shot is quoted first and sent with that exact price as its ceiling", async () => {
  const api = workspace();
  const text = await runTool("render_shot", { prompt: "Rain on glass.", duration: 5, resolution: "1080p" }, api.call as never, "", SPENDS);
  expect(api.calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
  /* The render is the very body that was priced, with the price as its ceiling. */
  expect(api.calls[1].body).toEqual({ ...(api.calls[0].body as object), maxCredits: 18, quoteFingerprint: FINGERPRINT });
  expect(text).toContain("price: 18 cr");
  /* A workspace on its own keys is told its vendor's dollars; the ceiling is the same quote's. */
  const own = workspace({ estimatedCredits: 13, price: 0.84, unit: "usd", fingerprint: FINGERPRINT });
  expect(await runTool("render_shot", { prompt: "Rain." }, own.call as never, "", SPENDS)).toContain("price: $0.84");
  expect(own.calls[1].body).toMatchObject({ maxCredits: 13 });
});

test("an unusable quote sends nothing", async () => {
  for (const quote of [{ estimatedCredits: -1, price: 1, unit: "cr" }, { price: 18, unit: "cr" }, { estimatedCredits: 1.5, price: 1.5, unit: "cr" }]) {
    const api = workspace(quote);
    await expect(runTool("render_shot", { prompt: "Rain." }, api.call as never, "", SPENDS)).rejects.toThrow("could not be priced");
    expect(api.calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  }
});

test("render_shot's optional request_id is its Idempotency-Key, so a retried call returns the render it started", async () => {
  const keyed = workspace();
  await runTool("render_shot", { prompt: "Rain.", request_id: "retry-me-01" }, keyed.call as never, "", SPENDS);
  expect(keyed.calls.find((c) => c.path === "/api/generate")?.key).toBe("mcp-render:retry-me-01");
  expect(keyed.calls.find((c) => c.path === "/api/generate/quote")?.key).toBeUndefined();
  /* Without one, each call is its own render, as before. */
  const plain = workspace();
  await runTool("render_shot", { prompt: "Rain." }, plain.call as never, "", SPENDS);
  expect(plain.calls.find((c) => c.path === "/api/generate")?.key).toBeUndefined();
  /* One the key cannot carry is refused before anything is quoted or sent. */
  for (const bad of ["no spaces allowed", "x".repeat(150), ""]) {
    const refused = workspace();
    await expect(runTool("render_shot", { prompt: "Rain.", request_id: bad }, refused.call as never, "", SPENDS)).rejects.toThrow("request_id");
    expect(refused.calls).toEqual([]);
  }
  /* The contract only grows: the argument is optional and described. */
  const schema = TOOLS.find((t) => t.name === "render_shot")!.inputSchema as { properties: Record<string, { type: string; description: string }>; required: string[] };
  expect(schema.required).toEqual(["prompt"]);
  expect(schema.properties.request_id).toMatchObject({ type: "string" });
  expect(schema.properties.request_id.description).toContain("retried with the same request_id");
});

/* Owner, 20 Oct 2026, Q1 "B": a token with no ceiling can only prepare and price. The tool never invents an approval: without the token's
   ceiling (`spends` absent or false, as POST /api/mcp passes it from the bearer the tools act with) it prices the shot and sends nothing. */
test("render_shot from a token with no ceiling is priced and never sent", async () => {
  for (const options of [{}, { spends: false }, { credits: true }]) {
    const api = workspace();
    const text = await runTool("render_shot", { prompt: "Rain.", request_id: "no-ceiling-01" }, api.call as never, "", options);
    expect(api.calls.map((c) => c.path), JSON.stringify(options)).toEqual(["/api/generate/quote"]);
    expect(text).toMatch(/^Priced, not started\./);
    expect(text).toContain("price: 18 cr");
    expect(text).toMatch(/no monthly ceiling[\s\S]*Nothing was started or spent\./);
  }
});

test("the MCP endpoint tells the tool whether this token may spend, from its ceiling", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  /* Read from the bearer the tools act with (CI on #854: a browser holding a session cookie and a bearer is the session to the route). */
  expect(route).toContain('spends: name === "render_shot" ? await bearerMaySpend(req) : false');
  expect(route).toContain('return Boolean(acting?.token?.scope === "render" && hasSpendingCeiling(acting.token, creditsApply(acting.workspace)));');
});
