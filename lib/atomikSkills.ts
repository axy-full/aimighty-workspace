import type { Client, InStatement } from "@libsql/client";
import { db, ready, now, id as newId } from "./db";
import { requireTenant } from "./tenant";
import { getSetting } from "./settings";
import { MODELS } from "./models";
import { mediaMutation } from "./mediaMutation";
import { engines, estimateStepUsd, fitStepParams, getChat, stepForBrowser, type Engine, type Step } from "./atomik";
import { KEY_STEP_MODELS, keyStepLabel } from "./atomikKeySteps";
import { PROJECT_ID } from "./atomikMemoryText";
import {
  SKILL_ID, SKILL_LIMITS, SKILL_SLUG, SkillTextError,
  checkTemplate, cleanLine, describeValues, engineProblem, engineProblemText, fillTemplate, isSkillScope, parameterValues,
  settingsOf, slugOf, suggestParameters, templateFromRun, unkeptReason,
  type CatalogueEntry, type EngineChoice, type EngineProblem, type ParameterDraft, type SavableRun, type SkillDraft,
  type SkillRunPreview, type SkillRunStep, type SkillScope, type SkillSettings, type SkillStatus, type SkillTemplate,
  type SkillVersionView, type SkillView,
} from "./atomikSkillsText";

export type { SkillView, SkillVersionView, SkillTemplate } from "./atomikSkillsText";

/**
 * Atomik skills: a run saved to be run again. A skill keeps the run's steps —
 * each with its engine and settings — and the person's words as named
 * parameters (lib/atomikSkillsText.ts); never what the run made or cost.
 *
 * Every skill belongs to one workspace. A personal skill ("Just me") is seen
 * and changed by the person who made it alone; a workspace skill is the
 * team's and follows Memory's rule for workspace entries: any signed-in
 * member may save, edit, archive and restore it. Only its maker moves a
 * skill between the two. Both tables live in the workspace's own database
 * AND carry workspace_id, and every read and write filters on it.
 *
 * An edit never changes a version: it adds the next one, and every earlier
 * version stays readable. Archive hides a skill (a flag on its row) and
 * Restore brings it back as it was; nothing here deletes a row.
 *
 * Saving, browsing and editing cost nothing: no route here calls a model or
 * a vendor. Running a skill fills its parameters into its steps and files
 * them in an Atomik chat as proposals, each priced — the same proposals a
 * planning turn makes, approved one at a time through the same checkpoint
 * (components/atomik/AtomikProvider.tsx). A run never claims, renders or
 * charges anything itself, and it bills no planning turn.
 */

/** A person's mistake about a skill, or a run that must wait for them; `problems` when an engine needs their choice. */
export class SkillError extends SkillTextError {
  constructor(message: string, status = 400, readonly problems: EngineProblem[] = []) { super(message, status); this.name = "SkillError"; }
}

const SKILLS = "atomik_skills";
const VERSIONS = "atomik_skill_versions";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${SKILLS}(
     workspace_id TEXT NOT NULL, id TEXT NOT NULL,
     slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     scope TEXT NOT NULL DEFAULT 'personal', owner_id TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'active', archived_by TEXT, archived_at INTEGER,
     source_chat_id TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY(workspace_id, id)
   )`,
  /* One command per name in a workspace, archived skills included: a restore never collides. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_atomik_skills_slug ON ${SKILLS}(workspace_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_atomik_skills_list ON ${SKILLS}(workspace_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ${VERSIONS}(
     workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
     name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL,
     template TEXT NOT NULL, note TEXT,
     created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY(workspace_id, skill_id, version)
   )`,
];

const initialized = new WeakMap<Client, Promise<void>>();
/** Both tables, created on first use in this workspace's database (additive: nothing else changes). */
export async function skillsReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((error) => {
      initialized.delete(client);
      throw error;
    }));
  await initialized.get(client);
}

type Row = Record<string, unknown>;
type Skill = {
  id: string; slug: string; name: string; description: string; scope: SkillScope; ownerId: string;
  version: number; status: SkillStatus; archivedBy: string | null; archivedAt: number | null;
  sourceChatId: string | null; createdAt: number; updatedAt: number;
};
const text = (value: unknown) => (value == null ? null : String(value));
function toSkill(r: Row): Skill {
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name), description: String(r.description ?? ""),
    scope: r.scope === "workspace" ? "workspace" : "personal", ownerId: String(r.owner_id ?? ""),
    version: Number(r.version ?? 1), status: r.status === "archived" ? "archived" : "active",
    archivedBy: text(r.archived_by), archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    sourceChatId: text(r.source_chat_id), createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
  };
}

