import { test, expect } from "@playwright/test";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * Lane 5 · Identity consent (Gaps A). A TICK, NOT A GATE (owner, 23 Oct 2026, 13:15 IST): a record is a person's tick
 * (who ticked, when, an optional file); the consent-words fields are optional, and nothing refuses for want of any of
 * it. A tick is a person's: the routes refuse every API and MCP token (read, prepare and render alike), the library
 * refuses Atomik's `agent:` identities and disabled people, ticks are filed per workspace database and per
 * production, they are withdrawn (marked) and never erased, and a training cites a live tick when it has one and
 * trains all the same when it has none. Neutral names only.
 */
const dir = freshDatabases("consent");
const A = workspace(dir, "ws_consenta"), B = workspace(dir, "ws_consentb");
const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** A consent recording row (its own table, never an upload: review of #558, M2), made by `by`. */
async function upload(ws: typeof A, id: string, mime: string, by = "member") {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { consentsReady } = await import("../../lib/security/consent");
  await runInTenant(ws, async () => {
    await consentsReady();
    await db().execute({ sql: "INSERT OR IGNORE INTO consent_recordings(id,mime,ext,bytes,sha256,stored_url,created_by,created_at) VALUES(?,?,'webm',1,'x','local',?,0)", args: [id, mime, by] });
  });
}

const draft = (over: Record<string, unknown> = {}) => ({
  projectId: "prod_one", subjectKey: "node-lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: true,
  uses: ["production", "identity", "ads"], otherUse: "", until: future(365), recordingId: "upl_voice", attested: true, ...over,
});

test("the pure rules: a tick needs only what it is for; every other field is optional; how it reads, and when it holds", async () => {
  const { cleanConsent, consentSummary, consentLive, endOfDay, ConsentError } = await import("../../lib/security/consent-words");
  const at = Date.UTC(2026, 9, 6, 12);
  expect(cleanConsent(draft({ until: "2027-09-30" }), at)).toMatchObject({ personName: "A Person", face: true, voice: true, uses: ["production", "identity", "ads"], untilAt: endOfDay("2027-09-30"), recordingId: "upl_voice", attested: true });
  /* A bare tick: nothing but the production and the cast member. Every consent-words field is empty, and none refuses. */
  expect(cleanConsent({ projectId: "prod_one", subjectKey: "node-lead" }, at)).toEqual({
    projectId: "prod_one", subjectKey: "node-lead", subjectLabel: "", personName: "", face: false, voice: false, uses: [], otherUse: "", untilAt: null, recordingId: "", attested: false,
  });
  /* What used to refuse (owner, 23 Oct 2026: never required to proceed) now cleans to an empty field. */
  for (const over of [{ personName: " " }, { face: false, voice: false }, { uses: [], otherUse: "" }, { recordingId: "" }, { attested: false }, { uses: ["everything"], otherUse: "" }, { attested: "yes" }, { until: "" }, { until: undefined }]) {
    expect(() => cleanConsent(draft(over), at), JSON.stringify(over)).not.toThrow();
  }
  expect(cleanConsent(draft({ attested: "yes" }), at).attested).toBe(false);
  /* A field that is given has to make sense, and the tick has to say what it is for. */
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ until: "2026-10-01" }, /future/], [{ until: "2040-01-01" }, /ten years/], [{ until: "2027-02-30" }, /real day/],
    [{ projectId: "../x" }, /production/], [{ subjectKey: "" }, /cast member/], [{ recordingId: "../x" }, /could not be found/],
  ];
  for (const [over, words] of refusals) expect(() => cleanConsent(draft(over), at), JSON.stringify(over)).toThrow(words);
  expect(() => cleanConsent(draft({ until: "2026-10-01" }), at)).toThrow(ConsentError);
  const record = { id: "c1", projectId: "p", subjectKey: "s", subjectLabel: "Lead", personName: "A Person", face: true, voice: true, uses: ["production", "ads", "social"] as const, otherUse: "", untilAt: endOfDay("2027-09-30")!, attested: true, hasRecording: true, recordingUrl: null, recordedAt: at, recordedBy: "You", revokedAt: null, identityId: null };
  expect(consentSummary({ ...record, uses: [...record.uses] }, at)).toBe("Face and voice · this production, ads, social posts · until 30 Sep 2027 · ticked 6 Oct 2026 by You");
  expect(consentSummary({ ...record, uses: [...record.uses], revokedAt: at }, at)).toBe("Consent withdrawn 6 Oct 2026");
  /* A bare tick says who ticked and when, and nothing it was not told. */
  const bare = { ...record, personName: "", face: false, voice: false, uses: [], untilAt: null, attested: false, hasRecording: false };
  expect(consentSummary(bare, at)).toBe("Ticked 6 Oct 2026 by You");
  expect(consentLive({ revokedAt: null, untilAt: at - 1 }, at)).toBe(false);
  /* With no end date it holds until it is withdrawn. */
  expect(consentLive({ revokedAt: null, untilAt: null }, at + 3_000 * DAY)).toBe(true);
  expect(consentLive({ revokedAt: at, untilAt: null }, at)).toBe(false);
});

