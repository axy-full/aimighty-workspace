import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateImage, googleDoorShut } from "../../lib/gemini";
import { getModel } from "../../lib/models";

/**
 * Nano Banana on the Google key falls back to the gateway only when the
 * Google door certainly charged nothing: a key refused, a quota spent, a host
 * never reached. A timeout, a reset connection or a 5xx may be a still Google
 * is already drawing and billing, so it is never sent a second time.
 * The network is stubbed; nothing is spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-gemini-doors-"));
process.env.PLATFORM_DATABASE_URL ??= "file:" + path.join(dir, "platform.db");
const ENV = ["GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "ENGINE_MOCK", "GEMINI_BASE_URL"] as const;
const GOOGLE = "https://generativelanguage.googleapis.com";

async function doors(google: () => Response | Promise<Response>) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const real = globalThis.fetch, sent: string[] = [];
  for (const name of ENV) delete process.env[name];
  process.env.GEMINI_API_KEY = "gemini-unit";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GOOGLE)) { sent.push("google"); return google(); }
    sent.push("gateway");
    return Response.json({ error: { message: "gateway stub" } }, { status: 418 });
  }) as typeof fetch;
  try {
    const error = await generateImage({ model: getModel("gemini-3.1-flash-image"), prompt: "A lighthouse", ratio: "16:9", size: "1K", references: [] })
      .then(() => null, (e: unknown) => e as Error);
    return { sent, error };
  } finally {
    globalThis.fetch = real;
    for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
}
const unreached = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("a key refused, a quota spent or a host never reached falls through to the gateway", async () => {
  for (const [status, body] of [
    [401, { error: { message: "unauthorized" } }],
    [403, { error: { message: "forbidden" } }],
    [429, { error: { message: "RESOURCE_EXHAUSTED" } }],
    [400, { error: { message: "API key not valid. Please pass a valid API key." } }],
  ] as const) {
    const out = await doors(() => Response.json(body, { status }));
    expect(out.sent, String(status)).toEqual(["google", "gateway"]);
  }
  for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
    const out = await doors(() => { throw unreached(code); });
    expect(out.sent, code).toEqual(["google", "gateway"]);
  }
});

test("a timeout, a reset connection or a 5xx fails the take without a second paid call", async () => {
  for (const status of [500, 503]) {
    const out = await doors(() => Response.json({ error: { message: "backend error" } }, { status }));
    expect(out.sent, String(status)).toEqual(["google"]);
    expect(out.error?.message).toContain(`(${status})`);
  }
  const timedOut = await doors(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
  expect(timedOut.sent).toEqual(["google"]);
  expect(timedOut.error?.message).toMatch(/timeout/i);
  const reset = await doors(() => { throw unreached("ECONNRESET"); });
  expect(reset.sent).toEqual(["google"]);
  const refused = await doors(() => Response.json({ error: { message: "Request blocked by the safety filter" } }, { status: 400 }));
  expect(refused.sent).not.toContain("gateway");
});

test("the classification itself", () => {
  expect(googleDoorShut(unreached("EAI_AGAIN"))).toBe(true);
  expect(googleDoorShut(Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] } }))).toBe(true);
  expect(googleDoorShut(Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] } }))).toBe(false);
  expect(googleDoorShut(new Error("Image engine request failed (503): quota"))).toBe(false);
  expect(googleDoorShut(new DOMException("aborted", "AbortError"))).toBe(false);
  expect(googleDoorShut(null)).toBe(false);
});
