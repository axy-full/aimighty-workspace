import { test, expect } from "@playwright/test";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * Lane 5 · Identity consent (Gaps A). A consent record is a person's: the routes refuse every API and MCP token (read,
 * prepare and render alike), the library refuses Atomik's `agent:` identities and disabled people, records are
 * filed per workspace database and per production, they are withdrawn (marked) and never erased, and training cites
 * only a live record that covers the face. Neutral names only.
 */
const dir = freshDatabases("consent");
const A = workspace(dir, "ws_consenta"), B = workspace(dir, "ws_consentb");
const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

async function upload(ws: typeof A, id: string, mime: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT OR IGNORE INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES(?,?,?,?,1,'x','local',0)", args: [id, `${id}.webm`, mime, "webm"] });
  });
}

const draft = (over: Record<string, unknown> = {}) => ({
  projectId: "prod_one", subjectKey: "node-lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: true,
  uses: ["production", "ads"], otherUse: "", until: future(365), recordingUploadId: "upl_voice", attested: true, ...over,
});

test("the pure rules: what a record needs, how it reads, and when it holds", async () => {
  const { cleanConsent, consentSummary, consentLive, endOfDay, ConsentError } = await import("../../lib/security/consent-words");
  const at = Date.UTC(2026, 9, 6, 12);
  expect(cleanConsent(draft({ until: "2027-09-30" }), at)).toMatchObject({ personName: "A Person", face: true, voice: true, uses: ["production", "ads"], untilAt: endOfDay("2027-09-30") });
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ personName: " " }, /full name/], [{ face: false, voice: false }, /what it covers/], [{ uses: [], otherUse: "" }, /at least one use/],
    [{ until: "2026-10-01" }, /future/], [{ until: "2040-01-01" }, /ten years/], [{ until: "2027-02-30" }, /last day/],
    [{ recordingUploadId: "" }, /recording/], [{ attested: false }, /Tick the statement/], [{ projectId: "../x" }, /production/],
    [{ uses: ["everything"], otherUse: "" }, /at least one use/],
  ];
  for (const [over, words] of refusals) expect(() => cleanConsent(draft(over), at), JSON.stringify(over)).toThrow(words);
  expect(() => cleanConsent(draft({ attested: "yes" }), at)).toThrow(ConsentError);
  const record = { id: "c1", projectId: "p", subjectKey: "s", subjectLabel: "Lead", personName: "A Person", face: true, voice: true, uses: ["production", "ads", "social"] as const, otherUse: "", untilAt: endOfDay("2027-09-30")!, hasRecording: true, recordingUrl: null, recordedAt: at, recordedBy: "You", revokedAt: null, identityId: null };
  expect(consentSummary({ ...record, uses: [...record.uses] }, at)).toBe("Face and voice · this production, ads, social posts · until 30 Sep 2027 · recorded 6 Oct 2026 by You");
  expect(consentSummary({ ...record, uses: [...record.uses], revokedAt: at }, at)).toBe("Consent withdrawn 6 Oct 2026");
  expect(consentLive({ revokedAt: null, untilAt: at - 1 }, at)).toBe(false);
});