/** A personal skill is its maker's alone; a workspace skill is every member's. */
const visibleTo = (skill: Skill, viewer: string) => skill.scope === "workspace" || skill.ownerId === viewer;
const GONE = "That skill is gone.";

/** A stored template, read back through the same checks it was saved with. */
function readTemplate(raw: unknown): SkillTemplate {
  try { return checkTemplate(JSON.parse(String(raw ?? ""))); }
  catch { throw new SkillError("This skill could not be read. Try again.", 500); }
}

async function skillRow(workspaceId: string, id: string): Promise<Skill | null> {
  const r = (await db().execute({ sql: `SELECT * FROM ${SKILLS} WHERE workspace_id = ? AND id = ?`, args: [workspaceId, id] })).rows[0] as Row | undefined;
  return r ? toSkill(r) : null;
}

/** The skill, if this person may see it; one they may not reads as gone. */
async function visibleSkill(id: unknown, viewer: string): Promise<{ workspaceId: string; skill: Skill }> {
  if (typeof id !== "string" || !SKILL_ID.test(id)) throw new SkillError(GONE, 404);
  await skillsReady();
  const workspaceId = requireTenant().id;
  const skill = await skillRow(workspaceId, id);
  if (!skill || !visibleTo(skill, viewer)) throw new SkillError(GONE, 404);
  return { workspaceId, skill };
}

