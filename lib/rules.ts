import { db, ready, now, id } from "./db";
import { getSetting, setSetting, invalidateSettings } from "./settings";
import { getPlatformLayer } from "./platform";
import { mergeRules, RULE_SCOPES, type PlatformRule, type EffectiveRule, type RuleScope, type RuleApply } from "./platformLayer";
import { archiveAndDelete } from "./archive";

/**
 * The rule library, per workspace (brief 2.5): the platform's rules, which
 * every workspace inherits and may switch off here, plus the workspace's
 * own — plain sentences the team writes, appended to every prompt in scope.
 * Tenant-scoped through db() and the workspace's settings.
 */
const MAX_TEXT = 400;

function rowToRule(r: Record<string, unknown>): PlatformRule {
  return { id: String(r.id), text: String(r.text ?? ""), scope: String(r.scope) as RuleScope, apply: String(r.apply) as RuleApply, on: Number(r.on ?? 1) === 1 };
}

export async function listWorkspaceRules(): Promise<PlatformRule[]> {
  await ready();
  const rs = await db().execute(`SELECT * FROM workspace_rules ORDER BY created_at ASC`);
  return (rs.rows as unknown as Record<string, unknown>[]).map(rowToRule);
}

/** Platform rule ids this workspace has switched off. */
export async function rulesOff(): Promise<string[]> {
  return (await getSetting("rulesOff")).split(",").map((s) => s.trim()).filter(Boolean);
}

/** Every rule in force here, each with its source. */
export async function effectiveRules(): Promise<EffectiveRule[]> {
  const [layer, own, off] = await Promise.all([getPlatformLayer(), listWorkspaceRules(), rulesOff()]);
  return mergeRules(layer.rules, own, off);
}

export function ruleProblem(input: { text?: unknown; scope?: unknown; apply?: unknown }): string | null {
  const text = String(input.text ?? "").trim();
  if (!text) return "A rule is a sentence.";
  if (text.length > MAX_TEXT) return `Keep a rule under ${MAX_TEXT} characters.`;
  if (input.scope !== undefined && !RULE_SCOPES.includes(String(input.scope) as RuleScope)) return "Scope must be one of: " + RULE_SCOPES.join(", ") + ".";
  if (input.apply !== undefined && !["writer", "prompt"].includes(String(input.apply))) return "A rule applies to the writer or to the prompt.";
  return null;
}

export async function addRule(input: { text: string; scope?: string; apply?: string }, by: string): Promise<PlatformRule> {
  await ready();
  const rid = id("rule");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO workspace_rules (id, text, scope, apply, "on", created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [rid, input.text.trim().slice(0, MAX_TEXT), RULE_SCOPES.includes(input.scope as RuleScope) ? String(input.scope) : "all",
           input.apply === "writer" ? "writer" : "prompt", 1, by, ts, ts],
  });
  return { id: rid, text: input.text.trim().slice(0, MAX_TEXT), scope: (RULE_SCOPES.includes(input.scope as RuleScope) ? input.scope : "all") as RuleScope, apply: input.apply === "writer" ? "writer" : "prompt", on: true };
}

export async function patchRule(rid: string, patch: { text?: string; scope?: string; apply?: string; on?: boolean }): Promise<PlatformRule | null> {
  await ready();
  const sets: string[] = []; const args: (string | number)[] = [];
  if (patch.text !== undefined) { sets.push("text = ?"); args.push(patch.text.trim().slice(0, MAX_TEXT)); }
  if (patch.scope !== undefined && RULE_SCOPES.includes(patch.scope as RuleScope)) { sets.push("scope = ?"); args.push(patch.scope); }
  if (patch.apply !== undefined && ["writer", "prompt"].includes(patch.apply)) { sets.push("apply = ?"); args.push(patch.apply); }
  if (patch.on !== undefined) { sets.push(`"on" = ?`); args.push(patch.on ? 1 : 0); }
  if (!sets.length) return null;
  sets.push("updated_at = ?"); args.push(now()); args.push(rid);
  await db().execute({ sql: `UPDATE workspace_rules SET ${sets.join(", ")} WHERE id = ?`, args });
  const rs = await db().execute({ sql: `SELECT * FROM workspace_rules WHERE id = ?`, args: [rid] });
  return rs.rows.length ? rowToRule(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function deleteRule(rid: string): Promise<boolean> {
  await ready();
  return (await archiveAndDelete(db(), "workspace_rules", `id = ?`, [rid])) > 0;
}

/** Switch a platform rule off (or back on) for this workspace only. */
export async function setPlatformRuleOff(ruleId: string, off: boolean, by: string): Promise<string[]> {
  const cur = await rulesOff();
  const next = off ? Array.from(new Set([...cur, ruleId])) : cur.filter((x) => x !== ruleId);
  await setSetting("rulesOff", next.join(","), by);
  invalidateSettings();
  return next;
}
