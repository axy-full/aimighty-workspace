import { test, expect } from "@playwright/test";
import { DEVELOPER_API_BASE, DEVELOPER_PROBE_PATH, parseDeveloperProbe, probeDeveloperApi } from "../../lib/higgsfield-consumer/developer-api";

/** The developer-API probe: one free read, a plain answer, no provider text surfaced, no token in the answer. */
test("a 200 is reachable with the balance where the reply carries one; refusals and outages are plain reasons", () => {
  expect(parseDeveloperProbe(200, { balance: { credits: 1234, unit: "credits" } })).toEqual({ reachable: true, balance: 1234, unit: "credits" });
  expect(parseDeveloperProbe(200, { available: 5 })).toEqual({ reachable: true, balance: 5, unit: null });
  expect(parseDeveloperProbe(200, "<html>")).toEqual({ reachable: true, balance: null, unit: null });
  expect(parseDeveloperProbe(401, { error: "PRIVATE TOKEN DETAILS" })).toMatchObject({ reachable: false, status: 401 });
  expect(JSON.stringify(parseDeveloperProbe(401, { error: "PRIVATE TOKEN DETAILS" }))).not.toContain("PRIVATE");
  expect(parseDeveloperProbe(403, null)).toMatchObject({ reachable: false, status: 403 });
  expect((parseDeveloperProbe(404, null) as { reason: string }).reason).toContain("404");
  expect((parseDeveloperProbe(429, null) as { reason: string }).reason).toContain("rate-limiting");
  expect((parseDeveloperProbe(502, null) as { reason: string }).reason).toContain("HTTP 502");
});

test("the probe sends the bearer once to the CLI's gateway path, follows no redirect, and turns a network failure into an answer", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = await probeDeveloperApi("tok_abc", (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ credits: 42 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
  expect(ok).toEqual({ reachable: true, balance: 42, unit: null });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${DEVELOPER_API_BASE}${DEVELOPER_PROBE_PATH}`);
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok_abc");
  expect(calls[0].init.redirect).toBe("manual");
  const down = await probeDeveloperApi("tok_abc", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  expect(down).toEqual({ reachable: false, status: null, reason: "The developer API could not be reached." });
});
