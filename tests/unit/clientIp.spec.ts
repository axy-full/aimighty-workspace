import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const dir = mkdtempSync(path.join(tmpdir(), "particl-client-ip-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

import { clientIp, DIRECT, UNATTRIBUTED, trustedProxyHops } from "../../lib/clientIp";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
const PROXY = { SELFHOST_BEHIND_PROXY: "1" };

/* ── The helper ──────────────────────────────────────────────────────────── */

test("on Vercel the address is read exactly as before: first forwarded entry, then X-Real-IP, else empty", () => {
  const vercel = { VERCEL: "1" };
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), vercel)).toBe("203.0.113.7");
  expect(clientIp(req({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" }), vercel)).toBe("203.0.113.7");
  expect(clientIp(req({ "x-forwarded-for": "2001:DB8::1" }), vercel)).toBe("2001:DB8::1"); // not normalised: same bytes as before
  expect(clientIp(req({ "x-real-ip": "198.51.100.4" }), vercel)).toBe("198.51.100.4");
  expect(clientIp(req({}), vercel)).toBe("");
  /* Not validated there either, so stored keys keep matching byte for byte. */
  expect(clientIp(req({ "x-forwarded-for": "not-an-ip" }), vercel)).toBe("not-an-ip");
  /* The proxy settings are ignored on Vercel, as the origin setting is. */
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "cf-connecting-ip": "192.0.2.1" }),
    { ...vercel, ...PROXY, TRUST_CF_CONNECTING_IP: "1", TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.7");
  /* Empty forwarded value falls through to X-Real-IP (`||`, not `??`). */
  expect(clientIp(req({ "x-forwarded-for": "", "x-real-ip": "198.51.100.4" }), vercel)).toBe("198.51.100.4");
});

test("matches the old Vercel expression for every header shape Vercel sends", () => {
  const old = (h: Headers) => h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? "";
  for (const headers of [{ "x-forwarded-for": "203.0.113.7" } as Record<string, string>, { "x-forwarded-for": "2001:db8::1", "x-real-ip": "2001:db8::1" },
    { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, { "x-real-ip": "198.51.100.4" }, {}]) {
    const r = req(headers);
    expect(clientIp(r, { VERCEL: "1" })).toBe(old(r.headers));
  }
});

test("without the proxy setting no forwarded header is trusted: one fixed bucket", () => {
  for (const env of [{}, { SELFHOST_BEHIND_PROXY: "0" }, { SELFHOST_BEHIND_PROXY: "true" }, { TRUST_CF_CONNECTING_IP: "1" }]) {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), env)).toBe(DIRECT);
    expect(clientIp(req({ "x-real-ip": "203.0.113.7", "cf-connecting-ip": "203.0.113.8" }), env)).toBe(DIRECT);
    expect(clientIp(req({}), env)).toBe(DIRECT);
  }
});

test("behind the proxy the rightmost entry is the client; a spoofed leftmost entry is ignored", () => {
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), PROXY)).toBe("203.0.113.7");
  expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }), PROXY)).toBe("203.0.113.7");
  expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8,203.0.113.7 " }), PROXY)).toBe("203.0.113.7");
  /* X-Real-IP and CF-Connecting-IP are the client's own words without the CF flag. */
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "1.1.1.1", "cf-connecting-ip": "1.1.1.2" }), PROXY)).toBe("203.0.113.7");
  /* Two header lines are joined in order; the proxy's own is still last. */
  const h = new Headers();
  h.append("x-forwarded-for", "1.1.1.1");
  h.append("x-forwarded-for", "203.0.113.7");
  expect(clientIp({ headers: h }, PROXY)).toBe("203.0.113.7");
});

