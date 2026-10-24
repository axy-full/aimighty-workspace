import { directTextCostUsd, isDirectText, textEngine, textKeyName, textVendor } from './openai-direct';
import { noAnswerOutcome, silentOutcome, type ProviderOutcome } from './providerOutcome';
import { TextNotSentError, textRun } from './textDirect';
import { engineMock } from './mock';
import { creditsApply } from "./credits";
import { atomikPublicResponse } from "./workbench/atomik-response";
import { workbenchScopeProblem } from "./workbench/request-scope";
import { billCredits } from "./creditTerms";
import { paidByPlatform } from "./platformSpend";
import { atomikEffortOptions, atomikReasoningRequest } from "./atomik-reasoning";
import { withRecoveryActivity } from './recovery';
import { db, ready, id as newId, now } from "./db";
import { platformDb, platformReady } from "./platform";
import { currentTenant, requireTenant } from "./tenant";
import { findModel, textCostUsd, textQuoteCostUsd, type CatalogModel } from "./catalog";
import { meter, meteredCharge } from "./meter";
import {
  reserveGenerationSpend,
  SpendReservationError,
  STALE_CLAIM_MS,
} from "./generationRequests";
import type { TextRun } from "./engines/types";
import type { Thinking } from "./atomikModelPolicy";
import { sampleWorkspaceRefusal } from "./demo/spend-guard.server";
import { noteModelCall, traceModelCall, type ModelCallMeta, type ModelSiteId } from "./modelTrace";

/** The least time a deadline-bound text job must still have for its provider call (runPaidText `deadline`). */
export const PAID_TEXT_MIN_PROVIDER_MS = 20_000;
/**
 * The prompt enhancer's own deadline for the provider (the browser waits 10 s, lib/shell/enhance-press.ts ENHANCE_CLIENT_MS, so an answer served at this deadline still arrives), and the
 * least of it that must be left to start a call. An enhancement is a few hundred tokens: a writer that has not answered by now is not going to, and the
 * person is better served by their own words at once than by a press that hangs.
 */
export const ENHANCE_DEADLINE_MS = 8_000;
export const ENHANCE_MIN_PROVIDER_MS = 3_000;
/** The extra output tokens a quick (low-effort) writer may think with on top of the visible answer: enough for a rewrite, never the 4,096 of a planning turn. */
export const QUICK_REASONING_TOKENS = 1_024;

/**
 * What a failed text job left on the workspace's bill, as the caller can show it without reading prose: `nothingBilled`, or `heldCredits` (the estimate
 * billed for now and returned by the cron's pass, 0 on a workspace's own key). Absent where the error says nothing about a charge.
 */
export type PaidTextBilling = { nothingBilled: true } | { heldCredits: number };
export class PaidTextError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public billing?: PaidTextBilling,
  ) {
    super(message);
    this.name = "PaidTextError";
  }
}
export function paidTextFailure(error: unknown): Response {
  if (error instanceof PaidTextError || error instanceof SpendReservationError || error instanceof TextNotSentError)
    return Response.json({ error: error.message, ...(error instanceof PaidTextError ? error.billing : {}) }, { status: error.status });
  throw error;
}
const configured = new Map<string, Promise<void>>();
async function paidTextReady() {
  const id = requireTenant().id;
  if (!configured.has(id))
    configured.set(
      id,
      (async () => {
        await ready();
        await db()
          .execute(`CREATE TABLE IF NOT EXISTS paid_text_jobs(id TEXT PRIMARY KEY, model TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, estimate_usd REAL NOT NULL, cost_usd REAL, response_json TEXT, effort TEXT, request_body TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reconcile_lease INTEGER)`);
        const columns = await db().execute("PRAGMA table_info(paid_text_jobs)");
        for (const [column, type] of [["effort", "TEXT"], ["request_body", "TEXT"], ["reconcile_lease", "INTEGER"]]) {
          if (columns.rows.some((row) => row.name === column)) continue;
          try { await db().execute(`ALTER TABLE paid_text_jobs ADD COLUMN ${column} ${type}`); }
          catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
        }
      })().catch((error) => {
        configured.delete(id);
        throw error;
      }),
    );
  await configured.get(id);
}

