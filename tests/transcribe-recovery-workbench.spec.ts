import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { grokTranscriptionUsd } from "../lib/xaiVoice";

/**
 * A paid transcription is claimed before it is sent, per take and settings,
 * and a reply that never came back is asked about by its own key
 * (POST /api/generate/check) — never sent again. On the Takes page: a
 * transcript whose reply was lost comes back from its key; one still being
 * made when the page reloads is waited for; one that never reached the server
 * is let go with nothing charged, and the price on the button goes again under
 * a new key; a check that cannot be answered offers Try again; a press refused
 * because the estimate moved shows the new price for a new press. The paid route
 * and the check are a page-level stand-in for the server's claim rules, at every configured size.
 * The last case runs the real local routes on the ENGINE_MOCK server: a key
 * answered once, replayed and checked, a key set aside before it arrives.
 * Nothing is billed for real.
 */


test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });







/* ── The real local routes, ENGINE_MOCK: one desktop run ── */

function sine(seconds: number) {
  const rate = 48000, frames = rate * seconds, b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 0.5 * 32767), 44 + i * 2);
  return b;
}

test("the route answers a key once: its replay and its check return the same transcript and charge; a key set aside runs nothing", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run against the real routes");
  test.setTimeout(120_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}`, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const meterRows = async () => (await platform.execute({ sql: "SELECT id, status, billed_credits, engine_cost_usd FROM meter_events WHERE workspace_id=? AND model='grok-stt' ORDER BY created_at", args: [account.workspace.id] })).rows;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 500, "Transcription recovery test", "admin", "test", Date.now()] });
    /* A two-second line, uploaded through the real chunked upload. */
    const session = randomUUID();
    const chunk = await page.request.post("/api/uploads/chunk", { headers: { "X-Workbench-Scope": headers["X-Workbench-Scope"] }, multipart: { session, index: "0", chunk: { name: "chunk", mimeType: "application/octet-stream", buffer: sine(2) } } });
    expect(chunk.ok(), await chunk.text()).toBe(true);
    const finished = await page.request.post("/api/uploads/finish", { headers, data: { session, count: 1, filename: "Line.wav", mime: "audio/wav", purpose: "chat" } });
    expect(finished.ok(), await finished.text()).toBe(true);
    const upload = await finished.json();
    const quote = await page.request.post("/api/audio/transcribe", { headers, data: { sourceUploadId: upload.id, diarize: true, quoteOnly: true } });
    expect(quote.ok(), await quote.text()).toBe(true);
    const shown = (await quote.json()).estimatedCredits as number;
    expect(shown).toBeGreaterThan(0);
    const body = { sourceUploadId: upload.id, diarize: true, maxCredits: shown };

    const key = `stt-route-${randomUUID()}`;
    const first = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": key }, data: body });
    expect(first.status(), await first.text()).toBe(200);
    expect(first.headers()["idempotency-status"]).toBe("complete");
    const reply = await first.json();
    expect(reply.words.length).toBeGreaterThan(0);
    expect(reply.credits).toBeGreaterThan(0);
    const again = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": key }, data: body });
    expect(again.status()).toBe(200);
    expect(again.headers()["idempotency-replayed"]).toBe("true");
    expect(await again.json()).toEqual(reply);
    const checked = await page.request.post("/api/generate/check", { headers, data: { key, endpoint: "/api/audio/transcribe", body: JSON.stringify(body) } });
    expect(await checked.json()).toEqual({ state: "answered", reply });
    /* The same key naming a different request is refused by the check as by the route. */
    expect((await page.request.post("/api/generate/check", { headers, data: { key, endpoint: "/api/audio/transcribe", body: JSON.stringify({ ...body, diarize: false }) } })).status()).toBe(409);
    let rows = await meterRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", billed_credits: reply.credits });
    /* The mock provider reports a longer line than the source measured: its own count prices it, within three times the estimate. */
    expect(Number(rows[0].engine_cost_usd)).toBeCloseTo(Math.min(grokTranscriptionUsd(reply.seconds), grokTranscriptionUsd(2) * 3), 9);

    /* A key the server never saw is set aside by its check; the request arriving after it runs nothing. */
    const late = `stt-late-${randomUUID()}`;
    const absent = await page.request.post("/api/generate/check", { headers, data: { key: late, endpoint: "/api/audio/transcribe", body: JSON.stringify(body) } });
    expect(await absent.json()).toEqual({ state: "absent" });
    const arrived = await page.request.post("/api/audio/transcribe", { headers: { ...headers, "Idempotency-Key": late }, data: body });
    expect(arrived.status()).toBe(409);
    expect((await arrived.json()).code).toBe("set_aside");
    rows = await meterRows();
    expect(rows).toHaveLength(1);
  } finally {
    platform.close();
  }
});
