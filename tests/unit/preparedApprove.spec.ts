import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * "Approve at N cr" on prepared jobs (owner, 16 Oct 2026). A prepared job's approval is claimed first, so two people cannot both start it; the take it
 * started is recorded only if it is the approving person's own; a claim that started nothing is let go (by the person, or by time). Only a person's session
 * can do any of it: a token, even a prepare token, is refused at the route. The price is never stored. Local temporary databases; nothing is sent to an engine.
 */
const dir = freshDatabases("prepared-approve");
const A = workspace(dir, "ws_preparedapprove");
const TOK = rawToken(A, "7");
const owner = (): Who => ({ mode: "session", ws: A, userId: "owner", name: "Owner", role: "owner", bearer: "" });
const asToken = (): Who => ({ mode: "token", ws: A, userId: "owner", name: "Owner", role: "owner", bearer: TOK });
const SHOT = { prompt: "A slow push on a quiet street at dawn", duration: 5, resolution: "1080p", ratio: "16:9", model: "2.5" };
test.describe.configure({ mode: "serial" });

async function inA<T>(fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(A, fn);
}
async function file(): Promise<string> {
  const lib = await import("../../lib/security/prepared-jobs");
  return (await inA(() => lib.prepareJob(SHOT, { id: "tok_prep", scope: "prepare" }))).id;
}
async function take(id: string, by: string) {
  const { db, ready } = await import("../../lib/db");
  await inA(async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", args: [id, "video", "m", "p", "{}", "queued", by, 1, 1] });
  });
}
const state = async (id: string) => (await inA(async () => (await (await import("../../lib/security/prepared-jobs")).preparedJobs({ id }))[0]));

test.beforeAll(async () => { await seedPeople(A, [{ id: "owner", name: "Owner" }, { id: "second", name: "Second" }], [{ id: "tok_prep", userId: "owner", scope: "prepare", raw: TOK }]); });

test("the approval is claimed first: one person wins, the take is recorded only if it is theirs, and a claim that started nothing is let go", async () => {
  const lib = await import("../../lib/security/prepared-jobs");
  const { APPROVAL_CLAIM_MS } = await import("../../lib/security/prepared-words");
  const id = await file();
  const decide = (state_: string, who: string, extra?: { at?: number; takeId?: unknown }) => inA(() => lib.decidePrepared(id, state_, who, extra?.at, extra?.takeId));
  /* Claimed once; a second person cannot claim it while the first holds it. */
  expect(await decide("approved", "owner")).toBe(true);
  expect(await decide("approved", "second")).toBe(false);
  expect((await state(id)).state).toBe("approved");
  /* It is not dismissed or opened from under the claim. */
  expect(await decide("dismissed", "second")).toBe(false);
  expect(await decide("opened", "second")).toBe(false);
  /* The take must exist and be the claimer's own. */
  await take("gen_other", "second");
  await expect(decide("approved", "owner", { takeId: "gen_other" })).rejects.toThrow(/not yours/);
  await expect(decide("approved", "owner", { takeId: "../x" })).rejects.toThrow(/Which take/);
  await expect(decide("approved", "owner", { takeId: "gen_missing" })).rejects.toThrow(/not yours/);
  /* Let go by the claimer only, and only while nothing has started. */
  expect(await decide("waiting", "second")).toBe(false);
  expect(await decide("waiting", "owner")).toBe(true);
  expect((await state(id)).state).toBe("waiting");
  /* Claimed again, finished with the person's own take; then it is done: not released, not claimed, not dismissed. */
  expect(await decide("approved", "owner")).toBe(true);
  await take("gen_mine", "owner");
  expect(await decide("approved", "owner", { takeId: "gen_mine" })).toBe(true);
  expect(await state(id)).toMatchObject({ state: "approved", takeId: "gen_mine" });
  expect(await decide("waiting", "owner")).toBe(false);
  expect(await decide("approved", "second")).toBe(false);
  expect(await decide("dismissed", "owner")).toBe(false);
  expect(await decide("approved", "owner", { takeId: "gen_mine" })).toBe(false);
  /* It no longer waits for anyone. */
  expect((await inA(() => lib.preparedJobs({ state: "waiting" }))).map((j) => j.id)).not.toContain(id);

  /* A claim left with no take (a closed tab) is let go after a few minutes: it waits again, and another person may claim it. */
  const stale = await file();
  const t0 = 1_000_000_000_000;
  expect(await inA(() => lib.decidePrepared(stale, "approved", "owner", t0))).toBe(true);
  const waiting = (at: number) => inA(async () => { const real = Date.now; Date.now = () => at; try { return (await lib.preparedJobs({ state: "waiting" })).map((j) => j.id); } finally { Date.now = real; } });
  expect(await waiting(t0 + APPROVAL_CLAIM_MS - 1)).not.toContain(stale);
  expect(await waiting(t0 + APPROVAL_CLAIM_MS + 1)).toContain(stale);
  expect(await inA(() => lib.decidePrepared(stale, "approved", "second", t0 + 1000))).toBe(false);
  expect(await inA(() => lib.decidePrepared(stale, "approved", "second", t0 + APPROVAL_CLAIM_MS + 1))).toBe(true);
  /* Any other word is refused in words. */
  await expect(inA(() => lib.decidePrepared(stale, "paid", "owner"))).rejects.toThrow(/Approve it, open it in Make, or dismiss it/);
});