async function versionRow(workspaceId: string, skillId: string, version: number): Promise<Row | null> {
  return ((await db().execute({ sql: `SELECT * FROM ${VERSIONS} WHERE workspace_id = ? AND skill_id = ? AND version = ?`, args: [workspaceId, skillId, version] })).rows[0] as Row | undefined) ?? null;
}

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const rs = await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${wanted.map(() => "?").join(",")})`, args: wanted }).catch(() => null);
  for (const r of rs?.rows ?? []) if (r.name) out.set(String(r.id), String(r.name));
  return out;
}

function toView(skill: Skill, current: { template: SkillTemplate; by: string }, names: Map<string, string>, viewer: string): SkillView {
  return {
    id: skill.id, slug: skill.slug, name: skill.name, description: skill.description,
    scope: skill.scope, status: skill.status, version: skill.version,
    byYou: skill.ownerId === viewer, byName: names.get(skill.ownerId) ?? null,
    editedByYou: current.by === viewer, editedByName: names.get(current.by) ?? null,
    archivedByYou: skill.archivedBy === viewer, archivedByName: skill.archivedBy ? names.get(skill.archivedBy) ?? null : null, archivedAt: skill.archivedAt,
    createdAt: skill.createdAt, updatedAt: skill.updatedAt, template: current.template,
    canChangeScope: skill.ownerId === viewer,
  };
}

async function viewOf(workspaceId: string, skill: Skill, viewer: string): Promise<SkillView> {
  const v = await versionRow(workspaceId, skill.id, skill.version);
  if (!v) throw new SkillError("This skill could not be read. Try again.", 500);
  const by = String(v.created_by ?? "");
  return toView(skill, { template: readTemplate(v.template), by }, await namesOf([skill.ownerId, by, skill.archivedBy]), viewer);
}

/* ── The engines a skill may run on ────────────────────────────────────── */

/** The engines switched off under Settings › Engines & rates (`ATOMIK MAY PROPOSE`), as lib/atomik.ts reads them. */
async function enginesOff(): Promise<string[]> {
  try { const raw = JSON.parse(await getSetting("atomikEngines")); return Array.isArray(raw) ? raw.map(String) : []; } catch { return []; }
}

const CATALOGUE: CatalogueEntry[] = MODELS.map((m) => ({ id: m.id, label: m.label, family: m.family, provider: m.provider }));
const choiceOf = (e: Engine): EngineChoice => ({ id: e.id, label: e.label, kind: e.kind, ratios: e.ratios, resolutions: e.resolutions, durations: e.durations });
/** The name an engine is shown by, whether or not it is still offered (a library step's by the name its card uses). */
export function engineLabel(id: string, allowed: readonly Pick<Engine, "id" | "label">[] = []): string {
  return allowed.find((e) => e.id === id)?.label ?? keyStepLabel(id) ?? MODELS.find((m) => m.id === id)?.label ?? (id === "elevenlabs" ? "Voice, sound and music" : id);
}

/* ── Saving a run ──────────────────────────────────────────────────────── */

/**
 * Runs a person could save: the Atomik chats with a step a skill can keep,
 * newest first (this project's, when one is open), each with how many it has.
 * A step on the connected account, a library step or one that worked from
 * attached media is not counted (lib/atomikSkillsText.ts › unkeptReason).
 */
export async function savableRuns(projectId: unknown): Promise<SavableRun[]> {
  await ready();
  const project = typeof projectId === "string" && PROJECT_ID.test(projectId) ? projectId : null;
  const rs = await db().execute({
    sql: `SELECT c.id, c.title, c.project_id, c.updated_at, COUNT(s.id) AS n FROM atomik_chats c
          JOIN atomik_steps s ON s.chat_id = c.id AND s.status <> 'rejected' AND s.model NOT LIKE 'connected:%'
            AND s.model NOT IN (${KEY_STEP_MODELS.map(() => "?").join(",")}) AND (s.refs IS NULL OR s.refs IN ('', '[]'))
          WHERE c.deleted = 0${project ? " AND c.project_id = ?" : ""}
          GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 12`,
    args: [...KEY_STEP_MODELS, ...(project ? [project] : [])],
  });
  return rs.rows.map((r) => ({ chatId: String(r.id), title: String(r.title ?? "New chat"), projectId: text(r.project_id), steps: Number(r.n ?? 0), updatedAt: Number(r.updated_at ?? 0) }));
}

/** The steps of the chat's latest plan: the one the conversation shows (the last reply that proposed any). */
function latestPlan(loaded: { messages: { id: string; role: string }[]; steps: Step[] }): Set<string> {
  const planned = new Set(loaded.steps.map((s) => s.messageId));
  const last = [...loaded.messages].reverse().find((m) => m.role === "assistant" && planned.has(m.id));
  return new Set(loaded.steps.filter((s) => !last || s.messageId === last.id).map((s) => s.id));
}

async function runOf(chatId: unknown) {
  if (typeof chatId !== "string" || !/^ach_[A-Za-z0-9]{4,60}$/.test(chatId)) throw new SkillError("That run is gone.", 404);
  const loaded = await getChat(chatId);
  if (!loaded) throw new SkillError("That run is gone.", 404);
  return loaded;
}

/**
 * The Save as skill form, filled from a run: its steps (the ones a skill
 * cannot keep say why and start unticked), a name, and the phrases of the
 * person's own request that its prompts repeat, as suggested parameters.
 * Read-only and free.
 */
export async function draftFromRun(chatId: unknown): Promise<SkillDraft> {
  const loaded = await runOf(chatId);
  const allowed = await engines();
  const steps = loaded.steps.filter((s) => s.status !== "rejected");
  const latest = latestPlan(loaded);
  const kept = steps.filter((s) => !unkeptReason(s) && latest.has(s.id));
  const name = loaded.chat.title && loaded.chat.title !== "New chat" ? cleanLine(loaded.chat.title, SKILL_LIMITS.name) : "";
  return {
    chatId: loaded.chat.id, name, slug: name ? slugOf(name) : "",
    steps: steps.map((s) => {
      const why = unkeptReason(s);
      const kind = s.kind === "image" || s.kind === "audio" ? s.kind : "video";
      return { id: s.id, kind: s.kind, title: s.title, prompt: s.prompt, model: s.model, label: engineLabel(s.model, allowed), settings: settingsOf(kind, s.params),
        keep: !why && latest.has(s.id), latest: latest.has(s.id), why };
    }),
    parameters: suggestParameters(loaded.messages.filter((m) => m.role === "user").map((m) => m.text), kept),
  };
}

type Fields = { name: string; slug: string; description: string; scope: SkillScope };

function fieldsOf(input: { name?: unknown; slug?: unknown; description?: unknown; scope?: unknown }, current?: Fields): Fields {
  const name = input.name === undefined && current ? current.name : cleanLine(input.name, SKILL_LIMITS.name);
  if (name.length < 2) throw new SkillError("Name the skill.");
  const rawSlug = input.slug === undefined ? (current ? current.slug : slugOf(name)) : String(input.slug ?? "").trim().replace(/^\//, "").toLowerCase();
  if (!SKILL_SLUG.test(rawSlug)) throw new SkillError("A command is 2 to 40 lower-case letters, digits and dashes, starting with a letter, like /product-spot.");
  const description = input.description === undefined && current ? current.description : cleanLine(input.description, SKILL_LIMITS.description);
  if (description.length < 3) throw new SkillError("Describe what the skill makes, in a line.");
  const scope = input.scope === undefined && current ? current.scope : input.scope;
  if (!isSkillScope(scope)) throw new SkillError("Choose who sees it: just you, or the workspace.");
  return { name, slug: rawSlug, description, scope };
}

/** A command in use: said without naming a skill the person cannot see. */
async function slugTaken(workspaceId: string, slug: string, viewer: string, except: string | null): Promise<string | null> {
  const r = (await db().execute({ sql: `SELECT * FROM ${SKILLS} WHERE workspace_id = ? AND slug = ?${except ? " AND id <> ?" : ""}`, args: except ? [workspaceId, slug, except] : [workspaceId, slug] })).rows[0] as Row | undefined;
  if (!r) return null;
  const other = toSkill(r);
  if (!visibleTo(other, viewer)) return "That command is taken in this workspace. Choose another.";
  return other.status === "archived" ? `An archived skill uses /${slug}. Restore it, or choose another command.` : `/${slug} is already a skill. Choose another command.`;
}

const unique = (error: unknown) => /UNIQUE|PRIMARY KEY|constraint/i.test(error instanceof Error ? error.message : String(error));

async function activeCount(workspaceId: string): Promise<number> {
  return Number((await db().execute({ sql: `SELECT COUNT(*) AS n FROM ${SKILLS} WHERE workspace_id = ? AND status = 'active'`, args: [workspaceId] })).rows[0]?.n ?? 0);
}
const FULL = `A workspace keeps ${SKILL_LIMITS.activeSkills} skills. Archive some you no longer use, then save this again.`;

/**
 * Save a run as a skill: the chosen steps (by default the latest plan's, each
 * that a skill can keep) with the chosen phrases as parameters, as version 1. Its maker and
 * the run it came from are kept with it.
 */
export async function saveSkillFromRun(input: {
  chatId: unknown; stepIds?: unknown; parameters?: unknown; name?: unknown; slug?: unknown; description?: unknown; scope?: unknown;
}, by: string): Promise<SkillView> {
  const loaded = await runOf(input.chatId);
  let chosen: Step[];
  if (Array.isArray(input.stepIds)) {
    const ids = [...new Set(input.stepIds.map(String))];
    chosen = ids.map((id) => loaded.steps.find((s) => s.id === id)).filter((s): s is Step => Boolean(s));
    if (chosen.length !== ids.length) throw new SkillError("A step you chose is no longer in that run. Reload it and try again.", 409);
    chosen.sort((a, b) => loaded.steps.indexOf(a) - loaded.steps.indexOf(b));
  } else {
    const latest = latestPlan(loaded);
    chosen = loaded.steps.filter((s) => s.status !== "rejected" && !unkeptReason(s) && latest.has(s.id));
  }
  const drafts: ParameterDraft[] = (Array.isArray(input.parameters) ? input.parameters : []).map((p) => {
    const o = p && typeof p === "object" ? p as Record<string, unknown> : {};
    return { key: String(o.key ?? ""), label: String(o.label ?? ""), phrase: String(o.phrase ?? "") };
  });
  const template = checkTemplate(templateFromRun(chosen, drafts));
  const fields = fieldsOf(input);
  await skillsReady();
  const workspaceId = requireTenant().id;
  if ((await activeCount(workspaceId)) >= SKILL_LIMITS.activeSkills) throw new SkillError(FULL, 409);
  const taken = await slugTaken(workspaceId, fields.slug, by, null);
  if (taken) throw new SkillError(taken, 409);
  const id = newId("skl");
  const at = now();
  try {
    await db().batch([
      { sql: `INSERT INTO ${SKILLS}(workspace_id, id, slug, name, description, scope, owner_id, version, status, source_chat_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,1,'active',?,?,?)`,
        args: [workspaceId, id, fields.slug, fields.name, fields.description, fields.scope, by, loaded.chat.id, at, at] },
      versionInsert(workspaceId, id, 1, fields, template, "Saved from a run", by, at),
    ], "write");
  } catch (error) {
    if (unique(error)) throw new SkillError("That command is taken in this workspace. Choose another.", 409);
    throw error;
  }
  return viewOf(workspaceId, (await skillRow(workspaceId, id))!, by);
}

function versionInsert(workspaceId: string, skillId: string, version: number, f: Fields, template: SkillTemplate, note: string | null, by: string, at: number): InStatement {
  return {
    sql: `INSERT INTO ${VERSIONS}(workspace_id, skill_id, version, name, slug, description, scope, template, note, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [workspaceId, skillId, version, f.name, f.slug, f.description, f.scope, JSON.stringify(template), note, by, at],
  };
}

