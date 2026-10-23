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
  const record = { id: "c1", projectId: "p", subjectKey: "s", subjectLabel: "Lead", personName: "A Person", face: true, voice: true, uses: ["production", "ads", "social"] as const, otherUse: "", untilAt: endOfDay("2027-09-30")!, attested: true, hasRecording: true, recordingUrl: null, recordedAt: at, recordedBy: "You", mine: true, revokedAt: null, identityId: null };
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
  const { identityCardView, billedWords, ownLiveTicks } = await import("../../lib/security/identity-card");
  const live = { id: "c1", projectId: "p", subjectKey: "lead", subjectLabel: "Lead", personName: "A Person", face: true, voice: false, uses: ["production" as const, "identity" as const], otherUse: "", untilAt: Date.now() + DAY as number | null, attested: true, hasRecording: true, recordingUrl: null, recordedAt: Date.now(), recordedBy: "You", mine: true, revokedAt: null, identityId: null };
  /* Each person's box is their own: a teammate's live tick is not theirs to untick, and a withdrawn one is not live. */
  const theirs = { ...live, id: "c2", recordedBy: "Teammate", mine: false, recordedAt: Date.now() + 1 };
  expect(ownLiveTicks([live, theirs], "lead").map((r) => r.id)).toEqual(["c1"]);
  expect(ownLiveTicks([theirs], "lead")).toEqual([]);
  expect(ownLiveTicks([{ ...live, revokedAt: Date.now() }, theirs], "lead")).toEqual([]);
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
  /* A training sent from this card whose reply wasn't read here: Recover, never Train; an identity on file wins. */
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: null, identities: [], requestSaved: true })).toMatchObject({ stage: "sent", text: "Training sent · reply not read yet" });
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: identity("training", null), identities: [], requestSaved: true }).stage).toBe("training");
  expect(identityCardView({ consents: [], subjectKey: "lead", bound: null, identities: [], requestSaved: true, readFailed: true }).stage).toBe("unread");
  /* An uncertain submission needs review: no Retry and no Train until it is reconciled (the card offers neither). */
  expect(identityCardView({ consents: [started], subjectKey: "lead", bound: null, identities: [{ ...identity("failed", null), status: "uncertain" as const }] })).toMatchObject({ stage: "review", text: "Training needs review", billed: "Charge not confirmed yet" });
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
    expect((await consent.getConsent(made.id, "member"))).toEqual(made);
    expect(made.mine).toBe(true);
    expect((await consent.getConsent(made.id, "other"))?.mine).toBe(false);
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

