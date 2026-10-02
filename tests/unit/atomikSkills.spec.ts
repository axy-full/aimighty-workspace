import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik skills: a run saved as a template — its steps, engines and settings,
 * with the person's words as named parameters and nothing the run made — in
 * versions that are never overwritten, archived and restored but never
 * deleted, personal or the workspace's, and run again as proposals that each
 * still wait for a quote and a person's approval. Temporary local databases;
 * nothing here calls a model or a vendor.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-skills-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-5-260628";
const KLING = "fal-ai/kling-video/v3/standard";
const KLING_PRO = "fal-ai/kling-video/v3/pro";
const NANO_PRO = "gemini-3-pro-image";

function workspace(opts: { file?: string; credits?: boolean } = {}): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${opts.file ?? id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: Boolean(opts.credits),
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "u1", createdAt: 0 } as TenantWorkspace;
}
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn);
}
async function rows(sql: string, args: (string | number | null)[] = []) {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql, args })).rows;
}

/**
 * A finished Atomik run, as a planning turn files one: a request, a reply, a
 * still that rendered, a clip still waiting, music that failed, and a step the
 * person turned down.
 */
async function seedRun(opts: { chatId?: string; projectId?: string | null; videoModel?: string; refs?: boolean } = {}) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const chatId = opts.chatId ?? `ach_${randomUUID().slice(0, 8)}`;
  const at = Date.now() - 60_000;
  const step = (id: string, position: number, kind: string, title: string, prompt: string, model: string, params: object, status: string, genId: string | null, est: number | null, refs = "[]") => ({
    sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, gen_id, est_cost_usd, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, chatId, `${chatId}_m2`, position, kind, title, prompt, model, JSON.stringify(params), refs, status, genId, est, at + 2 + position, at + 2 + position],
  });
  await db().batch([
    { sql: `INSERT INTO users(id, email, name, password_hash, role, created_at) VALUES ('u1','u1@example.test','Asha','x','admin',0), ('u2','u2@example.test','Ben','x','member',0)
            ON CONFLICT DO NOTHING`, args: [] },
    { sql: `INSERT INTO atomik_chats (id, project_id, title, model, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted)
            VALUES (?,?,?,?,?,?,?,?,?,?,0)`, args: [chatId, opts.projectId ?? null, "Wave Runner spot", "auto", "ask", "waiting", 0.0301, "u1", at, at + 10] },
    { sql: `INSERT INTO atomik_messages (id, chat_id, role, text, activity, created_at) VALUES (?,?,?,?,?,?)`,
      args: [`${chatId}_m1`, chatId, "user", "A 15 second spot for our Wave Runner sneakers on a beach at sunset, with @Maya skating.", "[]", at] },
    { sql: `INSERT INTO atomik_messages (id, chat_id, role, text, activity, cost_usd, model, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      args: [`${chatId}_m2`, chatId, "assistant", "Three shots.", "[]", 0.0301, "anthropic/claude-test", at + 1] },
    step(`${chatId}_s1`, 0, "image", "Wave Runner hero still", "Studio still of teal Wave Runner sneakers on wet sand, beach at sunset, warm backlight.", NANO_PRO,
      { ratio: "16:9", resolution: "2K", preset: "kept-nowhere" }, "done", "gen_made_1", 0.1234),
    step(`${chatId}_s2`, 1, "video", "Skate pass", "@Maya skating along a beach at sunset in teal Wave Runner sneakers, low wide tracking shot.", opts.videoModel ?? KLING_PRO,
      { ratio: "16:9", resolution: "1080p", seconds: 5 }, "proposed", null, 0.5678, opts.refs ? JSON.stringify([{ uploadId: "up_1", role: "reference_image" }]) : "[]"),
    step(`${chatId}_s3`, 2, "audio", "Surf bed", "Waves and a light synth pulse under the skate pass.", "elevenlabs", { task: "music", seconds: 30 }, "failed", null, null),
    step(`${chatId}_s4`, 3, "video", "Turned down", "A drone orbit over the beach at sunset.", SEEDANCE, { ratio: "16:9", resolution: "720p", seconds: 5 }, "rejected", null, 0.2),
  ], "write");
  return chatId;
}

const PARAMS = [
  { key: "product", label: "Product", phrase: "Wave Runner sneakers" },
  { key: "setting", label: "Setting", phrase: "beach at sunset" },
];

async function saveSkill(chatId: string, by: string, extra: Record<string, unknown> = {}) {
  const s = await import("../../lib/atomikSkills");
  return s.saveSkillFromRun({ chatId, parameters: PARAMS, name: "Wave Runner spot", description: "A hero still, a skate pass and a music bed for a product.", scope: "workspace", ...extra }, by);
}

/* ── Template extraction ─────────────────────────────────────────────── */

test("a run becomes a template: its steps, engines and settings, the person's words as named parameters, and nothing it made", async () => {
  const t = await import("../../lib/atomikSkillsText");
  const s = await import("../../lib/atomikSkills");
  await inTenant(workspace(), async () => {
    const chatId = await seedRun();
    /* The form is filled from the run: the steps a skill can keep, and what looks like the person's input. */
    const draft = await s.draftFromRun(chatId);
    expect(draft).toMatchObject({ chatId, name: "Wave Runner spot", slug: "wave-runner-spot" });
    expect(draft.steps.map((x) => [x.title, x.keep])).toEqual([["Wave Runner hero still", true], ["Skate pass", true], ["Surf bed", true]]);
    expect(draft.parameters.map((p) => p.phrase)).toEqual(expect.arrayContaining(["@Maya", "Wave Runner sneakers", "beach at sunset"]));
    expect(draft.parameters.find((p) => p.phrase === "@Maya")).toMatchObject({ key: "maya", label: "Cast" });

    const skill = await saveSkill(chatId, "u1");
    expect(skill).toMatchObject({ slug: "wave-runner-spot", name: "Wave Runner spot", scope: "workspace", status: "active", version: 1, byYou: true, byName: "Asha" });
    const { steps, parameters } = skill.template;
    expect(parameters).toEqual([
      { key: "product", label: "Product", default: "Wave Runner sneakers" },
      { key: "setting", label: "Setting", default: "beach at sunset" },
    ]);
    /* Each step keeps its kind, engine and settings; the phrases are placeholders; the turned-down step is not there. */
    expect(steps.map((x) => [x.kind, x.model])).toEqual([["image", NANO_PRO], ["video", KLING_PRO], ["audio", "elevenlabs"]]);
    expect(steps[0]).toEqual({ kind: "image", model: NANO_PRO, title: "Wave Runner hero still", params: { ratio: "16:9", resolution: "2K" },
      prompt: "Studio still of teal {{product}} on wet sand, {{setting}}, warm backlight." });
    expect(steps[1]).toMatchObject({ prompt: "@Maya skating along a {{setting}} in teal {{product}}, low wide tracking shot.", params: { ratio: "16:9", resolution: "1080p", seconds: 5 } });
    expect(steps[2]).toMatchObject({ params: { task: "music", seconds: 30 } });
    /* Nothing the run made, cost or decided is kept: no take, no estimate, no status, no stray setting. */
    const stored = String((await rows("SELECT template FROM atomik_skill_versions WHERE skill_id = ?", [skill.id]))[0].template);
    for (const output of ["gen_made_1", "0.1234", "0.5678", "0.0301", "done", "proposed", "failed", "rejected", "genId", "estCostUsd", "status", "kept-nowhere", "Turned down", "Three shots"])
      expect(stored, output).not.toContain(output);
  });

  /* The pure rules, on their own. */
  const run = [{ kind: "video", title: "Shot", prompt: "A red Wave Runner sneaker on a beach.", model: KLING, params: { seconds: 5, ratio: "16:9", resolution: "1080p" }, genId: "gen_x", estCostUsd: 1.5, status: "done" }];
  expect(() => t.templateFromRun(run, [{ key: "product", label: "Product", phrase: "blue boot" }])).toThrow(/isn't in any step/);
  expect(() => t.templateFromRun([{ ...run[0], refs: [{ uploadId: "up_1" }] }], [])).toThrow(/attached media/);
  expect(() => t.templateFromRun([{ ...run[0], model: "connected:kling3_0" }], [])).toThrow(/connected account/);
  expect(() => t.templateFromRun(run, [{ key: "Product", label: "", phrase: "red" }])).toThrow(/lower-case/);
  expect(() => t.templateFromRun(run, [{ key: "a", label: "", phrase: "red" }, { key: "a", label: "", phrase: "beach" }])).toThrow(/Two parameters/);
  /* Longest first, whole words only, never inside a word or a placeholder already made. */
  const trail = { ...run[0], prompt: "Wave Runner sneakers by Wave Runner, redwood trail." };
  const nested = t.templateFromRun([trail], [{ key: "brand", label: "Brand", phrase: "Wave Runner" }, { key: "product", label: "Product", phrase: "Wave Runner sneakers" }]);
  expect(nested.steps[0].prompt).toBe("{{product}} by {{brand}}, redwood trail.");
  expect(() => t.templateFromRun([trail], [{ key: "colour", label: "Colour", phrase: "red" }])).toThrow(/isn't in any step/);
  expect(t.fillText(nested.steps[0].prompt, { product: "{{brand}} boots", brand: "Acme" })).toBe("{{brand}} boots by Acme, redwood trail.");
  expect(t.slugOf("30s Wave Runner spot!")).toBe("skill-30s-wave-runner-spot");
});

/* ── Versions ─────────────────────────────────────────────────────────── */

test("an edit makes the next version, every earlier version stays readable, and an edit lands only on the version it was made from", async () => {
  const s = await import("../../lib/atomikSkills");
  await inTenant(workspace(), async () => {
    const skill = await saveSkill(await seedRun(), "u1");
    const v1 = JSON.stringify(skill.template);
    const template = { ...skill.template, steps: skill.template.steps.map((x, i) => (i === 0 ? { ...x, prompt: `${x.prompt} Shot on a seamless.` } : x)) };
    const v2 = await s.editSkill(skill.id, { expectedVersion: 1, name: "Wave Runner launch", note: "Seamless backdrop", template }, "u2");
    expect(v2).toMatchObject({ version: 2, name: "Wave Runner launch", slug: "wave-runner-spot", byName: "Asha", editedByName: "Ben", editedByYou: true });
    expect(v2.template.steps[0].prompt).toContain("Shot on a seamless.");

    /* Version 1 is exactly what was saved, and the list says who made each version. */
    const read = await s.getSkill(skill.id, "u1");
    expect(read.versions.map((v) => [v.version, v.name, v.note, v.byName])).toEqual([[2, "Wave Runner launch", "Seamless backdrop", "Ben"], [1, "Wave Runner spot", "Saved from a run", "Asha"]]);
    const first = await s.getSkillVersion(skill.id, 1, "u2");
    expect(JSON.stringify(first.template)).toBe(v1);
    expect(first).toMatchObject({ version: 1, name: "Wave Runner spot", byYou: false });
    await expect(s.getSkillVersion(skill.id, 3, "u1")).rejects.toMatchObject({ status: 404 });

    /* An edit made from version 1 after version 2 exists is refused; nothing changes. */
    await expect(s.editSkill(skill.id, { expectedVersion: 1, name: "Stale edit" }, "u1")).rejects.toMatchObject({ status: 409 });
    /* Saving what is already there makes no version. */
    expect((await s.editSkill(skill.id, { expectedVersion: 2, name: "Wave Runner launch" }, "u1")).version).toBe(2);
    expect((await rows("SELECT COUNT(*) AS n FROM atomik_skill_versions WHERE skill_id = ?", [skill.id]))[0].n).toBe(2);

    /* A template's placeholders are its parameters, and every parameter is used. */
    const stray = { ...v2.template, steps: v2.template.steps.map((x, i) => (i === 0 ? { ...x, prompt: `${x.prompt} {{colour}}` } : x)) };
    await expect(s.editSkill(skill.id, { expectedVersion: 2, template: stray }, "u1")).rejects.toThrow(/isn't one of this skill's parameters/);
    const unused = { ...v2.template, parameters: [...v2.template.parameters, { key: "colour", label: "Colour", default: "teal" }] };
    await expect(s.editSkill(skill.id, { expectedVersion: 2, template: unused }, "u1")).rejects.toThrow(/isn't used in any step/);
    /* A step may move only to an engine Atomik can use here; its settings follow the engine. */
    const moved = { ...v2.template, steps: v2.template.steps.map((x, i) => (i === 1 ? { ...x, model: SEEDANCE, params: { ...x.params, seconds: 40 } } : x)) };
    const v3 = await s.editSkill(skill.id, { expectedVersion: 2, template: moved }, "u1");
    expect(v3.template.steps[1]).toMatchObject({ model: SEEDANCE, params: { seconds: 30, ratio: "16:9", resolution: "1080p" } });
    const retired = { ...v3.template, steps: v3.template.steps.map((x, i) => (i === 1 ? { ...x, model: "retired-engine" } : x)) };
    await expect(s.editSkill(skill.id, { expectedVersion: 3, template: retired }, "u1")).rejects.toThrow(/Choose an engine Atomik can use/);
    expect((await rows("SELECT version FROM atomik_skill_versions WHERE skill_id = ? ORDER BY version", [skill.id])).map((r) => r.version)).toEqual([1, 2, 3]);
  });
});

/* ── Archive and restore ─────────────────────────────────────────────── */

test("archive hides a skill and restore brings it back as it was, every version with it; nothing is deleted", async () => {
  const s = await import("../../lib/atomikSkills");
  await inTenant(workspace(), async () => {
    const skill = await saveSkill(await seedRun(), "u1");
    await s.editSkill(skill.id, { expectedVersion: 1, description: "Hero, skate pass and music for any product." }, "u1");
    const archived = await s.setSkillStatus(skill.id, "archived", "u2");
    expect(archived).toMatchObject({ status: "archived", archivedByName: "Ben", version: 2 });
    expect((await s.listSkills({}, "u1")).map((x) => x.id)).toEqual([]);
    expect((await s.listSkills({ status: "archived" }, "u1")).map((x) => x.id)).toEqual([skill.id]);
    /* Archived, it neither runs nor changes, and its command stays its own. */
    await expect(s.runSkill(skill.id, { dryRun: true }, "u1")).rejects.toMatchObject({ status: 409 });
    await expect(s.editSkill(skill.id, { expectedVersion: 2, name: "Renamed" }, "u1")).rejects.toMatchObject({ status: 409 });
    await expect(s.saveSkillFromRun({ chatId: await seedRun(), parameters: [], name: "Another", slug: "wave-runner-spot", description: "Same command.", scope: "personal" }, "u1"))
      .rejects.toThrow(/An archived skill uses \/wave-runner-spot/);
    /* Pressing Archive again changes nothing. */
    expect((await s.setSkillStatus(skill.id, "archived", "u1")).archivedByName).toBe("Ben");

    const restored = await s.setSkillStatus(skill.id, "active", "u1");
    expect(restored).toMatchObject({ status: "active", version: 2, archivedAt: null, description: "Hero, skate pass and music for any product." });
    expect(JSON.stringify(restored.template)).toBe(JSON.stringify(archived.template));
    expect((await s.getSkill(skill.id, "u1")).versions.map((v) => v.version)).toEqual([2, 1]);
    expect((await s.listSkills({ query: "/wave" }, "u2")).map((x) => x.id)).toEqual([skill.id]);
    /* Every row is where it was: nothing was deleted or moved to the archive table. */
    expect((await rows("SELECT COUNT(*) AS n FROM atomik_skills"))[0].n).toBe(1);
    expect((await rows("SELECT COUNT(*) AS n FROM atomik_skill_versions"))[0].n).toBe(2);
  });
});

/* ── Scope and permissions ───────────────────────────────────────────── */

test("a personal skill is its maker's alone; a workspace skill is the team's, under Memory's rule; only the maker changes who sees it", async () => {
  const s = await import("../../lib/atomikSkills");
  const shared = `shared-${randomUUID().slice(0, 6)}`;
  const a = workspace({ file: shared }), b = workspace({ file: shared });
  await inTenant(a, async () => {
    const chatId = await seedRun();
    const mine = await saveSkill(chatId, "u1", { name: "My look", slug: "my-look", scope: "personal" });
    const ours = await saveSkill(chatId, "u1", { name: "Team spot", slug: "team-spot", scope: "workspace" });
    /* The teammate sees the workspace's skill, never the personal one — not listed, not readable, not runnable, not changeable. */
    expect((await s.listSkills({}, "u1")).map((x) => x.slug).sort()).toEqual(["my-look", "team-spot"]);
    expect((await s.listSkills({}, "u2")).map((x) => x.slug)).toEqual(["team-spot"]);
    for (const attempt of [
      () => s.getSkill(mine.id, "u2"), () => s.getSkillVersion(mine.id, 1, "u2"), () => s.runSkill(mine.id, { dryRun: true }, "u2"),
      () => s.editSkill(mine.id, { expectedVersion: 1, name: "Taken" }, "u2"), () => s.setSkillStatus(mine.id, "archived", "u2"),
    ]) await expect(attempt()).rejects.toMatchObject({ status: 404, message: "That skill is gone." });
    /* Its command is still taken, said without naming it. */
    await expect(saveSkill(chatId, "u2", { slug: "my-look", scope: "personal" })).rejects.toThrow("That command is taken in this workspace. Choose another.");

    /* Memory's rule for the workspace's entries: any member may edit, archive and restore them. */
    expect(await s.editSkill(ours.id, { expectedVersion: 1, description: "Ben's better line." }, "u2")).toMatchObject({ version: 2, editedByName: "Ben", canChangeScope: false });
    expect((await s.setSkillStatus(ours.id, "archived", "u2")).status).toBe("archived");
    expect((await s.setSkillStatus(ours.id, "active", "u2")).status).toBe("active");
    /* Only its maker moves a skill between Just me and Workspace. */
    await expect(s.editSkill(ours.id, { expectedVersion: 2, scope: "personal" }, "u2")).rejects.toMatchObject({ status: 403 });
    expect(await s.editSkill(mine.id, { expectedVersion: 1, scope: "workspace" }, "u1")).toMatchObject({ scope: "workspace", version: 2 });
    expect((await s.listSkills({}, "u2")).map((x) => x.slug).sort()).toEqual(["my-look", "team-spot"]);
  });
  /* Another workspace, even one sharing the database file, sees none of it. */
  await inTenant(b, async () => {
    expect(await s.listSkills({}, "u1")).toEqual([]);
    expect(await s.listSkills({ status: "archived" }, "u1")).toEqual([]);
    const theirs = (await rows("SELECT id FROM atomik_skills WHERE workspace_id <> ?", [b.id]))[0].id as string;
    await expect(s.getSkill(theirs, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(s.runSkill(theirs, {}, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(s.setSkillStatus(theirs, "archived", "u1")).rejects.toMatchObject({ status: 404 });
  });
  await inTenant(a, async () => expect((await s.listSkills({}, "u1")).every((x) => x.status === "active")).toBe(true));
});

/* ── Engines no longer allowed ───────────────────────────────────────── */

test("an engine switched off in Settings › Engines, or no longer offered, is named with the nearest allowed one and never swapped on its own", async () => {
  const s = await import("../../lib/atomikSkills");
  const t = await import("../../lib/atomikSkillsText");
  const { setSetting } = await import("../../lib/settings");
  await inTenant(workspace(), async () => {
    const skill = await saveSkill(await seedRun(), "u1");
    await setSetting("atomikEngines", JSON.stringify([KLING_PRO]), "u1");
    const preview = await s.runSkill(skill.id, { dryRun: true }, "u1") as import("../../lib/atomikSkillsText").SkillRunPreview;
    expect(preview.problems).toEqual([expect.objectContaining({ step: 1, title: "Skate pass", model: KLING_PRO, label: "Kling 3.0 Pro", reason: "off", nearest: { id: KLING, label: "Kling 3.0" } })]);
    expect(t.engineProblemText(preview.problems[0])).toBe("Kling 3.0 Pro is switched off for Atomik in Settings › Engines. Nearest allowed: Kling 3.0.");
    /* The step keeps its engine in the preview, unpriced, until the person chooses. */
    expect(preview.steps[1]).toMatchObject({ model: KLING_PRO, swapped: false, estUsd: null });
    const before = Number((await rows("SELECT COUNT(*) AS n FROM atomik_steps"))[0].n);
    const refused = await s.runSkill(skill.id, {}, "u1").then(() => null, (e: unknown) => e as InstanceType<typeof s.SkillError>);
    expect(refused).toMatchObject({ status: 409, problems: [expect.objectContaining({ reason: "off", nearest: { id: KLING, label: "Kling 3.0" } })] });
    expect(Number((await rows("SELECT COUNT(*) AS n FROM atomik_steps"))[0].n)).toBe(before);
    /* An engine of another kind is not a choice. */
    await expect(s.runSkill(skill.id, { engines: { 1: NANO_PRO } }, "u1")).rejects.toThrow(/can't make step 2/);
    /* Chosen by the person, it runs on the nearest, and the plan says so. */
    const run = await s.runSkill(skill.id, { engines: { 1: KLING } }, "u1") as { chatId: string; steps: import("../../lib/atomik").Step[] };
    expect(run.steps.map((x) => x.model)).toEqual([NANO_PRO, KLING, "elevenlabs"]);
    const reply = (await rows("SELECT text FROM atomik_messages WHERE chat_id = ? AND role = 'assistant'", [run.chatId]))[0].text as string;
    expect(reply).toContain("Skate pass on Kling 3.0, as you chose");
  });

  /* No longer offered at all: the same family first, then the same provider and settings, then the list's order. */
  const allowed = [
    { id: SEEDANCE, label: "Seedance 2.5", kind: "video", ratios: ["16:9"], resolutions: ["1080p"], durations: [5] },
    { id: KLING, label: "Kling 3.0", kind: "video", ratios: ["16:9"], resolutions: ["1080p"], durations: [5] },
    { id: NANO_PRO, label: "Nano Banana Pro", kind: "image", ratios: ["16:9"], resolutions: ["2K"], durations: [] },
  ];
  const catalogue = [
    { id: KLING_PRO, label: "Kling 3.0 Pro", family: "kling-3", provider: "fal" }, { id: KLING, label: "Kling 3.0", family: "kling-3", provider: "fal" },
    { id: SEEDANCE, label: "Seedance 2.5", family: "seedance-2", provider: "byteplus" }, { id: NANO_PRO, label: "Nano Banana Pro", family: "nano-banana", provider: "google" },
  ];
  const step = { kind: "video" as const, title: "Skate pass", prompt: "p", model: KLING_PRO, params: { ratio: "16:9", resolution: "1080p", seconds: 5 } };
  expect(t.engineProblem(step, 1, allowed, [], catalogue)).toMatchObject({ reason: "gone", nearest: { id: KLING }, choices: [{ id: KLING, label: "Kling 3.0" }, { id: SEEDANCE, label: "Seedance 2.5" }] });
  expect(t.engineProblem({ ...step, model: "retired-engine" }, 1, allowed, [], catalogue)).toMatchObject({ reason: "gone", label: "retired-engine", nearest: { id: SEEDANCE } });
  expect(t.engineProblem({ ...step, model: KLING }, 1, allowed, [], catalogue)).toBeNull();
  expect(t.engineProblem({ ...step, kind: "image" as const, model: "old-still" }, 0, allowed.slice(0, 2), [], catalogue)).toMatchObject({ nearest: null, choices: [] });
});

/* ── A run is proposals that wait for a quote and an approval ────────── */

test("a skill run files proposals that each wait at their checkpoint: nothing is claimed, rendered, charged or planned by a model", async () => {
  const s = await import("../../lib/atomikSkills");
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); throw new Error("no network in a skill run"); }) as typeof fetch;
  try {
    const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
    for (const credits of [true, false]) {
      /* Every workspace pays in credits but the house (lib/houseWorkspace.ts), which reads its engines' dollars. */
      await inTenant(credits ? workspace({ credits }) : { ...workspace({ credits }), id: HOUSE_WORKSPACE_ID }, async () => {
        const { ready } = await import("../../lib/db");
        await ready();
        await rows("INSERT INTO projects(id, name, created_at) VALUES ('p1', 'Launch', 0)");
        const skill = await saveSkill(await seedRun({ videoModel: KLING }), "u1");
        const values = { product: "Red High-Tops", setting: "rooftop at dusk" };
        const counts = async () => (await rows("SELECT (SELECT COUNT(*) FROM atomik_chats) AS c, (SELECT COUNT(*) FROM atomik_messages) AS m, (SELECT COUNT(*) FROM atomik_steps) AS s"))[0];
        const before = await counts();
        const preview = await s.runSkill(skill.id, { values, dryRun: true }, "u1") as import("../../lib/atomikSkillsText").SkillRunPreview;
        /* A preview writes nothing. */
        expect(await counts()).toEqual(before);
        expect(preview.problems).toEqual([]);
        expect(preview.steps[0].prompt).toBe("Studio still of teal Red High-Tops on wet sand, rooftop at dusk, warm backlight.");
        /* Priced in the workspace's own unit, never both: credits where it pays in credits, its own dollars where it pays its vendors. */
        for (const x of preview.steps.slice(0, 2)) {
          if (credits) { expect(x.estUsd).toBeNull(); expect(typeof x.estCredits).toBe("number"); }
          else { expect(x.estCredits).toBeNull(); expect(typeof x.estUsd).toBe("number"); }
        }

        const run = await s.runSkill(skill.id, { values, projectId: "p1" }, "u1") as { chatId: string; messageId: string; steps: import("../../lib/atomik").Step[] };
        expect(run.steps).toHaveLength(3);
        for (const x of run.steps) expect(x).toMatchObject({ status: "proposed", genId: null, messageId: run.messageId });
        expect(run.steps[1]).toMatchObject({ model: KLING, title: "Skate pass", prompt: "@Maya skating along a rooftop at dusk in teal Red High-Tops, low wide tracking shot.", params: { ratio: "16:9", resolution: "1080p", seconds: 5 } });
        if (credits) { expect(run.steps[0].estCostUsd).toBeNull(); expect(typeof run.steps[0].estCredits).toBe("number"); }
        const chat = (await rows("SELECT * FROM atomik_chats WHERE id = ?", [run.chatId]))[0];
        expect(chat).toMatchObject({ project_id: "p1", status: "waiting", agent_mode: "ask", title: "Wave Runner spot", text_cost_usd: 0, created_by: "u1" });
        const messages = await rows("SELECT role, text, cost_usd, model FROM atomik_messages WHERE chat_id = ? ORDER BY created_at", [run.chatId]);
        expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(messages[0].text).toBe("/wave-runner-spot product: Red High-Tops · setting: rooftop at dusk");
        /* No model answered: no planning turn to bill. */
        expect(messages[1]).toMatchObject({ cost_usd: 0, model: "" });
        expect(String(messages[1].text)).toContain("Nothing runs until you approve it.");
        /* Nothing was claimed, rendered or metered. */
        expect(await rows("SELECT id FROM atomik_steps WHERE chat_id = ? AND (status <> 'proposed' OR gen_id IS NOT NULL OR claimed_by IS NOT NULL)", [run.chatId])).toEqual([]);
        expect(await rows("SELECT id FROM generations")).toEqual([]);
        const { platformDb, platformReady } = await import("../../lib/platform");
        await platformReady();
        expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE id IN (?,?)", args: [run.chatId, run.messageId] })).rows).toEqual([]);

        /* Filed into a chat the person is in, it joins that conversation; never under a turn still planning. */
        const again = await s.runSkill(skill.id, { values: { product: "Canvas slip-ons" }, chatId: run.chatId }, "u1") as { chatId: string; steps: unknown[] };
        expect(again.chatId).toBe(run.chatId);
        expect(Number((await rows("SELECT COUNT(*) AS n FROM atomik_steps WHERE chat_id = ? AND status = 'proposed'", [run.chatId]))[0].n)).toBe(6);
        await rows("UPDATE atomik_chats SET status = 'running' WHERE id = ?", [run.chatId]);
        await expect(s.runSkill(skill.id, { chatId: run.chatId }, "u1")).rejects.toMatchObject({ status: 409 });
        /* An empty parameter is asked for, never guessed. */
        await expect(s.runSkill(skill.id, { values: { product: "  " } }, "u1")).rejects.toThrow("Fill in Product.");
      });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls).toEqual([]);
});

/* ── The latest plan, and values typed after a command ───────────────── */

test("a save keeps the chat's latest plan by default, earlier plans start unticked, and values typed after a command are read back", async () => {
  const s = await import("../../lib/atomikSkills");
  const t = await import("../../lib/atomikSkillsText");
  await inTenant(workspace(), async () => {
    const chatId = await seedRun();
    /* A later plan in the same chat: one more still. */
    const at = Date.now();
    await rows(`INSERT INTO atomik_messages (id, chat_id, role, text, activity, created_at) VALUES (?,?,?,?,?,?)`, [`${chatId}_m3`, chatId, "user", "One more still of the Wave Runner sneakers at night.", "[]", at]);
    await rows(`INSERT INTO atomik_messages (id, chat_id, role, text, activity, cost_usd, model, created_at) VALUES (?,?,?,?,?,?,?,?)`, [`${chatId}_m4`, chatId, "assistant", "One still.", "[]", 0.01, "anthropic/claude-test", at + 1]);
    await rows(`INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, created_at, updated_at)
                VALUES (?,?,?,0,'image','Night still','Teal Wave Runner sneakers under a streetlight at night.',?,?,'[]','proposed',?,?)`,
      [`${chatId}_s5`, chatId, `${chatId}_m4`, NANO_PRO, JSON.stringify({ ratio: "1:1", resolution: "2K" }), at + 2, at + 2]);
    const draft = await s.draftFromRun(chatId);
    expect(draft.steps.map((x) => [x.title, x.latest, x.keep])).toEqual([
      ["Wave Runner hero still", false, false], ["Skate pass", false, false], ["Surf bed", false, false], ["Night still", true, true],
    ]);
    const saved = await s.saveSkillFromRun({ chatId, parameters: [{ key: "product", label: "Product", phrase: "Wave Runner sneakers" }], name: "Night still", description: "A still at night.", scope: "personal" }, "u1");
    expect(saved.template.steps.map((x) => x.title)).toEqual(["Night still"]);
    /* Earlier steps are kept when the person ticks them. */
    const both = await s.saveSkillFromRun({ chatId, stepIds: [`${chatId}_s5`, `${chatId}_s1`], parameters: [], name: "Both stills", description: "Two stills.", scope: "personal" }, "u1");
    expect(both.template.steps.map((x) => x.title)).toEqual(["Wave Runner hero still", "Night still"]);
  });
  const parameters = [{ key: "product", label: "Product", default: "sneakers" }, { key: "setting", label: "Setting", default: "beach" }];
  expect(t.commandValues("product: Red High-Tops · setting: a rooftop at dusk", parameters)).toEqual({ product: "Red High-Tops", setting: "a rooftop at dusk" });
  expect(t.commandValues("Setting: harbour; colour: red", parameters)).toEqual({ setting: "harbour" });
  expect(t.commandValues("just some words", parameters)).toEqual({});
});

/* ── Library steps ───────────────────────────────────────────────────── */

test("a library step is never kept: the form says why, a template refuses its engine, and a run of only library steps is not offered", async () => {
  const s = await import("../../lib/atomikSkills");
  const t = await import("../../lib/atomikSkillsText");
  const MOTION = "higgsfield-genjutsu-motion-transfer";
  const MARKETING = "higgsfield/marketing-studio-image";
  await inTenant(workspace(), async () => {
    const chatId = await seedRun({ projectId: "p_lib" });
    /* The same plan also has a campaign still made from the prompt alone, and a transform of a library clip. */
    const at = Date.now();
    const libraryStep = (id: string, position: number, kind: string, title: string, model: string, params: object, refs: object[]) => rows(
      `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, est_cost_usd, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'proposed',0.3,?,?)`,
      [id, chatId, `${chatId}_m2`, position, kind, title, "Teal Wave Runner sneakers on a beach at sunset, campaign light.", model, JSON.stringify(params), JSON.stringify(refs), at + position, at + position]);
    await libraryStep(`${chatId}_k1`, 4, "image", "Campaign still", MARKETING, { ratio: "1:1", resolution: "2k", marketing: { quality: "high", enhancePrompt: false }, inputs: { references: [] } }, []);
    await libraryStep(`${chatId}_k2`, 5, "video", "Motion transfer", MOTION, { task: "genjutsu", ratio: "adaptive", resolution: "720p", sourceUploadId: "up_clip", inputs: { source: "Skate.mp4", references: ["Shoe.png"] } }, [{ uploadId: "up_still", role: "reference_image" }]);

    const draft = await s.draftFromRun(chatId);
    const library = draft.steps.filter((x) => x.model === MARKETING || x.model === MOTION);
    expect(library.map((x) => [x.title, x.label, x.keep, x.why])).toEqual([
      ["Campaign still", "Marketing Studio Image", false, t.LIBRARY_STEP_REASON],
      ["Motion transfer", "Motion Transfer", false, t.LIBRARY_STEP_REASON],
    ]);
    /* The default save keeps the rest of the plan and leaves the library steps out. */
    const saved = await saveSkill(chatId, "u1");
    expect(saved.template.steps.map((x) => x.model)).toEqual([NANO_PRO, KLING_PRO, "elevenlabs"]);
    /* Chosen on purpose, a library step is refused with its reason, and nothing is saved. */
    await expect(saveSkill(chatId, "u1", { slug: "with-library", stepIds: [`${chatId}_s1`, `${chatId}_k1`] })).rejects.toThrow(/Step 2 can't be kept: it is a library step/);
    expect((await rows("SELECT COUNT(*) AS n FROM atomik_skills"))[0].n).toBe(1);
    /* No template holds a library engine, whether written by hand or moved to one in an edit. */
    expect(() => t.checkTemplate({ parameters: [], steps: [{ kind: "image", title: "Still", prompt: "A still of a shoe.", model: MARKETING, params: {} }] }))
      .toThrow(/is on a library engine/);
    const moved = { ...saved.template, steps: saved.template.steps.map((x, i) => (i === 0 ? { ...x, model: MARKETING } : x)) };
    await expect(s.editSkill(saved.id, { expectedVersion: 1, template: moved }, "u1")).rejects.toThrow(/is on a library engine/);
    expect((await s.getSkill(saved.id, "u1")).skill.version).toBe(1);

    /* The runs offered to save count only what a skill can keep; one of library steps alone is not offered. */
    const onlyLibrary = `ach_${randomUUID().slice(0, 8)}`;
    await rows(`INSERT INTO atomik_chats (id, project_id, title, model, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted)
                VALUES (?, 'p_lib', 'Campaign stills', 'auto', 'ask', 'waiting', 0, 'u1', ?, ?, 0)`, [onlyLibrary, at, at + 50]);
    await rows(`INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, created_at, updated_at)
                VALUES (?,?,?,0,'image','Campaign still','A campaign still.',?,'{}','[]','proposed',?,?)`, [`${onlyLibrary}_k`, onlyLibrary, `${onlyLibrary}_m`, MARKETING, at, at]);
    const runs = await s.savableRuns("p_lib");
    expect(runs.map((r) => [r.chatId, r.steps])).toEqual([[chatId, 3]]);
  });
});

test("`/` in the composer: a command being typed lists its matches with the command itself first; values after a command are read", async () => {
  const t = await import("../../lib/atomikSkillsText");
  const skill = (slug: string, name: string) => ({ slug, name, template: { steps: [], parameters: [{ key: "product", label: "Product", default: "sneakers" }] } });
  /* Newest change first, as the list arrives. */
  const skills = [skill("wave-runner-spot", "Wave Runner spot"), skill("wave", "Wave"), skill("harbour-wide", "Harbour wave wide")];
  expect(t.typingCommand("/wave")).toBe(true);
  expect(t.typingCommand("/")).toBe(true);
  expect(t.typingCommand("/wave product: red")).toBe(false);
  expect(t.typingCommand("make a wave")).toBe(false);
  expect(t.matchingSkills("/wave", skills).map((x) => x.slug)).toEqual(["wave", "wave-runner-spot", "harbour-wide"]);
  expect(t.matchingSkills("/wave-r", skills).map((x) => x.slug)).toEqual(["wave-runner-spot"]);
  expect(t.matchingSkills("/", skills).map((x) => x.slug)).toEqual(["wave-runner-spot", "wave", "harbour-wide"]);
  expect(t.commandIn("/wave-runner-spot product: Red High-Tops", skills)).toEqual({ skill: skills[0], values: { product: "Red High-Tops" } });
  expect(t.commandIn("/wave", skills)?.skill.slug).toBe("wave");
  expect(t.commandIn("/wav", skills)).toBeNull();
});