/* ── Reading ───────────────────────────────────────────────────────────── */

/**
 * The skills this person may see — the workspace's and their own — newest
 * change first, active or archived. `query` narrows by name, command,
 * description or a parameter's name.
 */
export async function listSkills(opts: { status?: unknown; query?: unknown }, viewer: string): Promise<SkillView[]> {
  await skillsReady();
  const workspaceId = requireTenant().id;
  const status: SkillStatus = opts.status === "archived" ? "archived" : "active";
  const rs = await db().execute({
    sql: `SELECT s.*, v.template AS template, v.created_by AS edited_by FROM ${SKILLS} s
          JOIN ${VERSIONS} v ON v.workspace_id = s.workspace_id AND v.skill_id = s.id AND v.version = s.version
          WHERE s.workspace_id = ? AND (s.scope = 'workspace' OR s.owner_id = ?) AND s.status = ?
          ORDER BY s.updated_at DESC LIMIT 400`,
    args: [workspaceId, viewer, status],
  });
  const rows = rs.rows.map((r) => ({ skill: toSkill(r as Row), template: r.template, by: String((r as Row).edited_by ?? "") }));
  const names = await namesOf(rows.flatMap((r) => [r.skill.ownerId, r.by, r.skill.archivedBy]));
  const q = typeof opts.query === "string" ? opts.query.trim().toLowerCase().replace(/^\//, "") : "";
  const out: SkillView[] = [];
  for (const r of rows) {
    let template: SkillTemplate;
    try { template = readTemplate(r.template); } catch { continue; }
    const view = toView(r.skill, { template, by: r.by }, names, viewer);
    if (q && ![view.name, view.slug, view.description, ...template.parameters.map((p) => p.label)].some((t) => t.toLowerCase().includes(q))) continue;
    out.push(view);
  }
  return out;
}

/**
 * One skill, with every version it has had (newest first; each version's
 * steps are read on their own), and the engines an edit may move a step to:
 * the ones Atomik can use here now.
 */
export async function getSkill(id: unknown, viewer: string): Promise<{ skill: SkillView; versions: SkillVersionView[]; engines: EngineChoice[] }> {
  const { workspaceId, skill } = await visibleSkill(id, viewer);
  const rs = await db().execute({
    sql: `SELECT version, name, slug, description, scope, note, created_by, created_at FROM ${VERSIONS} WHERE workspace_id = ? AND skill_id = ? ORDER BY version DESC`,
    args: [workspaceId, skill.id],
  });
  const names = await namesOf(rs.rows.map((r) => text(r.created_by)));
  return {
    skill: await viewOf(workspaceId, skill, viewer),
    versions: rs.rows.map((r) => versionView(r as Row, names, viewer)),
    engines: (await engines()).map(choiceOf),
  };
}

function versionView(r: Row, names: Map<string, string>, viewer: string): SkillVersionView {
  const by = String(r.created_by ?? "");
  return {
    version: Number(r.version), name: String(r.name), slug: String(r.slug), description: String(r.description ?? ""),
    scope: r.scope === "workspace" ? "workspace" : "personal", note: text(r.note),
    byYou: by === viewer, byName: names.get(by) ?? null, createdAt: Number(r.created_at ?? 0),
  };
}

/** One version as it was saved, steps and parameters included: every earlier version stays readable. */
export async function getSkillVersion(id: unknown, version: unknown, viewer: string): Promise<SkillVersionView> {
  const { workspaceId, skill } = await visibleSkill(id, viewer);
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1 || n > skill.version) throw new SkillError("That version is not there.", 404);
  const r = await versionRow(workspaceId, skill.id, n);
  if (!r) throw new SkillError("That version is not there.", 404);
  return { ...versionView(r, await namesOf([text(r.created_by)]), viewer), template: readTemplate(r.template) };
}

