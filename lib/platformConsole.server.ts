import { platformDb, platformReady, getPlatformLayer, getWorkspace } from "@/lib/platform";
import { creditStateFor } from "@/lib/credits";
import { isHouseWorkspace } from "@/lib/houseWorkspace";
import { houseCapViewFor } from "@/lib/houseCap";
import type { HouseCapView } from "@/lib/houseCapText";
import { asPlanId, planById, DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { readPlatformAudit, type PlatformAuditLine } from "@/lib/platformAudit";
import { deployedCommit } from "@/lib/deployment";
import { failedSavesCounts } from "@/lib/platformFailedSaves";
import type { RiskCounts } from "@/lib/atRiskWindow";
import { staticCatalog, type CatalogModel } from "@/lib/catalog";
import { TEXT_JOBS, TEXT_JOB_LABELS, TEXT_MODEL_IDS, modelOfKind, type TextJob } from "@/lib/platformLayer";
import { modelConfigured } from "@/lib/providers";
import { workbenchGenerationModels, workbenchRate } from "@/lib/workbench/media-quote";
import { PLATFORM_TEXT_PROVIDER_LABELS } from "@/lib/platformConsole";

/**
 * What the platform console reads that no existing admin route already answers (the owner's desk only: every route that
 * calls these checks `requireSuperAdmin` first). It adds no money logic: a grant, a pause, an invitation and a switch
 * all go through the routes and functions they went through before (app/api/admin/*), and every price here is read through
 * the same price paths the product uses.
 */

/** The calendar month (UTC) `now` falls in: its first millisecond, and the first millisecond of the next. */
const monthOf = (now: number): [number, number] => { const d = new Date(now); return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)]; };

export type ConsoleOverview = {
  workspaces: number;
  people: number;
  /** Free credits given this calendar month (UTC): the welcome grant, management's, the plan's included credits. A bought pack is not a grant. */
  grantedThisMonth: number;
  invitesPending: number;
  requestsWaiting: number;
  /** Succeeded renders whose file never reached storage, across every workspace: at risk (made in the last 72 hours) and lost (older), lib/platformFailedSaves.ts. Null when the count could not be read. */
  failedSaves: RiskCounts | null;
  /** The commit this server runs, short. Null when the deployment names none. */
  commit: string | null;
};

