import { test, expect } from "@playwright/test";
import { dispatchMode, dispatchEvent, dispatchOrigin, EVENTS } from "../../lib/dispatch";

const production = {
  NODE_ENV: "production",
  CRON_SECRET: "fixture-cron-secret",
  APP_ORIGIN: "https://app.example.test",
};

test("dispatch mode: native in production with a secret and an origin, Inngest only when asked for with both keys", () => {
  expect(dispatchMode(production)).toBe("native");
  expect(dispatchMode({ ...production, APP_ORIGIN: undefined, VERCEL_PROJECT_PRODUCTION_URL: "app.example.test" })).toBe("native");
  expect(dispatchOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "app.example.test" })).toBe("https://app.example.test");
  // Explicit native outside production.
  expect(dispatchMode({ ...production, NODE_ENV: "development", DISPATCH_MODE: "native" })).toBe("native");
  // Inngest needs the opt-in AND both keys; anything less falls through to native/inline.
  expect(dispatchMode({ ...production, DISPATCH_MODE: "inngest", INNGEST_EVENT_KEY: "k", INNGEST_SIGNING_KEY: "s" })).toBe("inngest");
  expect(dispatchMode({ ...production, DISPATCH_MODE: "inngest", INNGEST_EVENT_KEY: "k" })).toBe("native");
  expect(dispatchMode({ ...production, INNGEST_EVENT_KEY: "k", INNGEST_SIGNING_KEY: "s" })).toBe("native");
  expect(dispatchMode({ NODE_ENV: "development", DISPATCH_MODE: "inngest", INNGEST_EVENT_KEY: "k", INNGEST_SIGNING_KEY: "s" })).toBe("inngest");
});

test("dispatch mode falls back to inline without a secret, without an origin, with mocks, or outside production", () => {
  expect(dispatchMode({ ...production, CRON_SECRET: undefined })).toBe("inline");
  expect(dispatchMode({ ...production, CRON_SECRET: "" })).toBe("inline");
  expect(dispatchMode({ ...production, APP_ORIGIN: undefined })).toBe("inline");
  expect(dispatchMode({ ...production, APP_ORIGIN: "not a url" })).toBe("inline");
  expect(dispatchMode({ ...production, ENGINE_MOCK: "1" })).toBe("inline");
  expect(dispatchMode({ ...production, NODE_ENV: "development" })).toBe("inline");
  expect(dispatchMode({ ...production, NODE_ENV: "test" })).toBe("inline");
  expect(dispatchMode({})).toBe("inline");
});

test("dispatchEvent posts the event with the bearer and answers true only for a 202, never throwing", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const event = { id: "render-ws-gen", name: EVENTS.render, data: { genId: "gen_1", kind: "image", workspaceId: "ws_1" } };
  const fetchWith = (status: number) => async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ accepted: status === 202 }), { status });
  };
  expect(await dispatchEvent(event, { env: production, fetch: fetchWith(202) as typeof fetch })).toBe(true);
  expect(calls[0].url).toBe("https://app.example.test/api/worker");
  expect(calls[0].init.method).toBe("POST");
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer fixture-cron-secret");
  expect(headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(String(calls[0].init.body))).toEqual(event);
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);

  expect(await dispatchEvent(event, { env: production, fetch: fetchWith(401) as typeof fetch })).toBe(false);
  expect(await dispatchEvent(event, { env: production, fetch: fetchWith(500) as typeof fetch })).toBe(false);
  expect(await dispatchEvent(event, { env: production, fetch: fetchWith(200) as typeof fetch })).toBe(false);
  const timeout = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
  expect(await dispatchEvent(event, { env: production, fetch: timeout as unknown as typeof fetch })).toBe(false);
  const network = async () => { throw new TypeError("fetch failed"); };
  expect(await dispatchEvent(event, { env: production, fetch: network as unknown as typeof fetch })).toBe(false);
  // Nothing to post to: no origin, or no secret to authenticate with.
  let posted = 0;
  const counting = (async () => { posted++; return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  expect(await dispatchEvent(event, { env: { ...production, APP_ORIGIN: undefined }, fetch: counting })).toBe(false);
  expect(await dispatchEvent(event, { env: { ...production, CRON_SECRET: undefined }, fetch: counting })).toBe(false);
  expect(posted).toBe(0);
});