test("the Cast card's states come from the records: not recorded, recorded, training, ready, failed and what was billed", async () => {
  const { identityCardView, billedWords } = await import("../../lib/security/identity-card");
  const live = { id: "c1", projectId: "p", subjectKey: "lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: false, uses: ["production" as const], otherUse: "", untilAt: Date.now() + DAY, hasRecording: true, recordingUrl: null, recordedAt: Date.now(), recordedBy: "You", revokedAt: null, identityId: null };
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "no-consent", text: "Consent not recorded", consentId: null });
  /* Another cast member's record says nothing about this one. */
  expect(identityCardView({ consents: [{ ...live, subjectKey: "other" }], subjectKey: "lead", bound: null, identities: [] }).stage).toBe("no-consent");
  expect(identityCardView({ consents: [{ ...live, revokedAt: Date.now() }], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "no-consent", consentId: null });
  expect(identityCardView({ consents: [live], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "recorded", consentId: "c1" });
  const identity = (status: "training" | "ready" | "failed", creditsBilled: number | null, error: string | null = null) => ({ id: "soul_1", name: "Lead v1", status, creditsBilled, error, createdAt: 1 });
  const started = { ...live, identityId: "soul_1" };
  expect(identityCardView({ consents: [started], subjectKey: "lead", bound: null, identities: [identity("training", null)] })).toMatchObject({ stage: "training", text: "Training" });
  expect(identityCardView({ consents: [started], subjectKey: "lead", bound: null, identities: [identity("ready", 54)] })).toMatchObject({ stage: "ready", text: "Identity ready · Lead v1" });
  /* "Nothing billed" only when the ledger shows nothing billed; a charge is named; no figure is "not confirmed". */
  expect(identityCardView({ consents: [started], subjectKey: "lead", bound: null, identities: [identity("failed", 0, "Two photos are too dark")] })).toMatchObject({ stage: "failed", billed: "Nothing billed", why: "Two photos are too dark", consentId: "c1" });
  expect(billedWords(54)).toBe("Billed 54 cr");
  expect(billedWords(null)).toBe("Charge not confirmed yet");
  /* An identity trained before records existed keeps its old line. */
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: identity("ready", 54), identities: [], earlier: "Training consent confirmed 12 Sep 2026 by You" })).toMatchObject({ stage: "ready", consent: "Training consent confirmed 12 Sep 2026 by You" });
});

test("only a person records or withdraws consent: tokens, agents and disabled people are refused; nothing is ever erased", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const consent = await import("../../lib/security/consent");
  const { PeopleOnlyError } = await import("../../lib/security/people-only");
  await seedPeople(A, [{ id: "owner", name: "You" }, { id: "member", name: "Member" }, { id: "other", name: "Other member" }]);
  await upload(A, "upl_voice", "audio/webm");
  await upload(A, "upl_still", "image/png");
  await runInTenant(A, async () => {
    for (const caller of [
      { user: { id: "member" }, token: { id: "tok", scope: "render" } },
      { user: { id: "member" }, token: { id: "tok", scope: "prepare" } },
      { user: { id: "agent:run_1" } },
      { user: { id: "member", disabled: true } },
      { user: null },
    ]) await expect(consent.recordConsent(draft(), caller as never), JSON.stringify(caller)).rejects.toBeInstanceOf(PeopleOnlyError);
    await consent.consentsReady();
    expect((await db().execute("SELECT COUNT(*) AS n FROM identity_consents")).rows[0].n).toBe(0);

    await expect(consent.recordConsent(draft({ recordingUploadId: "upl_still" }), { user: { id: "member" } })).rejects.toThrow(/sound or video/);
    await expect(consent.recordConsent(draft({ recordingUploadId: "upl_missing" }), { user: { id: "member" } })).rejects.toThrow(/could not be found/);
    const made = await consent.recordConsent(draft(), { user: { id: "member" } });
    expect(made).toMatchObject({ personName: "A Person", recordedBy: "Member", hasRecording: true, revokedAt: null, recordingUrl: "/api/uploads/upl_voice" });
    const audit = await db().execute({ sql: "SELECT action, actor_id, details FROM security_audit WHERE target_id = ?", args: [made.id] });
    expect(audit.rows.map((r) => r.action)).toEqual(["identity_consent.recorded"]);
    expect(String(audit.rows[0].details)).not.toContain("A Person");

    /* Withdrawing: not by another member, not by an agent or a token; by the recorder or an admin. Marked, never deleted. */
    await expect(consent.withdrawConsent(made.id, { user: { id: "other", role: "member" } })).rejects.toThrow(/admin/);
    await expect(consent.withdrawConsent(made.id, { user: { id: "agent:run_1", role: "admin" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true }, token: { scope: "render" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    expect(await consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true } })).toBe(true);
    expect(await consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true } })).toBe(false);
    const kept = await consent.listConsents("prod_one");
    expect(kept).toHaveLength(1);
    expect(kept[0].revokedAt).not.toBeNull();
  });
  /* Another workspace's database holds none of it. */
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  await runInTenant(B, async () => { expect(await consent.listConsents("prod_one")).toEqual([]); });
});