export async function consoleOverview(at = Date.now()): Promise<ConsoleOverview> {
  await platformReady();
  const p = platformDb();
  const [ws, people, granted, invites, requests, failed] = await Promise.all([
    p.execute(`SELECT COUNT(*) AS n FROM workspaces WHERE deleted_at IS NULL`),
    p.execute(`SELECT COUNT(DISTINCT m.account_id) AS n FROM memberships m
               JOIN workspaces w ON w.id = m.workspace_id JOIN accounts a ON a.id = m.account_id
               WHERE m.disabled = 0 AND w.deleted_at IS NULL AND a.disabled = 0 AND a.deleted_at IS NULL`),
    p.execute({ sql: `SELECT COALESCE(SUM(credits),0) AS n FROM credit_grants WHERE created_at >= ? AND created_at < ? AND credits > 0 AND kind <> 'purchase'`, args: monthOf(at) }),
    p.execute({ sql: `SELECT COUNT(*) AS n FROM signup_invites WHERE used_at IS NULL AND expires_at > ?`, args: [at] }),
    p.execute(`SELECT COUNT(*) AS n FROM access_requests WHERE handled_at IS NULL`),
    failedSavesCounts().catch(() => null),
  ]);
  const n = (rs: { rows: unknown[] }) => Number((rs.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  return {
    workspaces: n(ws), people: n(people), grantedThisMonth: n(granted), invitesPending: n(invites), requestsWaiting: n(requests),
    failedSaves: failed, commit: deployedCommit()?.slice(0, 7) ?? null,
  };
}

export type SheetMember = { name: string; email: string; role: string; lastSeen: number | null; disabled: boolean };
export type SheetGrant = { at: number; credits: number; kind: string; note: string };
export type WorkspaceSheet = {
  id: string; name: string; house: boolean;
  plan: PlanDef | null;
  paused: boolean; pausedReason: string | null;
  members: SheetMember[];
  /** Newest first; empty for the house workspace, which is never billed in credits. */
  history: SheetGrant[];
  balance: number | null;
  /** The owner's own changes to this workspace, newest first (lib/platformAudit.ts). */
  changes: PlatformAuditLine[];
  /** The house's monthly engine cap and this month so far (lib/houseCap.ts); null for every other workspace. */
  houseCap: HouseCapView | null;
};

/** One workspace for the console's side sheet, or null when there is none. */
export async function workspaceSheet(id: string): Promise<WorkspaceSheet | null> {
  const ws = await getWorkspace(id);
  if (!ws) return null;
  const p = platformDb();
  const house = isHouseWorkspace(ws);
  const [members, grants, layer, state, changes, row] = await Promise.all([
    p.execute({ sql: `SELECT a.name, a.email, a.last_seen, m.role, m.disabled FROM memberships m JOIN accounts a ON a.id = m.account_id
                      WHERE m.workspace_id = ? AND a.deleted_at IS NULL ORDER BY m.created_at LIMIT 200`, args: [id] }),
    house ? Promise.resolve({ rows: [] as unknown[] }) : p.execute({ sql: `SELECT credits, kind, note, created_at FROM credit_grants WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`, args: [id] }),
    getPlatformLayer().catch(() => null),
    creditStateFor(ws).catch(() => null),
    readPlatformAudit(p, { workspaceId: id, limit: 10 }),
    p.execute({ sql: `SELECT plan_id FROM workspaces WHERE id = ?`, args: [id] }),
  ]);
  const planId = asPlanId((row.rows[0] as { plan_id?: unknown } | undefined)?.plan_id);
  return {
    id: ws.id, name: ws.name, house,
    plan: planId ? planById(layer?.plans ?? DEFAULT_PLANS, planId) : null,
    paused: ws.suspendedAt != null, pausedReason: ws.suspendedReason ?? null,
    members: (members.rows as unknown as Record<string, unknown>[]).map((r) => ({
      name: String(r.name ?? ""), email: String(r.email ?? ""), role: String(r.role ?? "member"),
      lastSeen: r.last_seen == null ? null : Number(r.last_seen), disabled: Number(r.disabled ?? 0) === 1,
    })),
    history: (grants.rows as unknown as Record<string, unknown>[]).map((r) => ({ at: Number(r.created_at), credits: Number(r.credits), kind: String(r.kind), note: String(r.note ?? "") })),
    balance: state ? state.balance : null,
    changes,
    houseCap: house ? await houseCapViewFor(ws.allowanceUsd).catch(() => null) : null,
  };
}

/* ── AI models ─────────────────────────────────────────────────────────── */

export type ConsoleEngine = { id: string; label: string; kind: "video" | "image"; credits: number; resolution: string; duration: number | null };
export type ConsoleTextModel = { id: string; name: string; provider: string; providerLabel: string; inputUsdPerM: number; outputUsdPerM: number };
export type ConsoleModels = {
  engines: ConsoleEngine[];
  defaults: { video: string; image: string };
  text: { jobs: { job: TextJob; label: string; model: string }[]; models: ConsoleTextModel[] };
};

const perMillion = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null; };

/** A text model as the console lists it, priced from the checked-in catalogue (lib/modelCatalog.json, the price table); null when it states no price. */
export function textModelRow(m: CatalogModel): ConsoleTextModel | null {
  const inputUsdPerM = perMillion(m.pricing?.input), outputUsdPerM = perMillion(m.pricing?.output);
  if (inputUsdPerM == null || outputUsdPerM == null) return null;
  return { id: m.id, name: m.name, provider: m.owner, providerLabel: PLATFORM_TEXT_PROVIDER_LABELS[m.owner] ?? m.owner, inputUsdPerM, outputUsdPerM };
}

/**
 * What the owner may pick as a default: engines in the registry with a working key, priced by the product's own rate path
 * (credits, at the engine's composer settings); and text models that can be saved as a job's model (lib/platformLayer.ts ›
 * TEXT_MODEL_IDS) and have a working key (lib/catalog.ts › staticCatalog offers only what the keys can call), priced from the
 * catalogue snapshot. A model with no key, or no price, is not listed.
 */
export async function consoleModels(): Promise<ConsoleModels> {
  const layer = await getPlatformLayer();
  const engines: ConsoleEngine[] = [];
  for (const model of workbenchGenerationModels()) {
    if ((model.kind !== "video" && model.kind !== "image") || model.retired || model.marketing || model.soulIdentity || model.cinemaStudio) continue;
    if (!modelConfigured(model) || !modelOfKind(model.id, model.kind)) continue;
    const rate = workbenchRate(model);
    if (!rate) continue;
    engines.push({ id: model.id, label: model.label, kind: model.kind, credits: rate.credits, resolution: rate.resolution, duration: rate.duration });
  }
  const listed = new Set(TEXT_MODEL_IDS);
  const models = staticCatalog().filter((m) => m.type === "language" && listed.has(m.id)).flatMap((m) => { const row = textModelRow(m); return row ? [row] : []; });
  return {
    engines,
    defaults: { video: layer.models.video, image: layer.models.image },
    text: { jobs: TEXT_JOBS.map((job) => ({ job, label: TEXT_JOB_LABELS[job], model: layer.models.text[job] })), models },
  };
}
