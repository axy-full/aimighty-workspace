import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * POST /api/prompt/enhance through the real authenticated route and the real
 * meter, on a local ENGINE_MOCK server (signInLocally refuses anything else).
 * The mock writer echoes the person's words, which is enough to prove the
 * envelope: quote, approve that price, one settled charge, nothing on refusals.
 */
test("enhance quotes first, charges once at the approved price, and refuses raw:, a moved price and an unquoted run", async ({ request, playwright }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((response) => response.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl() });
  const anonymous = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  const events = async () => (await platform.execute({ sql: "SELECT id, status, billed_credits AS credits FROM meter_events WHERE workspace_id=?", args: [account.workspace.id] })).rows;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 100, "Local mock enhancer test", "admin", "test", Date.now()] });
    const prompt = "@Image1 walks into the harbour at dawn, no blur";
    const ask = (data: Record<string, unknown>, extra: Record<string, string> = {}) => request.post("/api/prompt/enhance", { headers: { ...headers, ...extra }, data });

    expect((await anonymous.post("/api/prompt/enhance", { data: { prompt, mode: "video", quoteOnly: true } })).status()).toBe(401);

    /* Refusals cost nothing and say why. */
    for (const [data, status, message] of [
      [{ prompt: "", mode: "video", quoteOnly: true }, 400, /few words/],
      [{ prompt: "raw: exactly this", mode: "video", quoteOnly: true }, 400, /raw:/],
      [{ prompt, mode: "film", quoteOnly: true }, 400, /what you are generating/],
      [{ prompt, mode: "video", provider: "gemini", quoteOnly: true }, 400, /supported prompt enhancer/],
    ] as const) {
      const response = await ask(data);
      expect(response.status(), JSON.stringify(data)).toBe(status);
      expect((await response.json()).error).toMatch(message);
    }

    /* The quote is read-only and carries credits, not dollars, for a credit workspace. */
    const quoted = await ask({ prompt, mode: "video", quoteOnly: true });
    expect(quoted.ok(), await quoted.text()).toBe(true);
    const quote = await quoted.json() as { model: string; estimateCredits: number; estimateUsd?: number };
    expect(quote.estimateCredits).toBeGreaterThanOrEqual(1);
    expect(quote.estimateUsd).toBeUndefined();
    expect(await events()).toHaveLength(0);

    /* No price seen, or a lower one than the live quote: refused before any spend. */
    const unquoted = await ask({ prompt, mode: "video" });
    expect(unquoted.status()).toBe(409);
    const stale = await ask({ prompt, mode: "video", maxCredits: quote.estimateCredits - 1 });
    expect(stale.status()).toBe(409);
    expect(await events()).toHaveLength(0);

    /* The approved run: Higgsfield by default, the citation intact, one settled charge. */
    const key = `enhance-${randomUUID()}`;
    const ran = await ask({ prompt, mode: "video", maxCredits: quote.estimateCredits }, { "Idempotency-Key": key });
    expect(ran.ok(), await ran.text()).toBe(true);
    const result = await ran.json() as { prompt: string; provider: string; writer: string };
    expect(result.provider).toBe("higgsfield");
    expect(result.writer).toBe(quote.model);
    expect(result.prompt).toContain("@Image1");
    const settled = await events();
    expect(settled).toHaveLength(1);
    expect(Number(settled[0].credits)).toBeGreaterThanOrEqual(1);
    expect(Number(settled[0].credits)).toBeLessThanOrEqual(quote.estimateCredits);

    /* The same key replays the answer; it does not buy a second one. */
    const replay = await ask({ prompt, mode: "video", maxCredits: quote.estimateCredits }, { "Idempotency-Key": key });
    expect(replay.headers()["idempotency-replayed"]).toBe("true");
    expect(await replay.json()).toEqual(result);
    expect(await events()).toHaveLength(1);

    /* A named provider is honoured and never becomes another one. */
    const claude = await ask({ prompt, mode: "image", provider: "claude", quoteOnly: true });
    expect(claude.ok(), await claude.text()).toBe(true);
    expect((await claude.json()).model).toMatch(/^anthropic\//);
  } finally {
    platform.close();
    await anonymous.dispose();
  }
});
