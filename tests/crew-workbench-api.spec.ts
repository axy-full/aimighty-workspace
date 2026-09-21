import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Crew through the real authenticated routes and the real meter, on a local
 * ENGINE_MOCK server (signInLocally refuses anything else). The mock room
 * answers with the prototype's canned lines, which is enough to prove the
 * orchestration, the parsing and the money: quote, approve that ceiling, one
 * streamed round, one settled event, and nothing on a refusal.
 */
type Sse = { event: string; data: Record<string, unknown> & { [key: string]: unknown } };
const parseSse = (text: string): Sse[] => text.split("\n\n").filter(Boolean).map((block) => ({
  event: /^event: (.+)$/m.exec(block)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}"),
}));

test("a room quotes first, streams propose → challenge → converge, settles once, and routes its solutions", async ({ request, playwright }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl() });
  const anonymous = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  const events = async () => (await platform.execute({ sql: "SELECT id,status,engine,model,engine_cost_usd AS usd,billed_credits AS credits FROM meter_events WHERE workspace_id=? AND engine='xai'", args: [account.workspace.id] })).rows;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 200, "Local mock crew test", "admin", "test", Date.now()] });
    const project = { ...newProject(`Crew HTTP ${randomUUID().slice(0, 8)}`), brief: "One kitchen, one rainy dawn. The bottle is never held up to camera.", script: "INT. KITCHEN - DAWN\n\nRain on the window. MEERA fills the kettle." };
    const saved = await request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);

    expect((await anonymous.get(`/api/crew/members?projectId=${project.id}`)).status()).toBe(401);
    expect((await request.get(`/api/crew/members?projectId=${project.id}`)).status(), "no scope header").toBe(409);

    const status = await request.get("/api/crew/status", { headers }).then((r) => r.json());
    expect(status).toMatchObject({ connected: true, priced: true });

    /* The first read seats the default five, the Producer in the chair. */
    const roster = (await request.get(`/api/crew/members?projectId=${project.id}`, { headers }).then((r) => r.json())).members as { id: string; name: string; isChair: boolean; active: boolean }[];
    expect(roster.map((m) => m.name)).toEqual(["Director", "DOP", "Production designer", "Editor", "Producer"]);
    expect(roster.filter((m) => m.isChair).map((m) => m.name)).toEqual(["Producer"]);
    const dup = await request.post("/api/crew/members", { headers, data: { projectId: project.id, presetId: "dop" } });
    expect(dup.status()).toBe(409);
    /* Mute the editor: four speak. */
    const editor = roster.find((m) => m.name === "Editor")!;
    expect((await request.patch("/api/crew/members", { headers, data: { id: editor.id, active: false } })).ok()).toBe(true);

    expect((await request.post("/api/crew/sessions", { headers, data: { projectId: project.id, goal: "  " } })).status()).toBe(400);
    const created = await request.post("/api/crew/sessions", { headers, data: { projectId: project.id, goal: "Open the film without dialogue and still make the product unmistakable inside the first four seconds.", context: { brief: true, script: true, boards: false, cast: false, rig: false } } });
    expect(created.ok(), await created.text()).toBe(true);
    const session = (await created.json()).session as { id: string; model: string };
    const rounds = `/api/crew/sessions/${session.id}/rounds`;

    /* The quote is read-only: 4 members → 9 requests, a whole-credit ceiling, no dollars for a credit workspace. */
    const quote = await request.post(rounds, { headers, data: { quoteOnly: true } }).then((r) => r.json());
    expect(quote).toMatchObject({ members: 4, calls: 9, model: session.model });
    expect(quote.estimateCredits).toBeGreaterThanOrEqual(1);
    expect(quote.estimateUsd).toBeUndefined();
    expect(await events()).toHaveLength(0);

    /* No price seen, or a lower one: refused before anything is reserved. */
    expect((await request.post(rounds, { headers, data: {} })).status()).toBe(409);
    expect((await request.post(rounds, { headers, data: { maxCredits: quote.estimateCredits - 1 } })).status()).toBe(409);
    expect(await events()).toHaveLength(0);

    const ran = await request.post(rounds, { headers, data: { maxCredits: quote.estimateCredits } });
    expect(ran.ok(), await ran.text()).toBe(true);
    expect(ran.headers()["content-type"]).toContain("text/event-stream");
    const stream = parseSse(await ran.text());
    expect(stream.filter((e) => e.event === "phase").map((e) => e.data.phase)).toEqual(["propose", "challenge", "converge"]);
    const messages = stream.filter((e) => e.event === "message").map((e) => e.data);
    expect(messages.filter((m) => m.phase === "propose")).toHaveLength(4);
    expect(messages.filter((m) => m.phase === "challenge")).toHaveLength(4);
    expect(messages.filter((m) => m.phase === "converge")).toHaveLength(1);
    expect(messages.some((m) => m.name === "Editor"), "a muted member does not speak").toBe(false);
    /* `@Name —` became an address, and left the text. */
    for (const m of messages.filter((x) => x.phase === "challenge")) {
      expect(String(m.to), JSON.stringify(m)).not.toBe("");
      expect(String(m.text)).not.toMatch(/^@/);
      expect(m.toMemberId, `${m.name} → ${m.to}`).toBeTruthy();
    }
    expect(messages.find((m) => m.phase === "converge")).toMatchObject({ name: "Producer", department: "Chair" });
    const solutions = stream.find((e) => e.event === "solutions")!.data as unknown as { id: string; text: string }[];
    expect(solutions).toHaveLength(3);
    expect(solutions[0].text).toMatch(/^Locked dawn frame — /);
    const done = stream.find((e) => e.event === "done")!.data;
    expect(done).toMatchObject({ round: 1, billed: true, note: null });
    expect(Number(done.spendCr)).toBeGreaterThanOrEqual(1);
    expect(Number(done.spendCr)).toBeLessThanOrEqual(quote.estimateCredits);

    /* One round is one settled event, on the xai engine, within the ceiling. */
    const settled = await events();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: "succeeded", engine: "xai", model: session.model });
    expect(Number(settled[0].credits)).toBe(Number(done.spendCr));

    /* A note is free and joins the transcript; a pin becomes a solution. */
    const note = await request.post(`/api/crew/sessions/${session.id}/notes`, { headers, data: { text: "Keep the tin out of frame." } });
    expect(note.ok(), await note.text()).toBe(true);
    const pinned = await request.post("/api/crew/solutions", { headers, data: { messageId: messages[0].id } }).then((r) => r.json());
    expect(pinned.solution).toMatchObject({ source: "pin", status: "open" });
    const room = await request.get(`/api/crew/sessions/${session.id}`, { headers }).then((r) => r.json());
    expect(room.session).toMatchObject({ roundsRun: 1, spendCr: Number(done.spendCr) });
    expect(room.messages).toHaveLength(10);
    expect(room.solutions).toHaveLength(4);

    /* → Brief appends to the saved brief; Board it adds a draft frame; Open in Gen writes nothing. */
    const route = (id: string, to: string) => request.post(`/api/crew/solutions/${id}/route`, { headers, data: { to } });
    expect(await route(solutions[0].id, "brief").then((r) => r.json())).toMatchObject({ status: "sent_to_brief" });
    expect(await route(solutions[1].id, "boards").then((r) => r.json())).toMatchObject({ status: "boarded" });
    expect(await route(solutions[2].id, "gen").then((r) => r.json())).toMatchObject({ status: "generated", prompt: solutions[2].text });
    expect((await route(solutions[2].id, "rig")).status()).toBe(400);
    const after = (await request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
    expect(after.brief).toContain(`Crew · ${solutions[0].text}`);
    expect(after.nodes.at(-1)).toMatchObject({ type: "scene", title: "Cut on the drop", status: "draft" });

    const minutes = await request.get(`/api/crew/sessions/${session.id}/minutes`, { headers });
    expect(minutes.headers()["content-type"]).toContain("text/markdown");
    const markdown = await minutes.text();
    for (const needle of ["# Crew minutes — ", "## In the room", "- Producer — Schedule & resources (chair)", "- Editor — Pacing & assembly (muted)", "### Round 1 · Challenge", "## Solutions", "1. Locked dawn frame"]) expect(markdown).toContain(needle);

    expect((await request.get(`/api/crew/sessions?projectId=${project.id}`, { headers }).then((r) => r.json())).sessions[0]).toMatchObject({ id: session.id, roundsRun: 1, solutions: 4 });
    expect(await events(), "nothing after the round cost anything").toHaveLength(1);
  } finally {
    platform.close();
    await anonymous.dispose();
  }
});