test("details merge into the live tick in place (its who and when stay the ticker's; its file is never dropped; every edit is audited); unticking withdraws it; a teammate may tick beside it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const consent = await import("../../lib/security/consent");
  const { PeopleOnlyError } = await import("../../lib/security/people-only");
  await seedPeople(A, [{ id: "member", name: "Member" }, { id: "other", name: "Other member" }, { id: "owner", name: "You" }]);
  await upload(A, "upl_voice", "audio/webm");
  await upload(A, "upl_other_file", "audio/webm", "other");
  await runInTenant(A, async () => {
    const tick = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-edit" }, { user: { id: "member" } }, 1_000);
    /* Rule 11 and who may edit: never a token or an agent; not another member; the ticker, or an admin. */
    await expect(consent.updateConsent(tick.id, draft(), { user: { id: "agent:run_1", role: "admin" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(consent.updateConsent(tick.id, draft(), { user: { id: "member" }, token: { scope: "render" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(consent.updateConsent(tick.id, draft(), { user: { id: "other", role: "member" } })).rejects.toThrow(/admin/);
    /* The details land on the same tick; who ticked and when are unchanged. */
    const edited = await consent.updateConsent(tick.id, draft({ subjectKey: "ignored", projectId: "ignored" }), { user: { id: "member" } });
    expect(edited).toMatchObject({ id: tick.id, subjectKey: "node-edit", projectId: "prod_one", recordedBy: "Member", recordedAt: 1_000, personName: "A Person", face: true, voice: true, attested: true, hasRecording: true });
    /* It merges: an admin who sends only a name and the attest box changes only those; what was there stays. It is
       still the ticker's tick. */
    const byAdmin = await consent.updateConsent(tick.id, { personName: "A Person, by release", attested: true }, { user: { id: "owner", role: "admin", owner: true } });
    expect(byAdmin).toMatchObject({ id: tick.id, recordedBy: "Member", recordedAt: 1_000, personName: "A Person, by release", attested: true, hasRecording: true, face: true, voice: true, uses: ["production", "identity", "ads"] });
    expect(byAdmin.untilAt).toBe(edited.untilAt);
    /* The file is never dropped: an empty file id leaves it attached, and another file is refused. */
    expect(await consent.updateConsent(tick.id, { recordingId: "" }, { user: { id: "member" } })).toMatchObject({ hasRecording: true });
    await expect(consent.updateConsent(tick.id, { recordingId: "upl_other_file" }, { user: { id: "member" } })).rejects.toThrow(/already has its file/);
    expect((await consent.listConsents("prod_one", "node-edit"))).toHaveLength(1);
    /* Every edit is audited with who made it and when. */
    const audit = await db().execute({ sql: "SELECT action, actor_id, created_at FROM security_audit WHERE target_id = ? ORDER BY created_at, rowid", args: [tick.id] });
    expect(audit.rows.map((r) => [r.action, r.actor_id])).toEqual([
      ["identity_consent.recorded", "member"], ["identity_consent.updated", "member"], ["identity_consent.updated", "owner"], ["identity_consent.updated", "member"],
    ]);
    for (const r of audit.rows.slice(1)) expect(Number(r.created_at)).toBeGreaterThan(1_000);
    /* A tick with no file may be given one, which has to be this person's own recording. */
    const bareOther = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-file" }, { user: { id: "member" } });
    await expect(consent.updateConsent(bareOther.id, { recordingId: "upl_other_file" }, { user: { id: "member" } })).rejects.toThrow(/recording you made/);
    expect(await consent.updateConsent(bareOther.id, { recordingId: "upl_voice" }, { user: { id: "member" } })).toMatchObject({ hasRecording: true });
    /* A teammate may tick beside a live tick that isn't theirs: their own, a second live tick. */
    const beside = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-edit" }, { user: { id: "other" } });
    const both = await consent.listConsents("prod_one", "node-edit", "other");
    expect(both.filter((r) => r.revokedAt == null).map((r) => [r.id, r.mine])).toEqual([[beside.id, true], [tick.id, false]]);
    await consent.withdrawConsent(beside.id, { user: { id: "other" } });
    /* Unticking withdraws it; then the details can't be edited, and a new tick may be made. */
    expect(await consent.withdrawConsent(tick.id, { user: { id: "member" } })).toBe(true);
    await expect(consent.updateConsent(tick.id, draft(), { user: { id: "member" } })).rejects.toThrow(/no longer live/);
    const again = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-edit" }, { user: { id: "other" } });
    expect(again).toMatchObject({ recordedBy: "Other member", revokedAt: null });
    expect(again.id).not.toBe(tick.id);
  });
});

test("a training cites a live tick of this production and cast member when it has one; it is never refused for want of one, only for a malformed citation", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const consent = await import("../../lib/security/consent");
  await seedPeople(A, [{ id: "member", name: "Member" }]);
  await seedPeople(B, [{ id: "member", name: "Member" }]);
  await upload(A, "upl_voice", "audio/webm");
  await runInTenant(A, async () => {
    const live = await consent.recordConsent(draft({ subjectKey: "node-two" }), { user: { id: "member" } });
    expect(await consent.consentForTraining(live.id, ["draft_x", "prod_one"], "node-two")).toMatchObject({ id: live.id, tickedById: "member", recordedBy: "Member", recordedAt: live.recordedAt });
    /* No tick, or one no longer live: cites nothing, and the training proceeds (owner, 23 Oct 2026: a tick, not a gate). */
    expect(await consent.consentForTraining(undefined, ["prod_one"], "node-two")).toBeNull();
    expect(await consent.consentForTraining(undefined, [], undefined)).toBeNull();
    expect(await consent.consentForTraining(live.id, ["prod_one"], "node-two", Date.now() + 400 * DAY)).toBeNull();
    /* What a tick covers is a note, never a condition: a voice-only tick, or a bare one, is cited all the same. */
    const voice = await consent.recordConsent(draft({ subjectKey: "node-three", face: false }), { user: { id: "member" } });
    expect((await consent.consentForTraining(voice.id, ["prod_one"], "node-three"))?.id).toBe(voice.id);
    const bare = await consent.recordConsent({ projectId: "prod_one", subjectKey: "node-four" }, { user: { id: "member" } });
    expect((await consent.consentForTraining(bare.id, ["prod_one"], "node-four"))?.id).toBe(bare.id);
    /* A malformed citation is still refused, in words (review of #558, M1). */
    await expect(consent.consentForTraining(live.id, ["draft_x", "prod_other"], "node-two")).rejects.toThrow(/another production/);
    await expect(consent.consentForTraining(live.id, ["prod_one"], "node-other")).rejects.toThrow(/another cast member/);
    await expect(consent.consentForTraining(live.id, [], "node-two")).rejects.toThrow(/production/);
    await expect(consent.consentForTraining("cns_nope", ["prod_one"], "node-two")).rejects.toThrow(/not in this workspace/);
    await consent.withdrawConsent(live.id, { user: { id: "member", role: "member" } });
    expect(await consent.consentForTraining(live.id, ["prod_one"], "node-two")).toBeNull();
  });
  /* A tick id from workspace A means nothing in workspace B. */
  const [{ id }] = await runInTenant(A, () => consent.listConsents("prod_one", "node-three"));
  await runInTenant(B, async () => { await expect(consent.consentForTraining(id, ["prod_one"], "node-three")).rejects.toThrow(/not in this workspace/); });
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
  expect((await listed.json()).consents.map((c: { id: string; mine: boolean }) => [c.id, c.mine])).toEqual([[consent.id, true]]);

  for (const t of tokens) {
    Object.assign(who, { mode: "token", bearer: t.raw });
    const write = await route.POST(scoped(who, "http://localhost/api/identity-consents", { method: "POST", body: JSON.stringify(draft({ subjectKey: `node-${t.scope}` })) }), undefined as never);
    expect(write.status, `${t.scope} token records`).toBe(403);
    const read = await route.GET(scoped(who, "http://localhost/api/identity-consents?projectId=prod_one"), undefined as never);
    expect(read.status, `${t.scope} token reads`).toBe(403);
    expect(JSON.stringify(await read.json())).not.toContain("A Person");
    const gone = await one.DELETE(scoped(who, `http://localhost/api/identity-consents/${consent.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: consent.id }) });
    expect(gone.status, `${t.scope} token withdraws`).toBe(403);
    const edit = await one.PATCH(scoped(who, `http://localhost/api/identity-consents/${consent.id}`, { method: "PATCH", body: JSON.stringify({ personName: "Changed by a token" }) }), { params: Promise.resolve({ id: consent.id }) });
    expect(edit.status, `${t.scope} token edits`).toBe(403);
  }
  Object.assign(who, { mode: "session" });
  const kept = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(consent.id)));
  expect(kept?.personName).toBe("A Person");
  const byPerson = await one.PATCH(scoped(who, `http://localhost/api/identity-consents/${consent.id}`, { method: "PATCH", body: JSON.stringify({ personName: "A Person, by release" }) }), { params: Promise.resolve({ id: consent.id }) });
  expect(byPerson.status).toBe(200);
  expect((await byPerson.json()).consent).toMatchObject({ personName: "A Person, by release", recordedBy: "Member", mine: true });
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

  /* A live tick is cited and linked to the identity it started. A ticks; B presses: the tick stays A's, and the press
     never re-records it as B's (no `consent: true` is put on B's training). */
  await seedPeople(A, [{ id: "member", name: "Member" }, { id: "other", name: "Other member" }], tokens);
  const live = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.recordConsent(draft({ subjectKey: "node-train" }), { user: { id: "member" } })));
  Object.assign(who, { userId: "other", name: "Other member" });
  const ok = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consentId: live.id, consent: undefined }) }), undefined as never);
  expect(ok.status).toBe(202);
  expect(sent).toHaveLength(2);
  expect(sent[1].consent).toBeUndefined();
  const linked = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(live.id)));
  expect(linked).toMatchObject({ identityId: "soul_new_2", recordedBy: "Member", recordedAt: live.recordedAt });
  Object.assign(who, { userId: "member", name: "Member" });

  /* A withdrawn tick is not cited, and the training proceeds all the same; a malformed citation is refused, unsent. */
  await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.withdrawConsent(live.id, { user: { id: "member" } })));
  const withdrawn = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ consentId: live.id, consent: undefined }) }), undefined as never);
  expect(withdrawn.status).toBe(202);
  expect(sent).toHaveLength(3);
  expect(sent[2].consent).toBeUndefined();
  for (const [over, status] of [[{ consentId: live.id, projectId: "prod_other" }, 409], [{ consentId: "cns_nope" }, 404]] as const) {
    const res = await route.POST(scoped(who, "http://localhost/api/soul/identities", { method: "POST", body: body({ ...over, consent: undefined }) }), undefined as never);
    expect(res.status, JSON.stringify(over)).toBe(status);
  }
  expect(sent).toHaveLength(3);
  const after = await import("../../lib/tenant").then(({ runInTenant }) => runInTenant(A, () => consentLib.getConsent(live.id)));
  expect(after?.identityId).toBe("soul_new_2");
});