test("training cites only a live record of this production that covers the face", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const consent = await import("../../lib/security/consent");
  await seedPeople(A, [{ id: "member", name: "Member" }]);
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  await upload(A, "upl_voice", "audio/webm");
  await runInTenant(A, async () => {
    const live = await consent.recordConsent(draft({ subjectKey: "node-two" }), { user: { id: "member" } });
    expect((await consent.consentForTraining(live.id, ["draft_x", "prod_one"])).id).toBe(live.id);
    await expect(consent.consentForTraining(live.id, ["draft_x", "prod_other"])).rejects.toThrow(/another production/);
    await expect(consent.consentForTraining("cns_nope", ["prod_one"])).rejects.toThrow(/not in this workspace/);
    await expect(consent.consentForTraining(undefined, ["prod_one"])).rejects.toThrow(/Record the person's consent first/);
    await expect(consent.consentForTraining(live.id, ["prod_one"], Date.now() + 400 * DAY)).rejects.toThrow(/ended/);
    const voice = await consent.recordConsent(draft({ subjectKey: "node-three", face: false }), { user: { id: "member" } });
    await expect(consent.consentForTraining(voice.id, ["prod_one"])).rejects.toThrow(/voice only/);
    await consent.withdrawConsent(live.id, { user: { id: "member", role: "member" } });
    await expect(consent.consentForTraining(live.id, ["prod_one"])).rejects.toThrow(/withdrawn/);
  });
  /* A record id from workspace A means nothing in workspace B. */
  const [{ id }] = await runInTenant(A, () => consent.listConsents("prod_one", "node-three"));
  await runInTenant(B, async () => { await expect(consent.consentForTraining(id, ["prod_one"])).rejects.toThrow(/not in this workspace/); });
});

function people(ws: typeof A): Who { return { mode: "session", ws, userId: "member", name: "Member", role: "member", bearer: "" }; }