/* ── Changing ──────────────────────────────────────────────────────────── */

/**
 * Edit a skill: the next version, never a change to one already kept. The
 * edit lands only on the version the person was looking at. A step's engine
 * may change only to one Atomik can use here (an engine a step already had
 * may stay), and its settings follow the engine. Only the skill's maker moves
 * it between Just me and Workspace.
 */
export async function editSkill(id: unknown, patch: {
  expectedVersion?: unknown; name?: unknown; slug?: unknown; description?: unknown; scope?: unknown; note?: unknown; template?: unknown;
}, by: string): Promise<SkillView> {
  const { workspaceId, skill } = await visibleSkill(id, by);
  if (skill.status === "archived") throw new SkillError("This skill is archived. Restore it before editing it.", 409);
  if (patch.expectedVersion === undefined || Number(patch.expectedVersion) !== skill.version) throw new SkillError("This skill changed since you opened it. Reload it and try again.", 409);
  if (skill.version >= SKILL_LIMITS.versions) throw new SkillError(`This skill has ${SKILL_LIMITS.versions} versions, as many as one keeps. Save a run as a new skill to go on.`, 409);
  const current = await versionRow(workspaceId, skill.id, skill.version);
  if (!current) throw new SkillError("This skill could not be read. Try again.", 500);
  const before = readTemplate(current.template);
  const fields = fieldsOf(patch, { name: skill.name, slug: skill.slug, description: skill.description, scope: skill.scope });
  if (fields.scope !== skill.scope && skill.ownerId !== by) throw new SkillError("Only the person who made this skill can change who sees it.", 403);
  let template = before;
  if (patch.template !== undefined) {
    const next = checkTemplate(patch.template);
    const allowed = await engines();
    const had = new Set(before.steps.map((s) => s.model));
    template = {
      parameters: next.parameters,
      steps: next.steps.map((step, i) => {
        const engine = allowed.find((e) => e.id === step.model && e.kind === step.kind);
        if (!engine && !had.has(step.model)) throw new SkillError(`Choose an engine Atomik can use here for step ${i + 1}.`);
        const def = MODELS.find((m) => m.id === step.model);
        return step.kind !== "audio" && def ? { ...step, params: settingsOf(step.kind, fitStepParams(def, step.params)) } : step;
      }),
    };
  }
  const changed = JSON.stringify(template) !== JSON.stringify(before)
    || fields.name !== skill.name || fields.slug !== skill.slug || fields.description !== skill.description || fields.scope !== skill.scope;
  if (!changed) return viewOf(workspaceId, skill, by);
  if (fields.slug !== skill.slug) {
    const taken = await slugTaken(workspaceId, fields.slug, by, skill.id);
    if (taken) throw new SkillError(taken, 409);
  }
  const note = cleanLine(patch.note, SKILL_LIMITS.note) || null;
  const version = skill.version + 1;
  const at = Math.max(now(), skill.updatedAt + 1);
  const tx = await db().transaction("write");
  try {
    /* The version it replaces stays as it was; this lands only on the version the person opened. */
    const moved = await tx.execute({
      sql: `UPDATE ${SKILLS} SET name = ?, slug = ?, description = ?, scope = ?, version = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'active'`,
      args: [fields.name, fields.slug, fields.description, fields.scope, version, at, workspaceId, skill.id, skill.version],
    });
    if (!Number(moved.rowsAffected ?? 0)) throw new SkillError("This skill changed since you opened it. Reload it and try again.", 409);
    await tx.execute(versionInsert(workspaceId, skill.id, version, fields, template, note, by, at));
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    if (error instanceof SkillError) throw error;
    if (unique(error)) throw new SkillError("This skill changed since you opened it, or that command is taken. Reload it and try again.", 409);
    throw error;
  } finally {
    tx.close();
  }
  return viewOf(workspaceId, (await skillRow(workspaceId, skill.id))!, by);
}

