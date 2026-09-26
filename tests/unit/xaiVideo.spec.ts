import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getModel } from "../../lib/models";
import { modelConfigured } from "../../lib/providers";
import { estimateCostUsd } from "../../lib/vendorPricing";
import { pollXaiVideo, submitXaiVideo, xaiVideoBody } from "../../lib/xaiVideo";
import type { Reference, VideoParams } from "../../lib/ark";
import { XaiHttpError, xaiSubmissionRejected } from "../../lib/xaiErrors";
import { PreflightError } from "../../lib/preflight";

/**
 * Owner, 23 September: Grok APIs wherever possible. Grok Imagine Video runs
 * on xAI's API with the xAI key (billed as xAI), asynchronously: a request id,
 * then polls until done. The network is stubbed — nothing is spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-xai-video-"));
process.env.PLATFORM_DATABASE_URL ??= "file:" + path.join(dir, "platform.db");
const ENV = ["XAI_API_KEY", "AI_GATEWAY_API_KEY", "ENGINE_MOCK", "VERCEL", "VERCEL_OIDC_TOKEN", "XAI_BASE_URL"] as const;
async function withEnv<T>(values: Partial<Record<(typeof ENV)[number], string>>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  try { for (const name of ENV) delete process.env[name]; Object.assign(process.env, values); return await run(); }
  finally { for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}
async function stubbed<T>(reply: (url: string, method: string) => unknown, run: () => Promise<T>) {
  const real = globalThis.fetch, sent: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), method = init?.method ?? "GET";
    sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
    return Response.json(reply(url, method));
  }) as typeof fetch;
  try { return { value: await run(), sent }; } finally { globalThis.fetch = real; }
}
const params = (over: Partial<VideoParams> = {}): VideoParams => ({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, ...over });
const image = (role: Reference["role"]): Reference => ({ id: "up_1", mime: "image/png", ext: "png", storedUrl: "/api/uploads/up_1", role, kind: "image" });

test("Grok video is priced per second by resolution, sound included", () => {
  expect(estimateCostUsd("grok-imagine-video-1.5", "1080p", "16:9", 10, 0, false)?.net).toBeCloseTo(2.5, 6);
  expect(estimateCostUsd("grok-imagine-video-1.5", "720p", "9:16", 5, 0, false)?.net).toBeCloseTo(0.7, 6);
  expect(estimateCostUsd("grok-imagine-video", "480p", "1:1", 15, 0, false)?.net).toBeCloseTo(0.75, 6);
  expect(getModel("grok-imagine-video").resolutions).not.toContain("1080p");
});

test("Grok video is offered only on the xAI key; Grok stills also through the gateway", async () => {
  await withEnv({ XAI_API_KEY: "xai-unit" }, () => {
    expect(modelConfigured(getModel("grok-imagine-video-1.5"))).toBe(true);
    expect(modelConfigured(getModel("grok-imagine-image-2.0"))).toBe(true);
  });
  await withEnv({ AI_GATEWAY_API_KEY: "gw-unit" }, () => {
    expect(modelConfigured(getModel("grok-imagine-video-1.5"))).toBe(false);
    expect(modelConfigured(getModel("grok-imagine-image-2.0"))).toBe(true);
  });
});

test("what xAI is sent, and what it refuses before anything is sent", async () => {
  const model = getModel("grok-imagine-video-1.5");
  expect(await xaiVideoBody(model, "A fox", params({ resolution: "1080p", duration: 8 }), [])).toEqual({ model: "grok-imagine-video-1.5", prompt: "A fox", duration: 8, aspect_ratio: "16:9", resolution: "1080p" });
  await expect(xaiVideoBody(model, "A fox", params(), [image("first_frame"), image("reference_image")])).rejects.toThrow("a first frame or reference images, not both");
  await expect(xaiVideoBody(model, "A fox", params({ resolution: "1080p" }), [image("reference_image")])).rejects.toThrow("up to 720p");
  await expect(xaiVideoBody(model, "A fox", params(), [{ ...image("reference_video"), kind: "video" }])).rejects.toThrow("images, not videos");
});

test("submit posts to xAI with the key; polling reads running, done with xAI's charge, and failures", async () => {
  await withEnv({ XAI_API_KEY: "xai-unit" }, async () => {
    const { value: id, sent } = await stubbed(() => ({ request_id: "req_123" }), () => submitXaiVideo(getModel("grok-imagine-video"), "A fox", params(), []));
    expect(id).toBe("req_123");
    expect(sent[0]).toMatchObject({ url: "https://api.x.ai/v1/videos/generations", method: "POST", auth: "Bearer xai-unit", body: { model: "grok-imagine-video", prompt: "A fox", duration: 5, aspect_ratio: "16:9", resolution: "720p" } });

    const pending = await stubbed(() => ({ status: "pending", progress: 40 }), () => pollXaiVideo("req_123"));
    expect(pending.sent[0]).toMatchObject({ url: "https://api.x.ai/v1/videos/req_123", method: "GET" });
    expect(pending.value.status).toBe("running");

    const done = await stubbed(() => ({ status: "done", video: { url: "https://vidgen.x.ai/clip.mp4", duration: 5, respect_moderation: true }, usage: { cost_in_usd_ticks: 3_500_000_000 } }), () => pollXaiVideo("req_123"));
    expect(done.value).toMatchObject({ status: "succeeded", videoUrl: "https://vidgen.x.ai/clip.mp4", costUsd: 0.35 });

    for (const [reply, message] of [
      [{ status: "failed", error: { message: "Bad prompt" } }, "Bad prompt"],
      [{ status: "expired" }, "expired"],
      [{ status: "done", video: { url: "https://vidgen.x.ai/x.mp4", respect_moderation: false } }, "content policy"],
    ] as const) {
      const out = await stubbed(() => reply, () => pollXaiVideo("req_123"));
      expect(out.value.status).toBe("failed");
      expect(out.value.error).toContain(message);
    }
  });
});

/* A take whose outcome is certain releases its reservation; one that may be running keeps it. */
test("a request stopped before it is sent, or refused by xAI, is certain; a 5xx is not", async () => {
  const model = getModel("grok-imagine-video-1.5");
  await withEnv({ XAI_API_KEY: "xai-unit" }, async () => {
    for (const [refs, resolution, message] of [
      [[image("reference_image")], "1080p", "up to 720p"],
      [[image("first_frame"), image("last_frame")], "720p", "no last frame"],
    ] as const) {
      const { sent } = await stubbed(() => ({ request_id: "never" }), async () => {
        const error = await submitXaiVideo(model, "A fox", params({ resolution }), [...refs]).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PreflightError);
        expect((error as Error).message).toContain(message);
      });
      expect(sent).toEqual([]);
    }
    const real = globalThis.fetch;
    try {
      for (const [status, certain] of [[400, true], [401, true], [422, true], [429, true], [500, false], [503, false]] as const) {
        globalThis.fetch = (async () => Response.json({ error: { message: "no" } }, { status })) as typeof fetch;
        const error = await submitXaiVideo(model, "A fox", params(), []).catch((e: unknown) => e);
        expect(error, String(status)).toBeInstanceOf(XaiHttpError);
        expect((error as XaiHttpError).status).toBe(status);
        expect(xaiSubmissionRejected(error), String(status)).toBe(certain);
      }
    } finally { globalThis.fetch = real; }
  });
  await withEnv({}, async () => {
    const error = await submitXaiVideo(model, "A fox", params(), []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
  });
  expect(xaiSubmissionRejected(new Error("socket hang up"))).toBe(false);
});