test("hops count trusted proxies from the right", () => {
  const xff = { "x-forwarded-for": "1.1.1.1, 203.0.113.7, 172.18.0.5" };
  expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: "1" })).toBe("172.18.0.5");
  expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.7");
  expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: " 2 " })).toBe("203.0.113.7");
  expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: "3" })).toBe("1.1.1.1");
  /* Fewer entries than hops: nothing to trust. */
  expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: "4" })).toBe(UNATTRIBUTED);
  expect(trustedProxyHops({})).toBe(1);
  expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "" })).toBe(1);
  expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "5" })).toBe(5);
  for (const bad of ["0", "6", "10", "-1", "1.5", "2a", "two", "01", "1e0"]) {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), bad).toBeNull();
    expect(clientIp(req(xff), { ...PROXY, TRUSTED_PROXY_HOPS: bad }), bad).toBe(UNATTRIBUTED);
  }
});

test("CF-Connecting-IP is read only with its flag, and then X-Forwarded-For is not", () => {
  const headers = { "x-forwarded-for": "1.1.1.1, 172.18.0.5", "cf-connecting-ip": "203.0.113.7" };
  expect(clientIp(req(headers), PROXY)).toBe("172.18.0.5");
  expect(clientIp(req(headers), { ...PROXY, TRUST_CF_CONNECTING_IP: "true" })).toBe("172.18.0.5");
  expect(clientIp(req(headers), { ...PROXY, TRUST_CF_CONNECTING_IP: "1" })).toBe("203.0.113.7");
  expect(clientIp(req({ "cf-connecting-ip": "2001:DB8::7" }), { ...PROXY, TRUST_CF_CONNECTING_IP: "1" })).toBe("2001:db8::7");
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), { ...PROXY, TRUST_CF_CONNECTING_IP: "1" })).toBe(UNATTRIBUTED);
  for (const bad of ["", "unknown", "203.0.113.7, 1.1.1.1", "203.0.113.7:443", "999.1.1.1"]) {
    expect(clientIp(req({ "cf-connecting-ip": bad }), { ...PROXY, TRUST_CF_CONNECTING_IP: "1" }), bad).toBe(UNATTRIBUTED);
  }
});

test("behind the proxy, empty or invalid entries fall into one fixed bucket; IPv6 works", () => {
  for (const xff of ["", " ", ",", "1.1.1.1,", "1.1.1.1, unknown", "1.1.1.1, 203.0.113.7:51234", "1.1.1.1, [2001:db8::1]",
    "1.1.1.1, 256.0.0.1", "1.1.1.1, 2001:db8::1::2", `1.1.1.1, ${"a".repeat(80)}`]) {
    expect(clientIp(req({ "x-forwarded-for": xff }), PROXY), xff).toBe(UNATTRIBUTED);
  }
  expect(clientIp(req({}), PROXY)).toBe(UNATTRIBUTED);
  expect(clientIp(req({ "x-real-ip": "203.0.113.7" }), PROXY)).toBe(UNATTRIBUTED);
  expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2001:DB8::1" }), PROXY)).toBe("2001:db8::1");
  expect(clientIp(req({ "x-forwarded-for": "::ffff:203.0.113.7" }), PROXY)).toBe("::ffff:203.0.113.7");
  /* The fixed buckets can never collide with a real address. */
  expect([DIRECT, UNATTRIBUTED].some((b) => /^[0-9a-f:.]+$/i.test(b))).toBe(false);
});

/* ── The limits that use it ──────────────────────────────────────────────── */

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; }
  };
  put(values);
  try { return await fn(); } finally { put(saved); }
}

const BEHIND = { SELFHOST_BEHIND_PROXY: "1", VERCEL: undefined, TRUST_CF_CONNECTING_IP: undefined, TRUSTED_PROXY_HOPS: undefined, APP_ORIGIN: undefined };

async function account(id: string, password: string) {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    args: [id, `${id}@example.test`, id, hashPassword(password), Date.now()],
  });
  return `${id}@example.test`;
}