test("only a person's session can approve, claim or release: a token, even one made to prepare, is refused at the route, and the task list of opt-in routes is unchanged", async () => {
  const id = await file();
  const person = owner();
  const auth = await authAs(person);
  const lib = await import("../../lib/security/prepared-jobs");
  const route = load<typeof import("../../app/api/prepared-jobs/[id]/route")>("app/api/prepared-jobs/[id]/route.ts", { "@/lib/auth": auth, "@/lib/security/prepared-jobs": lib });
  const patch = (who: Who, body: unknown) => route.PATCH(scoped(who, `http://localhost/api/prepared-jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const tokenAuth = await authAs(asToken());
  const tokenRoute = load<typeof import("../../app/api/prepared-jobs/[id]/route")>("app/api/prepared-jobs/[id]/route.ts", { "@/lib/auth": tokenAuth, "@/lib/security/prepared-jobs": lib });
  for (const body of [{ state: "approved" }, { state: "approved", takeId: "gen_x" }, { state: "waiting" }]) {
    const res = await tokenRoute.PATCH(scoped(asToken(), `http://localhost/api/prepared-jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    expect(res.status, JSON.stringify(body)).toBe(403);
  }
  expect((await state(id)).state).toBe("waiting");
  /* A person's claim, through the route. */
  expect(await (await patch(person, { state: "approved" })).json()).toEqual({ ok: true });
  expect(await (await patch(person, { state: "approved" })).json()).toEqual({ ok: false });
  expect(await (await patch(person, { state: "waiting" })).json()).toEqual({ ok: true });
  expect((await patch(person, { state: "nonsense" })).status).toBe(400);
  /* The route opts in to nothing for tokens: the closed list is exactly as the token spec holds it. */
  const source = readFileSync("app/api/prepared-jobs/[id]/route.ts", "utf8");
  expect(source).toContain("requireSession");
  expect(source).not.toMatch(/preparedJobs: *true|mcpTransport: *true/);
});

test("the price is never stored with a prepared job: the job holds words and settings, not a figure", async () => {
  const id = await file();
  const { db } = await import("../../lib/db");
  const row = (await inA(() => db().execute({ sql: "SELECT * FROM prepared_jobs WHERE id = ?", args: [id] }))).rows[0];
  expect(Object.keys(row).filter((k) => /price|credit|cost|usd|quote/i.test(k))).toEqual([]);
  expect(String(row.settings_json)).not.toMatch(/credit|cost|price|usd|quote/i);
  const words = readFileSync("lib/security/prepared-words.ts", "utf8");
  expect(words).toContain("The price is never in it: the server quotes it.");
});
