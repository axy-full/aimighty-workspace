import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * Lane 5 · the independent review of #558, kept as permanent tests. The reviewer's six probes (P1–P6) asserted what
 * was wrong; here each asserts the fix, beside the other findings (H1, M1, M2, L1–L8). Neutral names only.
 */
const dir = freshDatabases("review558");
const A = workspace(dir, "ws_rvwa"), B = workspace(dir, "ws_rvwb");
const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const ORIGIN = "http://localhost";
test.describe.configure({ mode: "serial" });

/** How a build from before this branch reads a token's stored scope: release/1's lib/auth.ts, `callerFromToken`. */
const olderBuildScope = (stored: unknown) => (stored === "read" ? "read" : "render");

const PREP = rawToken(A, "7"), ODD = rawToken(A, "8"), RENDER = rawToken(A, "9");
const member = (): Who => ({ mode: "session", ws: A, userId: "member", name: "Member Person", role: "member", bearer: "" });
const owner = (): Who => ({ mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" });
const token = (raw: string): Who => ({ mode: "token", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: raw });

async function seedAll() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  for (const ws of [A, B]) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,0,1,'owner',0,0)", args: [ws.id, ws.id, `Studio ${ws.id.slice(-1)}`, ws.dbUrl] });
  }
  await seedPeople(A, [{ id: "owner", name: "Owner Person" }, { id: "member", name: "Member Person" }, { id: "other", name: "Other Member" }], [
    { id: "tok_odd", userId: "owner", scope: "RENDER", raw: ODD },
    { id: "tok_render", userId: "owner", scope: "render", raw: RENDER },
  ]);
  await runInTenant(A, async () => {
    await ready();
    await db().batch([
      "INSERT OR IGNORE INTO projects(id,name,description,created_at) VALUES('prod_one','A short film','',0)",
      `INSERT OR IGNORE INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,project_id,shot_id,version,review_state,deleted)
         VALUES('g_review','video','mock','mock-model','p','{}','succeeded','owner',1,1,'prod_one',NULL,1,'picked',0)`,
      "INSERT OR IGNORE INTO notes(id,gen_id,user_id,text,created_at) VALUES('n_team','g_review','owner','A team note, internal',3)",
    ], "write");
  });
}

/** A consent recording, stored the way the consent step stores it: never an upload. */
async function recording(who: Who = member()): Promise<string> {
  const { runInTenant } = await import("../../lib/tenant");
  const consent = await import("../../lib/security/consent");
  const made = await runInTenant(A, () => consent.storeConsentRecording({ bytes: Buffer.from("RIFF0000WAVEfmt "), mime: "audio/wav" }, { user: { id: who.userId } }));
  return made.id;
}

const record = async (over: Record<string, unknown> = {}) => {
  const { runInTenant } = await import("../../lib/tenant");
  const consent = await import("../../lib/security/consent");
  const rec = await recording();
  return runInTenant(A, () => consent.recordConsent({
    projectId: "prod_one", subjectKey: "node-lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: false,
    uses: ["production", "identity"], otherUse: "", until: future(30), recordingId: rec, attested: true, ...over,
  }, { user: { id: "member" } }));
};

/* ── H1 and L5: a prepare token is "read" to every older build; an absent or unknown scope makes a read-only token ── */

async function tokensRoute(who: Who) {
  const auth = await authAs(who);
  return load<typeof import("../../app/api/tokens/route")>("app/api/tokens/route.ts", {
    "@/lib/auth": auth, "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/credits": await import("../../lib/credits"), "@/lib/cycle": await import("../../lib/cycle"), "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
    "@/lib/tokenUsage": await import("../../lib/tokenUsage"), "@/lib/securityAudit": await import("../../lib/securityAudit"),
    "@/lib/security/token-grants": await import("../../lib/security/token-grants"),
  });
}

