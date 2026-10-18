import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The prompt writer (the owner's note of 16 Oct 2026): the default is Opus 5.5, asked to think lightly so the answer fits the 8 s deadline;
 * gpt-5-mini through the Responses API is asked for minimal reasoning (default effort ate its whole 400-token ceiling and returned nothing); and a
 * catalogue read that failed is not asked again for 60 s (a blocked egress cost 15 s on every quote). Nothing leaves the process but a local server.
 */
const dir = mkdtempSync(path.join(tmpdir(), "enhance-writer-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const MESSAGES = [{ role: "system", content: "Rewrite the prompt." }, { role: "user", content: "a paper kite over a grey sea, slow push in" }];

test("the default writer is Opus 5.5, with Sonnet 5.5 behind it; a saved routing still overrides, and Opus is a rate the writer can price", async () => {
  const { DEFAULT_TEXT_MODELS, textModelFor, TEXT_MODEL_IDS } = await import("../../lib/platformLayer");
  expect(DEFAULT_TEXT_MODELS.enhance).toBe("anthropic/claude-opus-5.5");
  expect(TEXT_MODEL_IDS).toContain("anthropic/claude-opus-5.5");
  delete process.env.PROMPT_MODELS; delete process.env.GATEWAY_PROMPT_MODELS;
  const { PROMPT_MODELS, enhanceRunsModel } = await import("../../lib/enhance");
  expect(PROMPT_MODELS()).toEqual(["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5"]);
  expect(enhanceRunsModel("anthropic/claude-opus-5.5")).toBe(true);
  /* A platform-desk routing for "enhance" still wins over the default. */
  expect(textModelFor({ text: { enhance: "anthropic/claude-sonnet-5.5" } }, "enhance")).toBe("anthropic/claude-sonnet-5.5");
  expect(textModelFor(null, "enhance")).toBe("anthropic/claude-opus-5.5");
});

test("the lightest named effort each writer offers: gpt-5-mini minimal, the Claude 5.5 writers low, and none where the model offers no control", async () => {
  const { staticCatalog } = await import("../../lib/catalog");
  const { quickEffort } = await import("../../lib/paidText");
  const by = (id: string) => staticCatalog().find((m) => m.id === id)!;
  expect(quickEffort(by("openai/gpt-5-mini"))).toBe("minimal");
  expect(quickEffort(by("anthropic/claude-opus-5.5"))).toBe("low");
  expect(quickEffort(by("anthropic/claude-sonnet-5.5"))).toBe("low");
  expect(quickEffort({ ...by("anthropic/claude-sonnet-5.5"), reasoningOptions: [] })).toBeUndefined();
});

/** What the run sends for a writer: the request body paid text compiles, captured at the provider boundary. */
async function sentBody(id: string): Promise<Record<string, unknown>> {
  const { staticCatalog } = await import("../../lib/catalog");
  const { runPaidText } = await import("../../lib/paidText");
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  const ws = `ws_writer_${id.replace(/\W/g, "_")}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  await grantCredits(ws, 1000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  const owner = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null } };
  let body: Record<string, unknown> = {};
  await runInTenant(row, async () => {
    await ready();
    await runPaidText({ model: id, messages: MESSAGES, maxTokens: 400, kind: "enhance", mock: "prompt", createdBy: "owner", quick: true },
      { model: staticCatalog().find((m) => m.id === id)!, submit: async (request) => { body = JSON.parse(request.body); return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "{\"prompt\":\"A kite.\"}" } }], usage: { cost: 0.001 } }) }; } });
  }, owner);
  return body;
}

test("gpt-5-mini is asked for minimal reasoning with room for its answer, and the Responses API body carries both", async () => {
  const body = await sentBody("openai/gpt-5-mini");
  expect(body.reasoning_effort).toBe("minimal");
  expect(body.max_tokens).toBe(400 + 1_024);
  const { openAIDirectBody } = await import("../../lib/openai-direct");
  const sent = openAIDirectBody(body);
  expect(sent.endpoint).toBe("responses");
  expect(sent.body.reasoning).toEqual({ effort: "minimal" });
  expect(sent.body.max_output_tokens).toBe(400 + 1_024);
});

test("Opus 5.5 and Sonnet 5.5 are asked for low effort, with the same small room, not a planning turn's 4,096 tokens", async () => {
  for (const id of ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5"]) {
    const body = await sentBody(id);
    expect(body.reasoning_effort, id).toBe("low");
    expect(body.max_tokens, id).toBe(400 + 1_024);
  }
});

test("a quick quote is the same quote the run is held at, and stays 1 cr for a typical prompt on every writer", async () => {
  const { staticCatalog } = await import("../../lib/catalog");
  const { quotePaidText } = await import("../../lib/paidText");
  const { billCredits } = await import("../../lib/creditTerms");
  const { enhancerMessages, ENHANCE_MAX_TOKENS } = await import("../../lib/shell/enhancer");
  const messages = enhancerMessages("a paper kite over a grey sea, slow push in", { mode: "video", anchored: false, editing: false, engine: "Seedance 2.5" });
  for (const id of ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-5-mini"]) {
    const model = staticCatalog().find((m) => m.id === id)!;
    const before = await quotePaidText({ model: id, messages, maxTokens: ENHANCE_MAX_TOKENS }, model);
    const after = await quotePaidText({ model: id, messages, maxTokens: ENHANCE_MAX_TOKENS, quick: true }, model);
    expect(after.estimateUsd!, id).toBeGreaterThan(before.estimateUsd!);
    expect(billCredits(before.estimateUsd!, "text"), id).toBe(1);
    expect(billCredits(after.estimateUsd!, "text"), id).toBe(1);
  }
});

test("the longest prompt the enhancer takes (ENHANCE_MAX_PROMPT), on the default writer, is quoted at exactly 1 cr in every mode", async () => {
  const { staticCatalog } = await import("../../lib/catalog");
  const { quotePaidText } = await import("../../lib/paidText");
  const { billCredits } = await import("../../lib/creditTerms");
  const { textModelFor } = await import("../../lib/platformLayer");
  const { isVerifiedTextModel } = await import("../../lib/atomikModelPolicy");
  const { DEFAULT_ENHANCER, ENHANCE_MAX_PROMPT, ENHANCE_MAX_TOKENS, ENHANCE_MODES, enhancerMessages, pickEnhancerModel } = await import("../../lib/shell/enhancer");
  /* The writer the route picks when nothing is chosen or routed (app/api/prompt/enhance/route.ts). */
  const models = staticCatalog().filter((m) => m.type === "language" && isVerifiedTextModel(m.id));
  const writer = pickEnhancerModel(DEFAULT_ENHANCER, models.map((m) => m.id), textModelFor(null, "enhance"));
  expect(writer).toBe("anthropic/claude-opus-5.5");
  const model = models.find((m) => m.id === writer)!;
  const longest = `${"a paper kite over a grey sea, slow push in, ".repeat(200).slice(0, ENHANCE_MAX_PROMPT - 1)}.`;
  expect(longest.length).toBe(ENHANCE_MAX_PROMPT);
  /* Quoted inside a customer workspace on the platform's keys, where a quote is in credits. */
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  const ws = "ws_writer_longest_prompt";
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  await runInTenant(row, async () => {
    for (const mode of ENHANCE_MODES) {
      /* The longest system text too: anchored, editing, and an engine named. */
      const messages = enhancerMessages(longest, { mode, anchored: true, editing: true, engine: "Seedance 2.5" });
      expect(messages[1].content.length, mode).toBe(ENHANCE_MAX_PROMPT);
      const quote = await quotePaidText({ model: writer!, messages, maxTokens: ENHANCE_MAX_TOKENS, quick: true }, model);
      expect(quote.estimateCredits, mode).toBe(1);
      expect(billCredits(quote.estimateUsd!, "text"), mode).toBe(1);
    }
  });
});

test("a failed catalogue read is not asked again for 60 s; a forced read still asks, and a good read clears it", async () => {
  const hits: number[] = [];
  let healthy = false;
  const server = createServer((_req, res) => {
    hits.push(Date.now());
    if (!healthy) { res.statusCode = 503; res.end("no"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5.5", name: "Sonnet", owner: "anthropic", type: "language", context_window: 100000, max_tokens: 8000, pricing: { input: "0.000002", output: "0.00001" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { gateway: process.env.AI_GATEWAY_BASE_URL, key: process.env.AI_GATEWAY_API_KEY, mock: process.env.ENGINE_MOCK };
  try {
    process.env.AI_GATEWAY_BASE_URL = base;
    process.env.AI_GATEWAY_API_KEY = "test-key-not-real";
    const { gatewayCatalog, forgetCatalogCache, FAILED_READ_TTL_MS } = await import("../../lib/catalog");
    expect(FAILED_READ_TTL_MS).toBe(60_000);
    forgetCatalogCache();
    expect(await gatewayCatalog()).toEqual([]);
    const afterFirst = hits.length;
    expect(afterFirst, "the first read asked once").toBe(1);
    for (let i = 0; i < 5; i++) expect(await gatewayCatalog()).toEqual([]);
    expect(hits.length, "five more quotes did not ask the gateway again").toBe(afterFirst);
    healthy = true;
    expect((await gatewayCatalog(true)).map((m) => m.id), "a forced read asks again").toEqual(["anthropic/claude-sonnet-5.5"]);
    expect((await gatewayCatalog()).length).toBe(1);
  } finally {
    for (const [name, value] of [["AI_GATEWAY_BASE_URL", saved.gateway], ["AI_GATEWAY_API_KEY", saved.key]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    (await import("../../lib/catalog")).forgetCatalogCache();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a language-account listing that failed is not asked again for 60 s either", async () => {
  const { FAILED_VERIFY_TTL_MS, openAIConnection } = await import("../../lib/openai-models");
  expect(FAILED_VERIFY_TTL_MS).toBe(60_000);
  const savedMock = process.env.ENGINE_MOCK, savedKey = process.env.OPENAI_API_KEY;
  process.env.ENGINE_MOCK = "";
  process.env.OPENAI_API_KEY = "test-key-not-real-writer-spec";
  let asked = 0;
  const blocked = (async () => { asked++; throw new Error("egress blocked"); }) as unknown as typeof fetch;
  try {
    const first = await openAIConnection(true, blocked);
    expect(first.verified).toBe(false);
    for (let i = 0; i < 4; i++) await openAIConnection(false, blocked);
    expect(asked, "one ask, then the failure is remembered").toBe(1);
    await openAIConnection(true, blocked);
    expect(asked, "a forced read still asks").toBe(2);
  } finally {
    if (savedMock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = savedMock;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  }
});
