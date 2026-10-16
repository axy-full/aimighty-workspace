import { test, expect, request as pwRequest } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * The Hindi script's stand-in tool through the real route on a local ENGINE_MOCK server (lib/v12/translate-script.ts; rule 14): a quote may be
 * asked by an agent's token, a run is a person's press (a token is refused, 403), a run must carry the figure the quote gave, and a text over the
 * limit is refused in words. Without ENGINE_MOCK the route is no tool at all (tests/unit/v12-translate-script.spec.ts).
 */
const BASE = process.env.PW_BASE_URL || "http://localhost:4551";
const ask = (mode: "quote" | "run", text: string, extra: Record<string, unknown> = {}) => ({ mode, text, source: "en-IN", target: "hi-IN", ...extra });

test("a token may ask the price but never run it; a person runs it at the quoted figure or not at all", async ({ request }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const minted = await request.post("/api/tokens", { headers, data: { name: "Hindi agent", scope: "render" } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const agent = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${String((await minted.json()).token)}` } });
  const before = await request.get("/api/usage/summary").then((r) => r.json());

  /* The price: the same for an agent and a person. */
  const quote = await request.post("/api/v12/translate-script", { headers, data: ask("quote", "PICTURE: Harbour, dawn.") });
  expect(quote.ok(), await quote.text()).toBe(true);
  const priced = (await quote.json()) as { estimatedCredits: number; price: number; unit: string };
  expect(priced.estimatedCredits).toBeGreaterThan(0);
  const agentQuote = await agent.post("/api/v12/translate-script", { data: ask("quote", "PICTURE: Harbour, dawn.") });
  expect(agentQuote.ok(), await agentQuote.text()).toBe(true);
  expect(await agentQuote.json()).toEqual(priced);

  /* A run is a person's press: a token is refused, even with the right figure. */
  const refused = await agent.post("/api/v12/translate-script", { data: ask("run", "PICTURE: Harbour, dawn.", { approved: priced.price }) });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toContain("signed-in browser session");

  /* A person's run needs the figure the quote gave. */
  const low = await request.post("/api/v12/translate-script", { headers, data: ask("run", "PICTURE: Harbour, dawn.", { approved: 0 }) });
  expect(low.status()).toBe(409);
  const none = await request.post("/api/v12/translate-script", { headers, data: ask("run", "PICTURE: Harbour, dawn.") });
  expect(none.status()).toBe(409);
  const run = await request.post("/api/v12/translate-script", { headers, data: ask("run", "PICTURE: Harbour, dawn.", { approved: priced.price }) });
  expect(run.ok(), await run.text()).toBe(true);
  expect(await run.json()).toMatchObject({ ok: true, tool: "translate", text: expect.stringContaining("PICTURE: Harbour, dawn.") });

  /* Words in words: too long is refused, the wrong languages are refused, and nothing was spent through any of it. */
  const long = await request.post("/api/v12/translate-script", { headers, data: ask("quote", "x ".repeat(1500)) });
  expect(long.status()).toBe(400);
  expect((await long.json()).error).toContain("2,000 characters");
  const wrong = await request.post("/api/v12/translate-script", { headers, data: { ...ask("quote", "Hello"), target: "ta-IN" } });
  expect(wrong.status()).toBe(400);
  expect(await request.get("/api/usage/summary").then((r) => r.json())).toEqual(before);
  await agent.dispose();
});