export function textRequestEstimate(
  model: CatalogModel,
  messages: unknown[],
  maxTokens: number,
  expandedQuote = false,
): number {
  // Includes wire-format overhead and UTF-8 text; base64 references also receive a conservative bound.
  const input = Buffer.byteLength(JSON.stringify(messages), "utf8") + 512;
  if (
    model.type !== "language" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 32768 ||
    (model.maxTokens != null && maxTokens > model.maxTokens) ||
    (model.contextWindow != null && input + maxTokens > model.contextWindow)
  )
    throw new PaidTextError(
      "This request exceeds the selected model's context or output limit. Shorten it or choose another model.",
      400,
    );
  // A direct call (any vendor) is quoted at its cold cache-write ceiling: it settles at usage × this snapshot.
  const estimate = textQuoteCostUsd(model, input, maxTokens, isDirectText(model.id));
  if (estimate == null || !Number.isFinite(estimate) || estimate <= 0)
    throw new PaidTextError(
      "This model has no confirmed price. Choose a priced language model.",
      503,
    );
  const fallback = expandedQuote ? 10 : 1;
  const configured = Number(process.env.ATOMIK_MAX_REQUEST_USD ?? fallback);
  const cap = Number.isFinite(configured) && configured > 0 ? Math.min(configured, expandedQuote ? 10 : 5) : fallback;
  if (estimate > cap)
    throw new PaidTextError(
      "This request exceeds the Atomik request budget. Use lower effort, fewer references, shorter context, or an economy model.",
      409,
    );
  return estimate;
}

export type PaidTextQuote = { model: string; effort: string; estimateCredits: number; estimateUsd?: number };
/** A quote as a person is sent it: its price only. The model and effort stay on the server (Amendment (iii) §E: never disclosed). */
export type PaidTextQuoteShown = Omit<PaidTextQuote, "model" | "effort"> & {
  /** The Thinking level a planning turn was quoted at, never a model or an effort (atomikQuoteResponse). */
  thinking?: Thinking;
};
type QuotedTextInput = {
  model: string; effort?: string; maxTokens: number; messages: unknown[]; maxCredits?: number;
  /**
   * Whether a run needs the ceiling its person approved (`maxCredits`). Default: whenever an effort is sent. Atomik's routes pass
   * whether the CALLER sent one: the Thinking setting's effort now applies to every turn (lib/atomikThinking.ts), and a run without
   * an approved ceiling keeps the old $1 safety cap below rather than the quoted-effort one.
   */
  ceilingRequired?: boolean;
  /** A short rewrite that must come back fast (the prompt enhancer): the lightest reasoning the model offers, with a small, fixed room to think. Quoted and run the same way. */
  quick?: boolean;
};
/** The lightest named effort a model offers, for a call that must answer inside a few seconds; none when it offers no control. */
export function quickEffort(model: CatalogModel): string | undefined {
  const offered = atomikEffortOptions(model).map((option) => option.value);
  return ["none", "minimal", "low"].find((value) => offered.includes(value));
}
async function compilePaidText(input: QuotedTextInput, override?: CatalogModel, quote = false) {
  const model = override ?? (await findModel(input.model));
  if (!model)
    throw new PaidTextError(
      "Choose a language model from the current catalog.",
      400,
    );
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 4000)
    throw new PaidTextError("Atomik visible output must be between 1 and 4000 tokens.", 400);
  let reasoning: ReturnType<typeof atomikReasoningRequest>;
  try {
    const quick = input.quick && input.effort === undefined ? quickEffort(model) : undefined;
    reasoning = atomikReasoningRequest(model, quick ?? input.effort, input.maxTokens);
    /* A quick call keeps its ceiling small: the answer's own room, and a fixed little for thinking, whatever the effort's usual allowance. */
    if (quick) reasoning = { ...reasoning, maxTokens: Math.min(reasoning.maxTokens, input.maxTokens + QUICK_REASONING_TOKENS) };
  }
  catch (error) { throw new PaidTextError(error instanceof Error ? error.message : "Choose a supported reasoning effort.", 400); }
  const usesImages = input.messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => part && typeof part === "object" && ["image", "image_url", "input_image"].includes(String(part.type)));
  });
  if (usesImages && !model.inputModalities?.includes("image"))
    throw new PaidTextError("This model cannot read image references. Choose a model with image input or remove the references.", 422);
  /* The quoted-effort safety cap holds for a quote, and for a run that carries (or must carry) the ceiling its person approved on one; a run that
     needs no ceiling (ceilingRequired false) and has none keeps the older cap. */
  const estimate = textRequestEstimate(model, input.messages, reasoning.maxTokens,
    input.effort !== undefined && (quote || input.maxCredits !== undefined || input.ceilingRequired !== false));
  const estimateCredits = paidByPlatform(textKeyName(input.model)) ? billCredits(estimate, "text") : 0;
  if (input.maxCredits !== undefined && (!Number.isInteger(input.maxCredits) || input.maxCredits < 0 || estimateCredits > input.maxCredits))
    throw new PaidTextError("The writing estimate changed. Review the new quote before running.", 409);
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: reasoning.maxTokens,
    ...reasoning.requestFields,
    messages: input.messages,
    response_format: { type: "json_object" },
    ...(Object.keys(reasoning.providerOptions).length ? { providerOptions: reasoning.providerOptions } : {}),
  });
  return { model, estimate, estimateCredits, requestBody };
}
/** A read-only quote: no request claim, reservation, provider call or spend row. */
export async function quotePaidText(input: QuotedTextInput, override?: CatalogModel): Promise<PaidTextQuote> {
  const compiled = await compilePaidText(input, override, true);
  return { model: compiled.model.id, effort: input.effort ?? "auto", estimateCredits: compiled.estimateCredits, estimateUsd: compiled.estimate };
}
/** A text job's quote as a member is sent it (the prompt writer's): its price, never the model or effort it was quoted at (Amendment (iii) §E;
 *  owner, 24 Oct 2026, item 14 (b)). */