/**
 * Archive hides a skill from the list and from `/` in the composer; Restore
 * brings it back as it was, every version with it. Nothing is deleted. A
 * second press of either changes nothing.
 */
export async function setSkillStatus(id: unknown, status: SkillStatus, by: string): Promise<SkillView> {
  const { workspaceId, skill } = await visibleSkill(id, by);
  if (skill.status === status) return viewOf(workspaceId, skill, by);
  if (status === "active" && (await activeCount(workspaceId)) >= SKILL_LIMITS.activeSkills) throw new SkillError(FULL, 409);
  const at = Math.max(now(), skill.updatedAt + 1);
  await db().execute({
    sql: `UPDATE ${SKILLS} SET status = ?, archived_by = ?, archived_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = ?`,
    args: [status, status === "archived" ? by : null, status === "archived" ? at : null, at, workspaceId, skill.id, skill.status],
  });
  return viewOf(workspaceId, (await skillRow(workspaceId, skill.id))!, by);
}

/* ── Running ───────────────────────────────────────────────────────────── */

/** Engine choices the person made for a run, by step position: `{ "1": "fal-ai/kling-video/v3/standard" }`. */
function choicesOf(value: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < SKILL_LIMITS.steps && typeof v === "string" && v.length <= 120) out.set(i, v);
  }
  return out;
}