test("the consent routes answer a signed-in person only; every token is refused, reading and writing", async () => {
  const who = people(A);
  const auth = await authAs(who);
  const consentLib = await import("../../lib/security/consent");
  const words = await import("../../lib/security/consent-words");
  const peopleOnly = await import("../../lib/security/people-only");
  const deps = { "@/lib/auth": auth, "@/lib/security/consent": consentLib, "@/lib/security/consent-words": words, "@/lib/security/people-only": peopleOnly };
  const route = load<typeof import("../../app/api/identity-consents/route")>("app/api/identity-consents/route.ts", deps);
  const one = load<typeof import("../../app/api/identity-consents/[id]/route")>("app/api/identity-consents/[id]/route.ts", deps);
  const tokens = ["read", "prepare", "render"].map((scope, i) => ({ id: `tok_${scope}`, userId: "member", scope, raw: rawToken(A, String(i + 1)) }));
  await seedPeople(A, [{ id: "member", name: "Member" }], tokens);
  await upload(A, "upl_voice", "audio/webm");

  const posted = await route.POST(scoped(who, "http://localhost/api/identity-consents", { method: "POST", body: JSON.stringify(draft({ subjectKey: "node-route" })) }), undefined as never);
  expect(posted.status).toBe(201);
  const { consent } = await posted.json();
  const listed = await route.GET(scoped(who, "http://localhost/api/identity-consents?projectId=prod_one&subject=node-route"), undefined as never);
  expect((await listed.json()).consents.map((c: { id: string }) => c.id)).toEqual([consent.id]);

  for (const t of tokens) {
    Object.assign(who, { mode: "token", bearer: t.raw });
    const write = await route.POST(scoped(who, "http://localhost/api/identity-consents", { method: "POST", body: JSON.stringify(draft({ subjectKey: `node-${t.scope}` })) }), undefined as never);
    expect(write.status, `${t.scope} token records`).toBe(403);
    const read = await route.GET(scoped(who, "http://localhost/api/identity-consents?projectId=prod_one"), undefined as never);
    expect(read.status, `${t.scope} token reads`).toBe(403);
    expect(JSON.stringify(await read.json())).not.toContain("A Person");
    const gone = await one.DELETE(scoped(who, `http://localhost/api/identity-consents/${consent.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: consent.id }) });
    expect(gone.status, `${t.scope} token withdraws`).toBe(403);
  }
  Object.assign(who, { mode: "none" });
  expect((await route.GET(scoped(who, "http://localhost/api/identity-consents?projectId=prod_one"), undefined as never)).status).toBe(401);
  /* A session without the page's workspace scope header is refused a write (another tab's account). */
  Object.assign(who, { mode: "session" });
  const unscoped = await route.POST(new Request("http://localhost/api/identity-consents", { method: "POST", body: JSON.stringify(draft()), headers: { "content-type": "application/json" } }), undefined as never);
  expect(unscoped.status).toBe(409);
  /* Workspace B's person sees none of A's records. */
  Object.assign(who, { ws: B });
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  const other = await route.GET(scoped(who, "http://localhost/api/identity-consents?projectId=prod_one"), undefined as never);
  expect((await other.json()).consents).toEqual([]);
});

test("identity training refuses every token and agent before anything is sent, and cites only a live consent", async () => {
  const who = people(A);
  const auth = await authAs(who);
  const consentLib = await import("../../lib/security/consent");
  const words = await import("../../lib/security/consent-words");
  const peopleOnly = await import("../../lib/security/people-only");
  const sent: unknown[] = [];
  class SoulIdentityError extends Error { status = 400; }
  class SpendReservationError extends Error { status = 402; }
  const route = load<typeof import("../../app/api/soul/identities/route")>("app/api/soul/identities/route.ts", {
    "@/lib/auth": auth,
    "@/lib/generationRequests": { withGenerationRequest: async (_r: Request, userId: string, fn: (claim: { userId: string }) => Promise<Response>) => fn({ userId }), SpendReservationError },
    "@/lib/soulIdentities": {
      createSoulIdentity: async (body: unknown) => { sent.push(body); return { id: "soul_new", name: "Lead", status: "submitting" }; },
      listSoulIdentities: async () => [], syncSoulIdentity: async () => null, soulIdentityTerms: () => ({}), SoulIdentityError,
    },
    "@/lib/vendorRates": { soulCharacterGenerationEnabled: () => true },
    "@/lib/higgsfield": { higgsfieldConfigured: () => true },
    "@/lib/security/consent": consentLib, "@/lib/security/consent-words": words, "@/lib/security/people-only": peopleOnly,
  });
  const tokens = [{ id: "tok_train", userId: "member", scope: "render", raw: rawToken(A, "7") }];
  await seedPeople(A, [{ id: "member", name: "Member" }], tokens);
  await upload(A, "upl_voice", "audio/webm");
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ projectId: "prod_one", name: "Lead", subjectType: "character", references: [{ uploadId: "upl_x" }], consent: true, ...over });

  Object.assign(who, { mode: "token", bearer: tokens[0].raw });
  const byToken = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body() }), undefined as never);
  expect(byToken.status).toBe(403);
  expect(sent).toEqual([]);

  Object.assign(who, { mode: "session" });
  const live = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.recordConsent(draft({ subjectKey: "node-train" }), { user: { id: "member" } })));
  const ok = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consentId: live.id }) }), undefined as never);
  expect(ok.status).toBe(202);
  expect(sent).toHaveLength(1);
  const linked = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(live.id)));
  expect(linked?.identityId).toBe("soul_new");

  await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.withdrawConsent(live.id, { user: { id: "member" } })));
  const withdrawn = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consentId: live.id }) }), undefined as never);
  expect(withdrawn.status).toBe(409);
  expect(sent).toHaveLength(1);
});