export function paidTextQuoteResponse(quote: PaidTextQuote): Response {
  const { model: _model, effort: _effort, ...shown } = quote;
  void _model; void _effort;
  return Response.json(atomikPublicResponse(shown satisfies PaidTextQuoteShown, creditsApply(currentTenant()?.workspace)), { headers: { "Cache-Control": "no-store" } });
}
/**
 * An Atomik quote as a member is sent it: the price, and for a planning turn the Thinking level it was quoted at (High · Medium · Low,
 * the quote's head; lib/atomikThinking.ts › workspaceThinking). The thinking model and effort stay on the server (Amendment (iii) §E:
 * never disclosed). The level is a word for the person; it changes nothing about the price.
 */
export function atomikQuoteResponse(quote: PaidTextQuote, level?: { thinking: Thinking }): Response {
  const { model: _model, effort: _effort, ...shown } = quote;
  void _model; void _effort;
  return Response.json(atomikPublicResponse({ ...(shown satisfies PaidTextQuoteShown), ...(level ? { thinking: level.thinking } : {}) }, creditsApply(currentTenant()?.workspace)), { headers: { "Cache-Control": "no-store" } });
}
export function paidTextQuoteScopeFailure(req: Request): Response | null {
  const tenant = requireTenant();
  const actor = currentTenant()?.user;
  const scopeError = workbenchScopeProblem(req, tenant.id, actor?.id ?? "");
  if (scopeError) return Response.json({ error: scopeError }, { status: 409 });
  if (req.headers.get("X-Workspace-Id") && req.headers.get("X-Workspace-Id") !== tenant.id)
    return Response.json({ error: "Return to the workspace where this quote was requested." }, { status: 409 });
  const expected = req.headers.get("X-Actor-Email");
  if (expected && expected.toLowerCase() !== actor?.email.toLowerCase())
    return Response.json({ error: "Sign in with the account that requested this quote." }, { status: 409 });
  return null;
}
/** A settled job's credits as the meter wrote them; the same rule computed here if the platform record cannot be read. */
async function meteredCredits(id: string, fallback: number): Promise<number> {
  const workspaceId = currentTenant()?.workspace?.id;
  if (!workspaceId) return fallback;
  try {
    await platformReady();
    const row = (await platformDb().execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? AND id=?", args: [workspaceId, id] })).rows[0];
    if (row?.billed_credits != null) return Number(row.billed_credits);
  } catch { /* fall back to the meter's own rule */ }
  return fallback;
}
export function requestMaxCredits(value: unknown, required = false): number | undefined {
  if (value === undefined) {
    if (required) throw new PaidTextError("Review a writing quote before running with reasoning effort.", 409);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000)
    throw new PaidTextError("The writing credit ceiling is invalid. Request a new quote.", 400);
  return value;
}

/** A settled text job; a held one (`holdSettlement`) also carries the two ways to end it. */
export type PaidTextResult = {
  id: string; text: string; costUsd: number; engine: string; credits: number;
  /** What the meter billed the job at (what it used, never past its estimate), and what it cost past that, the platform's. */
  billedUsd?: number; overrunUsd?: number;
  finish?: () => Promise<PaidTextResult>;
  abandon?: (why: string) => Promise<PaidTextError>;
};
/** One bounded submission. No hidden model repair, provider failover, or transport retry. */
export async function runPaidText(
  input: {
    id?: string;
    model: string;
    messages: unknown[];
    maxTokens: number;
    effort?: string;
    maxCredits?: number;
    /** See QuotedTextInput. */
    ceilingRequired?: boolean;
    kind: string;
    projectId?: string | null;
    createdBy?: string | null;
    auth?: Record<string, string>;
    mock?: TextRun["mock"];
    timeoutMs?: number;
    /**
     * When the caller's own request must have answered (epoch ms). The
     * provider gets what is left of it; with less than
     * PAID_TEXT_MIN_PROVIDER_MS left the job is refused before anything is
     * written or reserved, so nothing is charged.
     */
    deadline?: number;
    /** The least of `deadline` that must be left to start the provider call (default PAID_TEXT_MIN_PROVIDER_MS). */
    minProviderMs?: number;
    /** See QuotedTextInput. */
    quick?: boolean;
    /**
     * The prompt enhancer's rule (the owner, 16 Oct 2026): whatever goes wrong, the workspace is not billed. A provider that never answered (cut off at
     * the deadline, the connection broke, the caller cancelled), one that answered with an error status or an unreadable reply, and an answer the caller
     * cannot use all settle as failed at zero: the reservation is released, the ledger line carries a provider outcome (billing unknown, for the platform
     * admin desk to reconcile with the provider's invoice) and the error says "Nothing billed". Without it (every other text job) a cut-off call or a 5xx
     * stays uncertain and bills its estimate until the cron's pass returns it.
     */
    freeOnFailure?: boolean;
    /** The caller gave up (a person pressed Cancel): the provider call is dropped, and with `freeOnFailure` nothing is billed. */
    signal?: AbortSignal;
    /**
     * Settle only when the caller says so. A good answer is returned with `finish` (charge it, as a plain success) and `abandon` (free: the caller could
     * not deliver it, e.g. a stream cut off midway). Until one is called the job stays `running` with its reservation held (the cron returns it if neither
     * ever is). The prompt enhancer streams its answer to the box and settles when the last word is out.
     */
    holdSettlement?: boolean;
    /** Chat messages already keep their own cost row. Failed calls still remain in paid_text_jobs and meter_events. */
    recordSpend?: boolean;
    /** The model call site this job is, for its span (lib/modelTrace.ts): ids and settings only. Nothing else here reads it. */
    trace?: ModelCallMeta & { site: ModelSiteId };
  },
  overrides: {
    model?: CatalogModel;
    submit?: (
      request: TextRun,
    ) => Promise<{ ok: boolean; status: number; text: string }>;
    /**
     * The caller's acceptance of the answer, judged BEFORE the job settles.
     * A refused answer (a rewrite that dropped a citation, an answer that is
     * not a prompt) is saved and paid to the provider, but settles the meter
     * at zero: the workspace is not charged for text it cannot use.
     */
    accept?: (text: string) => { ok: true } | { ok: false; reason: string };
  } = {},
): Promise<PaidTextResult> {
  if (input.trace) { const { site, ...meta } = input.trace; return traceModelCall(site, meta, () => runPaidTextJob(input, overrides)); }
  return runPaidTextJob(input, overrides);
}
async function runPaidTextJob(input: Parameters<typeof runPaidText>[0], overrides: NonNullable<Parameters<typeof runPaidText>[1]>): Promise<PaidTextResult> {
return await withRecoveryActivity('paid-text', async () => {

  /* The sample workspace spends nothing (lib/demo/spend-guard.server.ts): refused before a job row, a reservation or a call. */
  const sample = await sampleWorkspaceRefusal();
  if (sample) throw new PaidTextError(sample, 409);
  const { model, estimate, estimateCredits, requestBody } = await compilePaidText(input, overrides.model);
  /* A job whose estimate stands for now: what is held (credits on the platform's key, none on the workspace's own). */
  const held: PaidTextBilling = { heldCredits: estimateCredits };
  requestMaxCredits(input.maxCredits, input.ceilingRequired ?? input.effort !== undefined);
  await paidTextReady();
  const id = input.id ?? newId("text");
  /* The model call in scope (lib/modelTrace.ts) is told the job's id; nothing here changes for it. */
  noteModelCall({ runId: id, model: input.model });
  const prior = await db().execute({
    sql: `SELECT * FROM paid_text_jobs WHERE id=?`,
    args: [id],
  });
  if (prior.rows.length)
    throw new PaidTextError(
      "This text job already has a paid claim. Recover its saved result; it will not be submitted again.",
      409,
    );
  if (input.deadline !== undefined && input.deadline - Date.now() < (input.minProviderMs ?? PAID_TEXT_MIN_PROVIDER_MS))
    throw new PaidTextError("The text provider is slow to answer right now. Nothing was charged; try again in a moment.", 503, { nothingBilled: true });
  const ts = now();
  await db().execute({
    sql: `INSERT INTO paid_text_jobs(id,model,kind,status,estimate_usd,effort,request_body,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?)`,
    args: [id, input.model, input.kind, estimate, input.effort ?? null, isDirectText(input.model) ? JSON.stringify({ ...JSON.parse(requestBody), pricingModel: model }) : requestBody, ts, ts],
  });
  const event = {
    id,
    kind: "text" as const,
    /* The vendor that is paid: its own name for a direct door, 'vercel' for the gateway. */
    engine: textEngine(input.model),
    model: input.model,
    projectId: input.projectId ?? null,
    createdBy: input.createdBy ?? currentTenant()?.user?.id ?? "",
  };
  await reserveGenerationSpend(
    { ...event, status: "running", engineCostUsd: estimate },
    { token: currentTenant()?.token },
  );
  let submitted = false;
  /* Set the moment the provider replies in any way (a status, an error, a body): from then on the call was answered. */
  let answered = false;
  /* What becomes of an unconfirmed submission's estimate: returned by the cron's pass (reconcilePaidTextJobs),
     or, on the workspace's own key, nothing was charged in credits to return. */
  const afterwards = paidByPlatform(textKeyName(input.model))
    ? "its estimated credits are returned to your balance automatically, usually within a few hours"
    : "nothing more is charged";
  /* Every settlement below applies only to a job still in flight: one the cron's pass already refunded
     (reconcilePaidTextJobs) is never overwritten or charged again by a request that answers late. */
  const settle = async (sql: string, args: (string | number | null)[]) =>
    (await db().execute({ sql: `${sql} AND status IN ('queued','running')`, args })).rowsAffected > 0;
  /* The enhancer's free failure (`freeOnFailure`): failed at zero, the reservation released, and the ledger line says what is known: billing unknown. Only a
     job this step settled is zeroed and metered; one the cron's pass already settled is left as it did. */
  const writer = textVendor(input.model);
  const freeFailure = async (outcome: ProviderOutcome, message: string, status = 502): Promise<PaidTextError> => {
    const moved = await settle(`UPDATE paid_text_jobs SET status='failed',cost_usd=0,updated_at=? WHERE id=?`, [now(), id]).catch(() => false);
    if (moved) {
      await db().execute({ sql: `UPDATE atomik_spend SET cost_usd=0 WHERE id=?`, args: [id] }).catch(() => {});
      await meter({ ...event, status: "failed", engineCostUsd: 0, providerOutcome: outcome });
    }
    return new PaidTextError(message, status, { nothingBilled: true });
  };
  try {
    if (input.recordSpend !== false)
      await db().execute({
        sql: `INSERT INTO atomik_spend(id,kind,model,cost_usd,user_id,created_at,ledger) VALUES(?,?,?,?,?,?,?)`,
        args: [id, input.kind, input.model, estimate, event.createdBy, ts, event.engine],
      });
    await db().execute({
      sql: `UPDATE paid_text_jobs SET status='running',updated_at=? WHERE id=?`,
      args: [now(), id],
    });
    const submit = overrides.submit ?? textRun;
    submitted = true;
    const response = await submit({
      body: requestBody,
      auth: input.auth,
      mock: input.mock,
      signal: input.signal,
      timeoutMs: input.deadline !== undefined
        ? Math.max(1_000, Math.min(input.timeoutMs ?? Infinity, input.deadline - Date.now()))
        : input.timeoutMs ?? 270_000,
    });
    answered = true;
    if (!response.ok) {
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(
        response.status,
      );
      if (input.freeOnFailure)
        throw await freeFailure(silentOutcome(writer, "run", rejected ? "rejected" : "provider_error", `The writer answered with HTTP ${response.status}. Not billed to the workspace; whether the provider billed the platform is unknown.`),
          rejected ? `The text provider declined this request (${response.status}). No generation credits were charged.` : "The writer couldn't answer this time. Nothing billed.");
      const settled = await settle(`UPDATE paid_text_jobs SET status=?,cost_usd=?,updated_at=? WHERE id=?`,
        [rejected ? "failed" : "uncertain", rejected ? 0 : estimate, now(), id]);
      if (settled && rejected) {
        await db().execute({
          sql: `UPDATE atomik_spend SET cost_usd=0 WHERE id=?`,
          args: [id],
        });
        await meter({ ...event, status: "failed", engineCostUsd: 0 });
      } else if (settled)
        await meter({ ...event, status: "failed", engineCostUsd: estimate });
      throw new PaidTextError(
        rejected
          ? `The text provider declined this request (${response.status}). No generation credits were charged.`
          : `The text provider returned an uncertain result. It will not be sent again, and ${afterwards}.`,
        502,
        rejected ? { nothingBilled: true } : held,
      );
    }
    let json: {
      usage?: {
        cost?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: unknown;
      };
      choices?: { message?: { content?: string } }[];
    };
    try {
      json = JSON.parse(response.text);
    } catch {
      if (input.freeOnFailure)
        throw await freeFailure(silentOutcome(writer, "run", "unreadable", "The writer's reply could not be read. Not billed to the workspace; whether the provider billed the platform is unknown."),
          "The writer's reply couldn't be read. Nothing billed.");
      throw new PaidTextError(
        `The text provider returned an unreadable result. It will not be sent again, and ${afterwards}.`,
        502,
        held,
      );
    }
    const content = json?.choices?.[0]?.message?.content;
    /* Every direct door (OpenAI, Anthropic, Google, xAI) replies without `usage.cost`: priced from its usage × the saved snapshot. */
    const direct = isDirectText(input.model);
    let cost = direct && !engineMock() ? directTextCostUsd(model, json?.usage) : Number(json?.usage?.cost);
    if (direct && !engineMock() && (cost == null || !Number.isFinite(cost) || cost > estimate + 0.00000001)) {
      await settle('UPDATE paid_text_jobs SET response_json=?,updated_at=? WHERE id=?', [response.text, now(), id]);
      throw new PaidTextError('Direct provider usage is missing, invalid, or outside the approved price snapshot. The paid answer is saved and its reservation is retained for review.');
    }
    if (cost == null || !Number.isFinite(cost) || cost < 0) {
      const inputTokens = Number(json?.usage?.prompt_tokens);
      const outputTokens = Number(json?.usage?.completion_tokens);
      cost =
        Number.isFinite(inputTokens) &&
        inputTokens >= 0 &&
        Number.isFinite(outputTokens) &&
        outputTokens >= 0
          ? (textCostUsd(model, inputTokens, outputTokens) ?? estimate)
          : estimate;
    }
    /* What this answer cost the platform, as just worked out, for the model call's span (lib/modelTrace.ts). */
    noteModelCall({ costUsd: cost });
    /* An empty answer is refused like any other unusable one. It used to
       settle as a success and bill the workspace in full while the person was
       told the model returned nothing they could use. */
    const verdict = typeof content !== "string" || !content.trim()
      ? { ok: false as const, reason: "The model completed, but returned no usable text." }
      : overrides.accept ? overrides.accept(content) : null;
    if (verdict && !verdict.ok) {
      /* Paid to the provider, refused by the caller: saved, settled at zero for the workspace. */
      if (await settle(`UPDATE paid_text_jobs SET status='refused',cost_usd=?,response_json=?,updated_at=? WHERE id=?`, [cost, response.text, now(), id])) {
        await db().execute({ sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`, args: [cost, id] });
        await meter({ ...event, status: "failed", engineCostUsd: 0, ...(input.freeOnFailure ? { providerOutcome: silentOutcome(writer, "run", "unusable", "The writer's answer was not a usable prompt. Not billed to the workspace; the provider's own bill for it is unknown.") } : {}) });
      }
      throw new PaidTextError(`${verdict.reason} Nothing was charged.`, 502, { nothingBilled: true });
    }
    /* Defence in depth (money review 3): the workspace is billed what the job used, never past the estimate its person approved, on any door.
       A direct door already refuses usage past it (above); a gateway reply's usage.cost is not capped by anything else. What it really cost
       stays in the job row and atomik_spend for the platform admin; the meter bills the capped figure and records the rest as the platform's. */
    const billedUsd = Math.min(cost, estimate), overrunUsd = cost > estimate ? cost - estimate : 0;
    const finish = async (): Promise<PaidTextResult> => {
      if (!(await settle(`UPDATE paid_text_jobs SET status='succeeded',cost_usd=?,response_json=?,updated_at=? WHERE id=?`, [cost, response.text, now(), id])))
        /* Answered after the cron's pass refunded it: not charged again, and not delivered as if it had been paid for. */
        throw new PaidTextError(`The text provider answered too late; this request had already ended. It will not be sent again, and ${afterwards}.`);
      await db().execute({
        sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`,
        args: [cost, id],
      });
      await meter({ ...event, status: "succeeded", engineCostUsd: billedUsd, ...(overrunUsd > 0 ? { overrunUsd } : {}) });
      return {
        id,
        text: content as string,
        costUsd: cost,
        billedUsd, overrunUsd,
        /* The ledger this job was reserved and settled on (its meter engine), for the caller's own rows. */
        engine: event.engine,
        /* What the ledger billed, for the screen that shows it: credits are
           what a workspace on credits sees, never the vendor's dollars. */
        credits: await meteredCredits(id, paidByPlatform(textKeyName(input.model)) ? billCredits(billedUsd, "text") : 0),
      };
    };
    if (!input.holdSettlement) return await finish();
    /* Held: the answer is in hand and paid to the provider, but the workspace is charged only when the caller has delivered it (`finish`). A caller that
       could not (a cancelled press, a stream cut off midway) abandons it: failed at zero, "billing unknown" on the platform's own line. */
    const abandon = async (why: string) => {
      const error = await freeFailure(silentOutcome(writer, "run", "not_delivered", `${why} Not billed to the workspace; the provider's own bill for the answer is the platform's.`), "The answer wasn't delivered. Nothing billed.", 499);
      return error;
    };
    return { id, text: content as string, costUsd: cost, engine: event.engine, credits: paidByPlatform(textKeyName(input.model)) ? billCredits(billedUsd, "text") : 0, finish, abandon };
  } catch (error) {
    const record = (
      await db()
        .execute({
          sql: `SELECT status,cost_usd FROM paid_text_jobs WHERE id=?`,
          args: [id],
        })
        .catch(() => ({ rows: [] }))
    ).rows[0];
    /* The enhancer is never billed for a failure of any kind: a refusal of its own that left the job running (a usage figure it could not price) is free too. */
    if (error instanceof PaidTextError && input.freeOnFailure && record?.status === "running")
      throw await freeFailure(silentOutcome(writer, "run", "failed", `${error.message.slice(0, 160)} Not billed to the workspace; the provider's own bill is unknown.`), "The writer couldn't answer this time. Nothing billed.", error.status);
    if (error instanceof PaidTextError && record?.status === "running") {
      if (await settle(`UPDATE paid_text_jobs SET status='uncertain',cost_usd=?,updated_at=? WHERE id=?`, [estimate, now(), id]).catch(() => false)) {
        await meter({ ...event, status: "failed", engineCostUsd: estimate });
        error.billing ??= held;
      }
    }
    /* Already refunded by the cron's pass: nothing here may charge it again. */
    if (!(error instanceof PaidTextError) && record?.status === "refunded")
      throw new PaidTextError(`The text request was interrupted after submission. It will not be sent again, and ${afterwards}.`);
    /* No reply at all, and the caller says that costs nothing (the prompt enhancer): failed at zero, the reservation released, "Nothing billed". */
    if (!(error instanceof PaidTextError) && input.freeOnFailure && submitted && !answered && record?.status === "running") {
      /* The ledger line says what is known: the provider never answered (or the person cancelled), so whether it billed the platform is unknown, for the platform admin desk to reconcile against the provider's invoice. */
      const cancelled = input.signal?.aborted === true;
      throw await freeFailure(noAnswerOutcome(writer, "run", cancelled ? "The person cancelled before the writer answered. Not billed to the workspace; whether the provider billed the platform is unknown." : "The writer did not answer inside the enhancer's deadline. Not billed to the workspace; whether the provider billed the platform is unknown."),
        cancelled ? "Cancelled. Nothing billed." : "The writer didn't answer in time. Nothing billed.", cancelled ? 499 : 504);
    }
    /* Answered, then something else broke before the job settled (a write that failed, an error of our own): the enhancer is still never billed for it. */
    if (!(error instanceof PaidTextError) && input.freeOnFailure && answered && record?.status === "running")
      throw await freeFailure(silentOutcome(writer, "run", "failed", "The writer answered, but the job could not be settled. Not billed to the workspace; the provider's own bill is unknown."),
        "The writer couldn't answer this time. Nothing billed.");
    if (!(error instanceof PaidTextError)) {
      const completed = record?.status === "succeeded";
      const cost = completed
        ? Number(record.cost_usd)
        : submitted
          ? estimate
          : 0;
      const moved = await settle(`UPDATE paid_text_jobs SET status=?,cost_usd=?,updated_at=? WHERE id=?`, [submitted ? "uncertain" : "failed", cost, now(), id])
        .catch(() => false);
      await db()
        .execute({
          sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`,
          args: [cost, id],
        })
        .catch(() => {});
      /* A job another step already settled (refused, declined, refunded) is not metered again here. A completed one is billed what it used,
         never past its estimate (as finish() bills it; money review 4): the raw cost stays in the job row, the rest is the platform's. */
      if (completed || moved)
        await meter({
          ...event,
          status: completed ? "succeeded" : "failed",
          engineCostUsd: Math.min(cost, estimate),
          ...(cost > estimate ? { overrunUsd: cost - estimate } : {}),
        });
      /* An unconfirmed submission is billed its estimate for now; reconcilePaidTextJobs returns it once no request can still be answering. */
      throw new PaidTextError(
        completed
          ? "The text request finished, but its answer could not be returned. It was charged what it cost and will not be sent again."
          : submitted
            ? `The text request was interrupted after submission. It will not be sent again, and ${afterwards}.`
            : "The text request could not be prepared. No generation credits were spent.",
        502,
        completed ? undefined : submitted ? held : { nothingBilled: true },
      );
    }
    throw error;
  }

});
}

/**
 * No request can still be answering a text job this long after it was last
 * touched: the provider call is cut off at 270 s at most (runPaidText), and
 * no function runs past 800 s (STALE_CLAIM_MS is longer than both, with more
 * than 15 minutes to spare).
 */
export const PAID_TEXT_RECONCILE_AFTER_MS = STALE_CLAIM_MS;
/** One pass's hold on a job while it settles it; a pass that dies leaves it to the next one after this. */
const PAID_TEXT_RECONCILE_LEASE_MS = 5 * 60_000;

/**
 * The cron's pass over text jobs nothing will finish (app/api/cron/sync):
 * one whose provider call was cut off (`uncertain`, its estimate billed), one
 * whose process was killed mid-call (`running`, its estimate reserved) and one
 * killed before it was sent (`queued`). No provider lookup can confirm what
 * such a call produced (the job keeps no provider id), so each is refunded:
 * its meter event settles as failed at 0 credits and the job reads
 * `refunded`. A job whose answer was delivered (`succeeded`) is never
 * touched, nor one whose provider answer is saved for review (direct usage
 * outside the approved price, `response_json` kept).
 *
 * Exactly once: a pass first takes the job with a conditional UPDATE (a
 * lease), so a concurrent pass skips it; the meter's settlement sets the
 * event's charge (it never adds), and the job is marked under the same lease.
 * A pass that dies in between leaves the lease to expire and the next pass
 * settles the same event to the same figure.
 */
export async function reconcilePaidTextJobs(options: { limit?: number; deadlineAt?: number } = {}): Promise<{ refunded: number; released: number; failed: number }> {
  const report = { refunded: 0, released: 0, failed: 0 };
  await ready();
  const table = await db().execute("SELECT name FROM sqlite_schema WHERE type='table' AND name='paid_text_jobs'");
  if (!table.rows.length) return report;
  await paidTextReady();
  const at = now();
  const cutoff = at - PAID_TEXT_RECONCILE_AFTER_MS;
  const due = await db().execute({
    sql: `SELECT id,model,status FROM paid_text_jobs
          WHERE status IN ('queued','running','uncertain') AND response_json IS NULL AND updated_at < ?
            AND (reconcile_lease IS NULL OR reconcile_lease < ?)
          ORDER BY updated_at LIMIT ?`,
    args: [cutoff, at, options.limit ?? 10],
  });
  for (const job of due.rows) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break;
    const id = String(job.id);
    const status = String(job.status);
    /* One job that cannot be settled now (its lease then expires) does not hold up the others. */
    try {
      const lease = now() + PAID_TEXT_RECONCILE_LEASE_MS;
      const taken = await db().execute({
        sql: `UPDATE paid_text_jobs SET reconcile_lease=?
              WHERE id=? AND status=? AND response_json IS NULL AND updated_at < ? AND (reconcile_lease IS NULL OR reconcile_lease < ?)`,
        args: [lease, id, status, cutoff, now()],
      });
      if (!taken.rowsAffected) continue;
      const charge = await meteredCharge(id);
      /* Billed as delivered after all: never refunded. */
      if (charge?.status === "succeeded") continue;
      /* No meter event: it was never reserved (killed before), so there is nothing to return. */
      if (charge)
        await meter({ id, kind: "text", engine: textEngine(String(job.model)), model: String(job.model), status: "failed", engineCostUsd: 0 }, { critical: true });
      const marked = await db().execute({
        sql: `UPDATE paid_text_jobs SET status='refunded',updated_at=? WHERE id=? AND status=? AND reconcile_lease=?`,
        args: [now(), id, status, lease],
      });
      if (!marked.rowsAffected) continue;
      if (status === "uncertain") report.refunded++;
      else report.released++;
    } catch {
      report.failed++;
    }
  }
  return report;
}