test("the Cast card's states come from the records: not ticked, ticked, training, ready, failed and what was billed", async () => {
  const { identityCardView, billedWords } = await import("../../lib/security/identity-card");
  const live = { id: "c1", projectId: "p", subjectKey: "lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: false, uses: ["production" as const, "identity" as const], otherUse: "", untilAt: Date.now() + DAY as number | null, attested: true, hasRecording: true, recordingUrl: null, recordedAt: Date.now(), recordedBy: "You", revokedAt: null, identityId: null };
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "no-consent", text: "No identity yet", consentId: null, consent: "Not ticked. Only a person ticks it." });
  /* Another cast member's tick says nothing about this one. */
  expect(identityCardView({ consents: [{ ...live, subjectKey: "other" }], subjectKey: "lead", bound: null, identities: [] }).stage).toBe("no-consent");
  expect(identityCardView({ consents: [{ ...live, revokedAt: Date.now() }], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "no-consent", consentId: null });
  expect(identityCardView({ consents: [live], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "recorded", consentId: "c1", text: "Consent ticked · ready to train" });
  /* A tick, not a gate (owner, 23 Oct 2026): what a live tick covers and allows are notes, never a condition, so any live tick is cited. */
  expect(identityCardView({ consents: [{ ...live, uses: ["ads"] }], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "recorded", consentId: "c1" });
  expect(identityCardView({ consents: [{ ...live, face: false, voice: true }], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ consentId: "c1" });
  expect(identityCardView({ consents: [{ ...live, personName: "", face: false, uses: [], untilAt: null, attested: false, hasRecording: false }], subjectKey: "lead", bound: null, identities: [] })).toMatchObject({ stage: "recorded", consentId: "c1", consent: expect.stringMatching(/^Ticked \d{1,2} \w{3} \d{4} by You$/) });
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
  await upload(A, "upl_still", "audio/webm", "other");
  await runInTenant(A, async () => {
    for (const caller of [
      { user: { id: "member" }, token: { id: "tok", scope: "render" } },
      { user: { id: "member" }, token: { id: "tok", scope: "prepare" } },
      { user: { id: "agent:run_1" } },
      { user: { id: "member", disabled: true } },
      { user: null },
    ]) {
      await expect(consent.recordConsent(draft(), caller as never), JSON.stringify(caller)).rejects.toBeInstanceOf(PeopleOnlyError);
      /* Rule 11: a bare tick from a token, an MCP client or an agent is refused just the same; it never reads as a person's. */
      await expect(consent.recordConsent({ projectId: "prod_one", subjectKey: "node-lead" }, caller as never), `bare ${JSON.stringify(caller)}`).rejects.toBeInstanceOf(PeopleOnlyError);
    }
    await consent.consentsReady();
    expect((await db().execute("SELECT COUNT(*) AS n FROM identity_consents")).rows[0].n).toBe(0);

    /* A person's bare tick: who ticked and when, and nothing else; no file, no end date, no fields. */
    const before = Date.now();
    const bare = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-bare" }, { user: { id: "member" } });
    expect(bare).toMatchObject({ subjectKey: "node-bare", recordedBy: "Member", personName: "", face: false, voice: false, uses: [], otherUse: "", untilAt: null, attested: false, hasRecording: false, recordingUrl: null, revokedAt: null });
    expect(bare.recordedAt).toBeGreaterThanOrEqual(before);
    expect(bare.recordedAt).toBeLessThanOrEqual(Date.now());
    const stored = (await db().execute({ sql: "SELECT recorded_by, attested, until_at, recording_id FROM identity_consents WHERE id = ?", args: [bare.id] })).rows[0];
    expect({ by: stored.recorded_by, attested: Number(stored.attested), until: Number(stored.until_at), file: stored.recording_id }).toEqual({ by: "member", attested: 0, until: 0, file: "" });

    await expect(consent.recordConsent(draft({ recordingId: "upl_still" }), { user: { id: "member" } })).rejects.toThrow(/recording you made/);
    await expect(consent.recordConsent(draft({ recordingId: "upl_missing" }), { user: { id: "member" } })).rejects.toThrow(/could not be found/);
    const made = await consent.recordConsent(draft(), { user: { id: "member" } });
    /* The optional fields round-trip as given, beside who ticked and when. */
    expect(made).toMatchObject({ personName: "A Person", face: true, voice: true, uses: ["production", "identity", "ads"], otherUse: "", attested: true, recordedBy: "Member", hasRecording: true, revokedAt: null, recordingUrl: expect.stringMatching(/^\/api\/identity-consents\/cns_[a-z0-9]+\/recording$/) });
    expect(made.untilAt).toBeGreaterThan(Date.now() + 360 * DAY);
    expect((await consent.getConsent(made.id))).toEqual(made);
    const audit = await db().execute({ sql: "SELECT action, actor_id, details FROM security_audit WHERE target_id = ?", args: [made.id] });
    expect(audit.rows.map((r) => r.action)).toEqual(["identity_consent.recorded"]);
    expect(String(audit.rows[0].details)).not.toContain("A Person");

    /* Withdrawing: not by another member, not by an agent or a token; by the recorder or an admin. Marked, never deleted. */
    await expect(consent.withdrawConsent(made.id, { user: { id: "other", role: "member" } })).rejects.toThrow(/admin/);
    await expect(consent.withdrawConsent(made.id, { user: { id: "agent:run_1", role: "admin" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true }, token: { scope: "render" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    expect(await consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true } })).toBe(true);
    expect(await consent.withdrawConsent(made.id, { user: { id: "owner", role: "admin", owner: true } })).toBe(false);
    const kept = (await consent.listConsents("prod_one")).filter((c) => c.id === made.id);
    expect(kept).toHaveLength(1);
    expect(kept[0].revokedAt).not.toBeNull();
  });
  /* Another workspace's database holds none of it. */
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  await runInTenant(B, async () => { expect(await consent.listConsents("prod_one")).toEqual([]); });
});

test("a training cites a live tick of this production and cast member when it has one, and is never refused for want of one", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const consent = await import("../../lib/security/consent");
  await seedPeople(A, [{ id: "member", name: "Member" }]);
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  await upload(A, "upl_voice", "audio/webm");
  await runInTenant(A, async () => {
    const live = await consent.recordConsent(draft({ subjectKey: "node-two" }), { user: { id: "member" } });
    expect((await consent.consentTick(live.id, ["draft_x", "prod_one"], "node-two"))?.id).toBe(live.id);
    /* What doesn't fit is simply not cited: never a refusal. */
    expect(await consent.consentTick(live.id, ["draft_x", "prod_other"], "node-two")).toBeNull();
    expect(await consent.consentTick(live.id, ["prod_one"], "node-other")).toBeNull();
    expect(await consent.consentTick(live.id, [], "node-two")).toBeNull();
    expect(await consent.consentTick("cns_nope", ["prod_one"], "node-two")).toBeNull();
    expect(await consent.consentTick(undefined, ["prod_one"], "node-two")).toBeNull();
    expect(await consent.consentTick(live.id, ["prod_one"], "node-two", Date.now() + 400 * DAY)).toBeNull();
    /* What a tick covers is a note, never a condition: a voice-only tick, or a bare one, is cited all the same. */
    const voice = await consent.recordConsent(draft({ subjectKey: "node-three", face: false }), { user: { id: "member" } });
    expect((await consent.consentTick(voice.id, ["prod_one"], "node-three"))?.id).toBe(voice.id);
    const bare = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-four" }, { user: { id: "member" } });
    expect((await consent.consentTick(bare.id, ["prod_one"], "node-four"))?.id).toBe(bare.id);
    await consent.withdrawConsent(live.id, { user: { id: "member", role: "member" } });
    expect(await consent.consentTick(live.id, ["prod_one"], "node-two")).toBeNull();
  });
  /* A tick id from workspace A means nothing in workspace B. */
  const [{ id }] = await runInTenant(A, () => consent.listConsents("prod_one", "node-three"));
  await runInTenant(B, async () => { expect(await consent.consentTick(id, ["prod_one"], "node-three")).toBeNull(); });
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

test("identity training refuses every token and agent before anything is sent; with or without a tick a person's press trains, and a live tick is cited", async () => {
  const who = people(A);
  const auth = await authAs(who);
  const consentLib = await import("../../lib/security/consent");
  const words = await import("../../lib/security/consent-words");
  const peopleOnly = await import("../../lib/security/people-only");
  const sent: { consent?: unknown; name?: unknown }[] = [];
  class SoulIdentityError extends Error { status = 400; }
  class SpendReservationError extends Error { status = 402; }
  let made = 0;
  const route = load<typeof import("../../app/api/soul/identities/route")>("app/api/soul/identities/route.ts", {
    "@/lib/auth": auth,
    "@/lib/generationRequests": { withGenerationRequest: async (_r: Request, userId: string, fn: (claim: { userId: string }) => Promise<Response>) => fn({ userId }), SpendReservationError },
    "@/lib/soulIdentities": {
      createSoulIdentity: async (body: { consent?: unknown; name?: unknown }) => { sent.push(body); made++; return { id: `soul_new_${made}`, name: "Lead", status: "submitting" }; },
      listSoulIdentities: async () => [], syncSoulIdentity: async () => null, soulIdentityTerms: () => ({}), SoulIdentityError,
    },
    "@/lib/vendorRates": { soulCharacterGenerationEnabled: () => true },
    "@/lib/higgsfield": { higgsfieldConfigured: () => true },
    "@/lib/security/consent": consentLib, "@/lib/security/consent-words": words, "@/lib/security/people-only": peopleOnly,
  });
  const tokens = [{ id: "tok_train", userId: "member", scope: "render", raw: rawToken(A, "7") }];
  await seedPeople(A, [{ id: "member", name: "Member" }], tokens);
  await upload(A, "upl_voice", "audio/webm");
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ projectId: "prod_one", subjectKey: "node-train", name: "Lead", subjectType: "character", references: [{ uploadId: "upl_x" }], consent: true, ...over });

  /* A token, ticked or not, is refused before anything is sent: training is a person's press, and so is the tick. */
  Object.assign(who, { mode: "token", bearer: tokens[0].raw });
  for (const over of [{}, { consent: undefined }]) {
    const byToken = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body(over) }), undefined as never);
    expect(byToken.status).toBe(403);
  }
  expect(sent).toEqual([]);

  Object.assign(who, { mode: "session" });
  /* No tick at all: the person's press trains, unticked. */
  const unticked = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consent: undefined, name: "No tick" }) }), undefined as never);
  expect(unticked.status).toBe(202);
  expect(sent).toHaveLength(1);
  expect(sent[0].consent).toBeUndefined();

  /* A live tick is cited: the training carries it, and the tick is linked to the identity it started. */
  const live = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.recordConsent(draft({ subjectKey: "node-train" }), { user: { id: "member" } })));
  const ok = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consentId: live.id, consent: undefined }) }), undefined as never);
  expect(ok.status).toBe(202);
  expect(sent).toHaveLength(2);
  expect(sent[1].consent).toBe(true);
  const linked = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(live.id)));
  expect(linked?.identityId).toBe("soul_new_2");

  /* A withdrawn tick, or one for another production, is not cited, and the training proceeds all the same. */
  await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.withdrawConsent(live.id, { user: { id: "member" } })));
  for (const over of [{ consentId: live.id, consent: undefined }, { consentId: live.id, projectId: "prod_other", consent: undefined }, { consentId: "cns_nope", consent: undefined }]) {
    const res = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body(over) }), undefined as never);
    expect(res.status, JSON.stringify(over)).toBe(202);
    expect(sent[sent.length - 1].consent, JSON.stringify(over)).toBeUndefined();
  }
  expect(sent).toHaveLength(5);
  const after = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(live.id)));
  expect(after?.identityId).toBe("soul_new_2");
});