test("login lock behind the proxy: rotating a spoofed X-Forwarded-For neither escapes the lock nor locks out another client", async () => {
  await withEnv(BEHIND, async () => {
    const { POST } = await import("../../app/api/auth/login/route");
    const { LOCK_MESSAGE } = await import("../../lib/auth");
    const email = await account("victim", "right-password-2026");
    const login = (xff: string, password: string) => POST(new Request("https://particl.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": xff },
      body: JSON.stringify({ email, password }),
    }));
    /* An attacker at 203.0.113.50 writes a fresh "address" in front of every guess. */
    for (let i = 0; i < 8; i++) expect((await login(`198.18.0.${i}, 203.0.113.50`, `guess-${i}`)).status).toBe(401);
    const locked = await login("198.18.0.99, 203.0.113.50", "guess-9");
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toBe(LOCK_MESSAGE);
    /* Even the right password waits out the lock from there. */
    expect((await login("198.18.1.1, 203.0.113.50", "right-password-2026")).status).toBe(429);
    /* Spoofing the victim's own address on the left does not lock the victim, who is still only told "wrong". */
    for (let i = 0; i < 8; i++) expect((await login(`198.51.100.20, 203.0.113.${60 + i}`, `guess-${i}`)).status).toBe(401);
    expect((await login("198.51.100.20", "still-wrong")).status).toBe(401);
  });
});

test("password reset per-source limit behind the proxy counts the proxy's view, not the spoofed entry", async () => {
  await withEnv({ ...BEHIND, RESEND_API_KEY: "unit-not-a-key", MAIL_FROM: "unit@example.test" }, async () => {
    const { POST } = await import("../../app/api/auth/reset/route");
    const { sourceKey } = await import("../../lib/auth");
    const { platformDb } = await import("../../lib/platform");
    const email = await account("resetter", "right-password-2026");
    const real = sourceKey({ headers: new Headers({ "x-forwarded-for": "203.0.113.70" }) });
    expect(sourceKey({ headers: new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.70" }) })).toBe(real);
    expect(sourceKey({ headers: new Headers({ "x-forwarded-for": "203.0.113.70, 1.2.3.4" }) })).not.toBe(real);
    /* This source has already asked for its six resets this hour. */
    const at = Date.now();
    for (let i = 0; i < 6; i++) {
      await platformDb().execute({
        sql: "INSERT INTO password_resets(token_hash,user_id,ip_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        args: [`unit-reset-${i}`, "resetter", real, at, at + 3600_000],
      });
    }
    const count = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?", args: ["resetter"] })).rows[0].n);
    const res = await POST(new Request("https://particl.test/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.200, 203.0.113.70" },
      body: JSON.stringify({ email }),
    }));
    expect(res.status).toBe(200);
    expect(await count()).toBe(6); // no new link minted: the spoofed entry did not buy a fresh allowance
  });
});

test("the salted keys are unchanged on Vercel", async () => {
  await withEnv({ VERCEL: "1", SESSION_SECRET: "unit-salt", SELFHOST_BEHIND_PROXY: undefined }, async () => {
    const { sourceKey } = await import("../../lib/auth");
    const { clientKey } = await import("../../lib/security/review-link");
    const r = { headers: new Headers({ "x-forwarded-for": "203.0.113.7" }) };
    expect(sourceKey(r)).toBe(createHash("sha256").update("unit-salt:login:203.0.113.7").digest("hex").slice(0, 32));
    expect(clientKey(r, "shr_x")).toBe(createHash("sha256").update("unit-salt:review-link:shr_x:203.0.113.7").digest("hex").slice(0, 24));
    expect(clientKey({ headers: new Headers() }, "shr_x")).toBe(createHash("sha256").update("unit-salt:review-link:shr_x:unknown").digest("hex").slice(0, 24));
    expect(sourceKey({ headers: new Headers() })).toBe(createHash("sha256").update("unit-salt:login:").digest("hex").slice(0, 32));
  });
});