test("H1: a prepare token is stored read-only, its grant kept apart, so an older build reads it as read-only, never as spending", async () => {
  await seedAll();
  const who = owner();
  const route = await tokensRoute(who);
  const made = await (await route.POST(scoped(who, `${ORIGIN}/api/tokens`, { method: "POST", body: JSON.stringify({ name: "Studio script", scope: "prepare" }) }), undefined as never)).json();
  expect(made.scope).toBe("prepare");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const row = (await runInTenant(A, () => db().execute({ sql: "SELECT scope, cap_credits, cap_usd FROM api_tokens WHERE id = ?", args: [made.id] }))).rows[0];
  expect(row.scope).toBe("read");
  /* An older build (rolled back, or another deployment on the same database) reads the row: a read-only token. */
  expect(olderBuildScope(row.scope)).toBe("read");
  /* This build reads the grant beside it. */
  const auth = await authAs(token(made.token));
  expect((await auth.callerFromToken(made.token))?.token?.scope).toBe("prepare");
  const listed = await (await route.GET(scoped(who, `${ORIGIN}/api/tokens`), undefined as never)).json();
  expect(listed.tokens.find((t: { id: string }) => t.id === made.id)?.scope).toBe("prepare");
  /* A revoked token's grant opens nothing. */
  const one = load<typeof import("../../app/api/tokens/[id]/route")>("app/api/tokens/[id]/route.ts", { "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"), "@/lib/securityAudit": await import("../../lib/securityAudit") });
  await one.DELETE(scoped(who, `${ORIGIN}/api/tokens/${made.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: made.id }) });
  expect(await auth.callerFromToken(made.token)).toBeNull();
});

test("L5: a token minted with no scope, or a scope the server doesn't know, is read-only, never spending", async () => {
  const who = owner();
  const route = await tokensRoute(who);
  for (const body of [{ name: "no scope" }, { name: "odd scope", scope: "admin" }, { name: "case", scope: "Render" }]) {
    const made = await (await route.POST(scoped(who, `${ORIGIN}/api/tokens`, { method: "POST", body: JSON.stringify(body) }), undefined as never)).json();
    expect(made.scope, body.name).toBe("read");
    const auth = await authAs(token(made.token));
    expect((await auth.callerFromToken(made.token))?.token?.scope, body.name).toBe("read");
  }
  /* "render" is still accepted as the word itself, from the older pages and the CLI. */
  const render = await (await route.POST(scoped(who, `${ORIGIN}/api/tokens`, { method: "POST", body: JSON.stringify({ name: "cli", scope: "render" }) }), undefined as never)).json();
  expect(render.scope).toBe("render");
});

test("P2: an odd-case stored scope reads as read-only; a prepare token's PATCH, PUT and DELETE are refused on the opted-in routes", async () => {
  const auth = await authAs(token(ODD));
  expect((await auth.callerFromToken(ODD))?.token?.scope).toBe("read");
  expect(await auth.callerFromToken("rv_" + "A".repeat(43))).toBeNull();
  const grants = await import("../../lib/security/token-grants");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { tokenHash } = await import("../../lib/auth");
  await runInTenant(A, async () => {
    await db().execute({ sql: "INSERT OR IGNORE INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_prep',?,'prep','owner','read',0)", args: [tokenHash(PREP)] });
    await grants.grantPrepare("tok_prep");
  });
  const who = token(PREP);
  const a2 = await authAs(who);
  const handler = a2.withTenant(async () => Response.json({ reached: true }), { preparedJobs: true, mcpTransport: true });
  for (const method of ["PATCH", "PUT", "DELETE"]) expect((await handler(new Request(`${ORIGIN}/x`, { method }), undefined as never)).status, method).toBe(403);
  expect((await handler(new Request(`${ORIGIN}/x`, { method: "POST" }), undefined as never)).status).toBe(200);
  const closed = a2.withTenant(async () => Response.json({ reached: true }), { readOnlyPostTransport: true });
  expect((await closed(new Request(`${ORIGIN}/x`, { method: "POST" }), undefined as never)).status).toBe(403);
});

/* ── M1: identity training needs a live consent record on every path ─────────────────────────────────────────── */

async function soulRoute(who: Who) {
  const sent: unknown[] = [], claimed: string[] = [];
  class SoulIdentityError extends Error { status = 400; }
  class SpendReservationError extends Error { status = 402; }
  const route = load<typeof import("../../app/api/soul/identities/route")>("app/api/soul/identities/route.ts", {
    "@/lib/auth": await authAs(who),
    "@/lib/generationRequests": { withGenerationRequest: async (_r: Request, userId: string, fn: (claim: { userId: string }) => Promise<Response>) => { claimed.push(userId); return fn({ userId }); }, SpendReservationError },
    "@/lib/soulIdentities": { createSoulIdentity: async (body: unknown) => { sent.push(body); return { id: `soul_${sent.length}`, name: "X", status: "submitting" }; }, listSoulIdentities: async () => [], syncSoulIdentity: async () => null, soulIdentityTerms: () => ({}), SoulIdentityError },
    "@/lib/vendorRates": { soulCharacterGenerationEnabled: () => true },
    "@/lib/higgsfield": { higgsfieldConfigured: () => true },
    "@/lib/security/consent": await import("../../lib/security/consent"), "@/lib/security/consent-words": await import("../../lib/security/consent-words"), "@/lib/security/people-only": await import("../../lib/security/people-only"),
  });
  return { route, sent, claimed };
}

test("P1 + P5 (M1): training is refused, in words, before anything is claimed or sent, without a live record that matches the production, the cast member and the use", async () => {
  const who = member();
  const { route, sent, claimed } = await soulRoute(who);
  const live = await record({ subjectKey: "node-x" });
  const adsOnly = await record({ subjectKey: "node-x", uses: ["ads"] });
  const body = (over: Record<string, unknown>) => JSON.stringify({ name: "X", subjectType: "character", references: [{ uploadId: "upl_x" }], consent: true, projectId: "prod_one", subjectKey: "node-x", ...over });
  const post = (over: Record<string, unknown>) => route.POST(scoped(who, `${ORIGIN}/api/soul/identities`, { method: "POST", body: body(over) }), undefined as never);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{}, /consent/i],                                                    /* the old pages' tick-box alone */
    [{ consentId: live.id, projectId: undefined }, /production/i],      /* P5: no production named */
    [{ consentId: live.id, projectId: "prod_other" }, /another production/i],
    [{ consentId: live.id, subjectKey: "node-other" }, /another cast member/i],
    [{ consentId: live.id, subjectKey: undefined }, /cast member/i],
    [{ consentId: adsOnly.id }, /training an identity/i],
  ];
  for (const [over, words] of cases) {
    const res = await post(over);
    expect(res.status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error, JSON.stringify(over)).toMatch(words);
  }
  expect(sent).toEqual([]);
  expect(claimed).toEqual([]);
  expect((await post({ consentId: live.id })).status).toBe(202);
  expect(sent).toHaveLength(1);
  /* P1, in the library: no production key is a refusal, not a pass. */
  const consent = await import("../../lib/security/consent");
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(A, async () => { await expect(consent.consentForTraining(live.id, [], "node-x")).rejects.toThrow(/production/i); });
});

test("M1: the older identity-training route needs the same live record", async () => {
  const src = readFileSync("app/api/identities/[id]/train/route.ts", "utf8");
  expect(src).toContain("consentForTraining(");
});

/* ── M2: the consent recording is never an upload; only the recorder, an owner or an admin hears it, by session ── */

test("P6 (M2): the recording is not in the uploads, the library or any token's reach; the recorder, an owner or an admin plays it", async () => {
  const rec = await record();
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const uploads = await runInTenant(A, () => db().execute("SELECT id FROM uploads"));
  expect(JSON.stringify(uploads.rows)).not.toContain(rec.recordingUrl?.split("/")[3] ?? "none");
  for (const who of [token(PREP), token(RENDER), member()]) {
    const route = load<typeof import("../../app/api/uploads/route")>("app/api/uploads/route.ts", {
      "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"),
      "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
      "@/lib/uploadReservations": { abandonUpload: async () => {}, beginDirectUpload: async () => {}, uploadFailure: () => null, UploadError: class extends Error {} },
      "@/lib/uploadIntake": { storeReferenceUpload: async () => {} },
      "@/lib/uploadLibrary": await import("../../lib/uploadLibrary"), "@/lib/assetPagination": await import("../../lib/assetPagination"),
    });
    const res = await route.GET(new Request(`${ORIGIN}/api/uploads`), undefined as never);
    expect(JSON.stringify(await res.json())).not.toMatch(/crec_/);
  }
  const play = async (who: Who) => {
    const r = load<typeof import("../../app/api/identity-consents/[id]/recording/route")>("app/api/identity-consents/[id]/recording/route.ts", {
      "@/lib/auth": await authAs(who), "@/lib/security/consent": await import("../../lib/security/consent"),
      "@/lib/security/consent-words": await import("../../lib/security/consent-words"), "@/lib/security/people-only": await import("../../lib/security/people-only"),
    });
    return r.GET(scoped(who, `${ORIGIN}/api/identity-consents/${rec.id}/recording`), { params: Promise.resolve({ id: rec.id }) });
  };
  expect((await play(member())).status).toBe(200);
  expect((await play(owner())).status).toBe(200);
  expect((await play({ ...member(), userId: "other", name: "Other Member" })).status).toBe(403);
  for (const raw of [PREP, RENDER, ODD]) expect((await play(token(raw))).status).toBe(403);
  /* Storing one is a person's act too. */
  const consent = await import("../../lib/security/consent");
  const { PeopleOnlyError } = await import("../../lib/security/people-only");
  await runInTenant(A, async () => {
    await expect(consent.storeConsentRecording({ bytes: Buffer.from("x"), mime: "audio/wav" }, { user: { id: "member" }, token: { scope: "prepare" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(consent.storeConsentRecording({ bytes: Buffer.from("x"), mime: "image/png" }, { user: { id: "member" } })).rejects.toThrow(/sound or video/);
  });
  /* A record cites only a recording its own recorder made. */
  const theirs = await recording({ ...member(), userId: "other", name: "Other Member" });
  await expect(record({ recordingId: theirs })).rejects.toThrow(/recording/i);
});

/* ── L1–L4: review links ─────────────────────────────────────────────────────────────────────────────────────── */

test("P3 (L1, L2, L3): older links keep their old behaviour; a client sees only their own link's words and the team's decisions; writes are limited per client, reads never lock out", async () => {
  const shares = await import("../../lib/shares");
  const { runInTenant } = await import("../../lib/tenant");
  const link = await import("../../lib/security/review-link");
  const { db } = await import("../../lib/db");
  await runInTenant(A, async () => {
    const one = await link.mintReviewLink({ workspaceId: A.id, projectId: "prod_one", by: "Owner Person" });
    const two = await link.mintReviewLink({ workspaceId: A.id, projectId: "prod_one", by: "Owner Person" });
    const r = await link.recordVerdict({ shareId: one.share.id, projectId: "prod_one", genId: "g_review", verdict: "changes", name: "Client One Name", text: "private remark from client one", client: "ip-one" });
    expect(r.ok).toBe(true);
    const seenByTwo = JSON.stringify(await link.reviewSet(two.token, two.share.id, "prod_one"));
    expect(seenByTwo).not.toContain("Client One Name");
    expect(seenByTwo).not.toContain("private remark from client one");
    expect(seenByTwo).not.toContain("A team note, internal");
    const seenByOne = JSON.stringify(await link.reviewSet(one.token, one.share.id, "prod_one"));
    expect(seenByOne).toContain("private remark from client one");

    /* Writes: per link per client. A leaked link's flood doesn't lock out the real client, and reads are never limited. */
    for (let i = 0; i < link.LIMITS.write; i++) expect(await link.underLimit(two.share.id, "leaked-copy")).toBe(true);
    expect(await link.underLimit(two.share.id, "leaked-copy")).toBe(false);
    expect(await link.underLimit(two.share.id, "the-real-client")).toBe(true);
    /* Old windows are pruned as new ones are counted. */
    await link.underLimit(two.share.id, "the-real-client", Date.now() + 3 * link.WINDOW_MS);
    const left = await db().execute({ sql: "SELECT MIN(bucket) AS b FROM review_link_hits WHERE share_id = ?", args: [two.share.id] });
    expect(Number(left.rows[0].b)).toBeGreaterThanOrEqual(Math.floor(Date.now() / link.WINDOW_MS) + 2);
  });
  /* An older link: no counter is touched and none of the new tables is made by reading it. */
  const older = await shares.mintShare({ workspaceId: A.id, projectId: "prod_one", by: "Owner Person" });
  const view = load<typeof import("../../app/api/review/[token]/route")>("app/api/review/[token]/route.ts", {
    "@/lib/tenant": await import("../../lib/tenant"), "@/lib/shares": shares, "@/lib/db": await import("../../lib/db"),
    "@/lib/settings": await import("../../lib/settings"), "@/lib/originalMedia": await import("../../lib/originalMedia"), "@/lib/security/review-link": link,
  });
  for (let i = 0; i < link.LIMITS.write + 5; i++) expect((await view.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ token: older.token }) })).status).toBe(200);
  const hits = await runInTenant(A, () => db().execute({ sql: "SELECT COUNT(*) AS n FROM review_link_hits WHERE share_id = ?", args: [older.share.id] }));
  expect(Number(hits.rows[0].n)).toBe(0);
});

test("L4: a client link is one write, and a build that doesn't know client links can't open it (no older view with prompts)", async () => {
  const link = await import("../../lib/security/review-link");
  const shares = await import("../../lib/shares");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { tokenHash } = await import("../../lib/auth");
  const made = await runInTenant(A, () => link.mintReviewLink({ workspaceId: A.id, projectId: "prod_one", by: "Owner Person" }));
  /* An older build looks a link up by the plain hash of its secret: nothing is found. */
  const older = await platformDb().execute({ sql: "SELECT id FROM p_shares WHERE token_hash = ?", args: [tokenHash(made.token)] });
  expect(older.rows).toEqual([]);
  const found = await shares.resolveShare(made.token);
  expect(found?.review).toBe(true);
  expect(found?.share.id).toBe(made.share.id);
  /* An older-style link is still an older link. */
  const plain = await shares.mintShare({ workspaceId: A.id, projectId: "prod_one", by: "Owner Person" });
  expect((await shares.resolveShare(plain.token))?.review).toBe(false);
});

/* ── L6, L7, L8 ─────────────────────────────────────────────────────────────────────────────────────────────── */

test("L6: the 50-waiting cap holds under many prepared jobs at once", async () => {
  const jobs = await import("../../lib/security/prepared-jobs");
  const { runInTenant } = await import("../../lib/tenant");
  const results = await runInTenant(A, () => Promise.allSettled(Array.from({ length: 70 }, (_, i) => jobs.prepareJob({ prompt: `Shot ${i}` }, { id: "tok_cap", scope: "prepare" }))));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(jobs.WAITING_LIMIT);
  const waiting = await runInTenant(A, () => jobs.preparedJobs({ tokenId: "tok_cap", state: "waiting" }));
  expect(waiting).toHaveLength(jobs.WAITING_LIMIT);
});

test("L7: Atomik's Tools page calls a prepare token what it is", async () => {
  const { tokenFacts, scopeWords } = await import("../../lib/shell/tools-connections");
  expect(scopeWords("prepare")).toBe("Prepares jobs only");
  expect(tokenFacts({ id: "t", name: "x", scope: "prepare", lastUsed: null, createdAt: 0, spendThisMonth: 0, capCredits: null }, "credits")).toMatch(/^Prepares jobs only · /);
  expect(readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8")).toMatch(/t\.scope === "render" \? "available"/);
});

test("L8: an admin's API token can't file a top-up request, start checkout or withdraw one", async () => {
  for (const raw of [RENDER, PREP]) {
    const who = token(raw);
    let touched = 0;
    const route = load<typeof import("../../app/api/workspaces/topups/route")>("app/api/workspaces/topups/route.ts", {
      "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"),
      "@/lib/credits": { creditState: async () => ({}), creditsApply: () => true }, "@/lib/packs": { packs: () => [] }, "@/lib/creditTerms": { creditUsd: () => 0.1 },
      "@/lib/payments": { checkoutReady: () => true, paymentProvider: () => "manual", startCheckout: async () => { touched++; return {}; } },
      "@/lib/topups": { listTopups: async () => [], requestTopup: async () => { touched++; return {}; }, cancelTopup: async () => { touched++; return true; }, OPEN_LIMIT: 3 },
      "@/lib/platform": { listGrants: async () => [], SUPER_ADMIN_EMAIL: "" }, "@/lib/mail": { sendMail: async () => {}, mailConfigured: () => false, inviteOrigin: () => "" },
    });
    expect((await route.POST(scoped(who, `${ORIGIN}/api/workspaces/topups`, { method: "POST", body: JSON.stringify({ pack: "starter" }) }), undefined as never)).status).toBe(403);
    expect((await route.DELETE(scoped(who, `${ORIGIN}/api/workspaces/topups?id=t1`, { method: "DELETE" }), undefined as never)).status).toBe(403);
    expect(touched).toBe(0);
  }
});

test("P4: a member reads every link's client responses on the team side; the list carries no secret", async () => {
  const who = member();
  const team = load<typeof import("../../app/api/review-links/route")>("app/api/review-links/route.ts", {
    "@/lib/auth": await authAs(who), "@/lib/tenant": await import("../../lib/tenant"), "@/lib/db": await import("../../lib/db"),
    "@/lib/shares": await import("../../lib/shares"), "@/lib/security/review-link": await import("../../lib/security/review-link"),
  });
  const body = await (await team.GET(scoped(who, `${ORIGIN}/api/review-links?projectId=prod_one`), undefined as never)).json();
  expect(body.canManage).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(/rv_[A-Za-z0-9_-]{20}/);
  expect(body.said.length).toBeGreaterThan(0);
  void B;
});

/* ── The second review's lows (L-A, L-C, L-D) ────────────────────────────────────────────────────────────────── */

test("L-C: a review link's client key is salted like the login source key, so it can't be reversed by trying every address", async () => {
  const { createHash } = await import("node:crypto");
  const link = await import("../../lib/security/review-link");
  const req = { headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }) };
  const unsalted = createHash("sha256").update("shr_one:203.0.113.7").digest("hex").slice(0, 24);
  const saved = { session: process.env.SESSION_SECRET, turso: process.env.TURSO_AUTH_TOKEN, vercel: process.env.VERCEL };
  const put = (name: "SESSION_SECRET" | "TURSO_AUTH_TOKEN" | "VERCEL", value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  try {
    /* Vercel's request shape, where the first forwarded entry is the client (lib/clientIp.ts). */
    put("VERCEL", "1");
    put("SESSION_SECRET", "unit-salt-one");
    const one = link.clientKey(req, "shr_one");
    expect(one).not.toBe(unsalted);
    expect(one).toBe(createHash("sha256").update("unit-salt-one:review-link:shr_one:203.0.113.7").digest("hex").slice(0, 24));
    expect(link.clientKey(req, "shr_one")).toBe(one);
    expect(link.clientKey(req, "shr_two")).not.toBe(one);
    put("SESSION_SECRET", "unit-salt-two");
    expect(link.clientKey(req, "shr_one")).not.toBe(one);
    /* The same fallback as sourceKey: the database token, then a constant. */
    put("SESSION_SECRET", undefined); put("TURSO_AUTH_TOKEN", "unit-turso");
    expect(link.clientKey(req, "shr_one")).toBe(createHash("sha256").update("unit-turso:review-link:shr_one:203.0.113.7").digest("hex").slice(0, 24));
    put("TURSO_AUTH_TOKEN", undefined);
    expect(link.clientKey(req, "shr_one")).toBe(createHash("sha256").update("particl:review-link:shr_one:203.0.113.7").digest("hex").slice(0, 24));
  } finally {
    put("SESSION_SECRET", saved.session); put("TURSO_AUTH_TOKEN", saved.turso); put("VERCEL", saved.vercel);
  }
});

test("L-D: a chunked recording with no Content-Length is stopped at 4 MB as it arrives, never read in full", async () => {
  const consent = await import("../../lib/security/consent");
  const MB = 1024 * 1024;
  const post = async (chunks: Uint8Array[]) => {
    let reads = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { const chunk = chunks[reads++]; if (chunk) controller.enqueue(chunk); else controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const who = member();
    const route = load<typeof import("../../app/api/identity-consents/recording/route")>("app/api/identity-consents/recording/route.ts", {
      "@/lib/auth": await authAs(who), "@/lib/security/consent": consent,
      "@/lib/security/consent-words": await import("../../lib/security/consent-words"), "@/lib/security/people-only": await import("../../lib/security/people-only"),
      "@/lib/requestBody": await import("../../lib/requestBody"),
    });
    const req = scoped(who, `${ORIGIN}/api/identity-consents/recording`, { method: "POST", body: stream, headers: { "content-type": "audio/wav" }, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await route.POST(req, undefined as never);
    return { res, reads, cancelled };
  };
  const over = await post(Array.from({ length: 12 }, () => new Uint8Array(MB)));
  expect(over.res.status).toBe(413);
  expect((await over.res.json()).error).toMatch(/under 4 MB/);
  /* Four chunks are exactly the limit; the fifth crosses it and nothing after it is pulled. */
  expect(over.reads).toBe(5);
  expect(over.cancelled).toBe(true);
  const fine = await post([new TextEncoder().encode("RIFF0000"), new TextEncoder().encode("WAVEfmt ")]);
  expect(fine.res.status).toBe(201);
  expect((await fine.res.json()).recording.id).toMatch(/\S/);
});