/** A proposed step as a workspace reads it: credits where it pays in credits, its own dollars where it pays its vendors. */
function priced(step: Omit<SkillRunStep, "estCredits" | "estUsd">, usd: number | null): SkillRunStep {
  const shown = stepForBrowser({
    id: "", chatId: "", messageId: "", position: step.index, kind: step.kind, title: step.title, prompt: step.prompt, model: step.model,
    params: step.params, refs: [], status: "proposed", genId: null, estCostUsd: usd, error: null, createdAt: 0,
  });
  return { ...step, estCredits: shown.estCredits ?? null, estUsd: shown.estCredits === undefined ? shown.estCostUsd : null };
}

/**
 * Plan a run of a skill: its parameters filled in, each step on its engine
 * with its settings, priced as an estimate. A step whose engine is no longer
 * offered, or is switched off in Settings › Engines, is never moved on its
 * own: it waits, with the nearest allowed engine, until the person chooses
 * one (`engines`, by step position).
 *
 * `dryRun` answers the preview and writes nothing. Otherwise the steps are
 * filed in an Atomik chat — the one named, or a new one for the project —
 * as proposals, exactly as a planning turn files them: each waits at its
 * checkpoint for a live quote and a person's Continue. Nothing is claimed,
 * rendered or charged here, and no planning turn is billed.
 */
export async function runSkill(id: unknown, input: {
  values?: unknown; engines?: unknown; chatId?: unknown; projectId?: unknown; dryRun?: unknown;
}, by: string): Promise<SkillRunPreview | { chatId: string; messageId: string; steps: Step[] }> {
  const { workspaceId, skill } = await visibleSkill(id, by);
  if (skill.status === "archived") throw new SkillError("This skill is archived. Restore it to run it.", 409);
  const current = await versionRow(workspaceId, skill.id, skill.version);
  if (!current) throw new SkillError("This skill could not be read. Try again.", 500);
  const template = readTemplate(current.template);
  const values = parameterValues(template.parameters, input.values);
  const filled = fillTemplate(template, values);
  const allowed = await engines();
  const off = await enginesOff();
  const choices = choicesOf(input.engines);
  const problems: EngineProblem[] = [];
  const steps: SkillRunStep[] = [];
  /* Each step's estimate in the engine's dollars, read before anything is written (the write does database work only). */
  const estimates: (number | null)[] = [];
  for (const step of filled) {
    const chosen = choices.get(step.index);
    if (chosen !== undefined && !allowed.some((e) => e.id === chosen && e.kind === step.kind))
      throw new SkillError(`That engine can't make step ${step.index + 1} here. Choose another.`);
    const problem = chosen === undefined
      ? engineProblem({ ...template.steps[step.index], title: step.title }, step.index, allowed.map(choiceOf), off, CATALOGUE) : null;
    if (problem) problems.push(problem);
    const model = chosen ?? step.model;
    const def = MODELS.find((m) => m.id === model);
    const params: SkillSettings = step.kind !== "audio" && def ? settingsOf(step.kind, fitStepParams(def, step.params)) : step.params;
    const usd = problem ? null : await estimateStepUsd(step.kind, model, params as Record<string, unknown>);
    estimates.push(usd);
    steps.push(priced({ index: step.index, kind: step.kind, title: step.title, prompt: step.prompt, model, label: engineLabel(model, allowed), params,
      swapped: chosen !== undefined && chosen !== step.model }, usd));
  }
  if (input.dryRun === true) return { steps, problems, values };
  if (problems.length) throw new SkillError(problems.map(engineProblemText).join(" "), 409, problems);

  /* Where the plan is filed: the chat the person is in, or a new one for the project. */
  const chatId = typeof input.chatId === "string" && input.chatId ? input.chatId : null;
  let projectId: string | null = null;
  if (chatId) {
    const chat = (await db().execute({ sql: "SELECT id, project_id, status FROM atomik_chats WHERE id = ? AND deleted = 0", args: [chatId] })).rows[0] as Row | undefined;
    if (!chat) throw new SkillError("That chat is gone.", 404);
    if (chat.status === "running") throw new SkillError("Atomik is still planning in this chat. Run the skill when it has answered.", 409);
    projectId = text(chat.project_id);
  } else if (input.projectId != null && input.projectId !== "") {
    if (typeof input.projectId !== "string" || !PROJECT_ID.test(input.projectId)) throw new SkillError("Choose a saved project.");
    if (!(await db().execute({ sql: "SELECT 1 FROM projects WHERE id = ? LIMIT 1", args: [input.projectId] })).rows.length) throw new SkillError("That project is not in this workspace.", 404);
    projectId = input.projectId;
  }

  const said = describeValues(template.parameters, values);
  const swaps = steps.filter((s) => s.swapped).map((s) => `${s.title} on ${s.label}, as you chose`);
  const n = steps.length;
  const reply = [
    `Planned from the skill /${skill.slug} (version ${skill.version})${said ? `, with ${said}` : ""}.`,
    `${n} ${n === 1 ? "step" : "steps"}, each with its price. Nothing runs until you approve it.`,
    swaps.length ? `Engines you chose: ${swaps.join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  const activity = [`Used /${skill.slug}, version ${skill.version}`, template.parameters.length ? `Filled ${template.parameters.length} ${template.parameters.length === 1 ? "parameter" : "parameters"}` : "No parameters to fill", swaps.length ? `${swaps.length} ${swaps.length === 1 ? "engine" : "engines"} chosen by you` : "Kept every step's engine"];
  const command = `/${skill.slug}${template.parameters.length ? ` ${template.parameters.map((p) => `${p.key}: ${values[p.key]}`).join(" · ")}` : ""}`.slice(0, 8000);

  const ts = now();
  const target = chatId ?? newId("ach");
  const messageId = newId("amsg");
  await mediaMutation(async (tx) => {
    if (chatId) {
      /* Never under a turn still planning: the guard is the row itself. */
      const moved = await tx.execute({ sql: "UPDATE atomik_chats SET status = 'waiting', updated_at = ? WHERE id = ? AND deleted = 0 AND status <> 'running'", args: [ts + 1, chatId] });
      if (!Number(moved.rowsAffected ?? 0)) throw new SkillError("Atomik is still planning in this chat. Run the skill when it has answered.", 409);
    } else {
      await tx.execute({
        sql: `INSERT INTO atomik_chats (id, project_id, title, model, effort, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted)
              VALUES (?,?,?,?,?,?,'waiting',0,?,?,?,0)`,
        args: [target, projectId, skill.name.slice(0, 80), "auto", null, "ask", by, ts, ts + 1],
      });
    }
    await tx.execute({
      sql: `INSERT INTO atomik_messages (id, chat_id, role, text, activity, attachments, created_at) VALUES (?,?, 'user', ?, '[]', NULL, ?)`,
      args: [newId("amsg"), target, command, ts],
    });
    /* No model answered this: no planning turn is billed, so the reply carries no cost and names no model. */
    await tx.execute({
      sql: `INSERT INTO atomik_messages (id, chat_id, role, text, activity, ask, worked_ms, cost_usd, model, effort, created_at)
            VALUES (?,?, 'assistant', ?, ?, NULL, NULL, 0, '', NULL, ?)`,
      args: [messageId, target, reply.slice(0, 8000), JSON.stringify(activity), ts + 1],
    });
    /* Proposed, and only proposed: each waits at its checkpoint for a live quote and a person's Continue. */
    for (const [i, step] of steps.entries()) {
      await tx.execute({
        sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, est_cost_usd, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?, '[]', 'proposed', ?,?,?)`,
        args: [newId("astp"), target, messageId, step.index, step.kind, step.title, step.prompt, step.model, JSON.stringify(step.params), estimates[i], ts + 1, ts + 1],
      });
    }
  });
  const after = await getChat(target);
  return { chatId: target, messageId, steps: (after?.steps ?? []).filter((s) => s.messageId === messageId) };
}
