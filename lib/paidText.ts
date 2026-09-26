import { textVendor, directTextCostUsd } from './openai-direct';
import { engineMock } from './mock';
import { creditsApply } from "./credits";
import { atomikPublicResponse } from "./workbench/atomik-response";
import { workbenchScopeProblem } from "./workbench/request-scope";
import { billCredits } from "./creditTerms";
import { paidByPlatform } from "./platformSpend";
import { atomikReasoningRequest } from "./atomik-reasoning";
import { withRecoveryActivity } from './recovery';
import { db, ready, id as newId, now } from "./db";
import { platformDb, platformReady } from "./platform";
import { currentTenant, requireTenant } from "./tenant";
import { findModel, textCostUsd, textQuoteCostUsd, type CatalogModel } from "./catalog";
import { engineFor } from "./engines";
import { meter } from "./meter";
import {
  reserveGenerationSpend,
  SpendReservationError,
} from "./generationRequests";
import type { TextRun } from "./engines/types";

export class PaidTextError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "PaidTextError";
  }
}
export function paidTextFailure(error: unknown): Response {
  if (error instanceof PaidTextError || error instanceof SpendReservationError)
    return Response.json({ error: error.message }, { status: error.status });
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
      status TEXT NOT NULL, estimate_usd REAL NOT NULL, cost_usd REAL, response_json TEXT, effort TEXT, request_body TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
        const columns = await db().execute("PRAGMA table_info(paid_text_jobs)");
        for (const column of ["effort", "request_body"]) {
          if (columns.rows.some((row) => row.name === column)) continue;
          try { await db().execute(`ALTER TABLE paid_text_jobs ADD COLUMN ${column} TEXT`); }
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
  const estimate = textQuoteCostUsd(model, input, maxTokens, textVendor(model.id) === 'openai');
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
type QuotedTextInput = { model: string; effort?: string; maxTokens: number; messages: unknown[]; maxCredits?: number };
async function compilePaidText(input: QuotedTextInput, override?: CatalogModel) {
  const model = override ?? (await findModel(input.model));
  if (!model)
    throw new PaidTextError(
      "Choose a language model from the current catalog.",
      400,
    );
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 4000)
    throw new PaidTextError("Atomik visible output must be between 1 and 4000 tokens.", 400);
  let reasoning: ReturnType<typeof atomikReasoningRequest>;
  try { reasoning = atomikReasoningRequest(model, input.effort, input.maxTokens); }
  catch (error) { throw new PaidTextError(error instanceof Error ? error.message : "Choose a supported reasoning effort.", 400); }
  const usesImages = input.messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => part && typeof part === "object" && ["image", "image_url", "input_image"].includes(String(part.type)));
  });
  if (usesImages && !model.inputModalities?.includes("image"))
    throw new PaidTextError("This model cannot read image references. Choose a model with image input or remove the references.", 422);
  const estimate = textRequestEstimate(model, input.messages, reasoning.maxTokens, input.effort !== undefined);
  const estimateCredits = paidByPlatform(textVendor(input.model)) ? billCredits(estimate, "text") : 0;
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
  const compiled = await compilePaidText(input, override);
  return { model: compiled.model.id, effort: input.effort ?? "auto", estimateCredits: compiled.estimateCredits, estimateUsd: compiled.estimate };
}
export function paidTextQuoteResponse(quote: PaidTextQuote): Response {
  return Response.json(atomikPublicResponse(quote, creditsApply(currentTenant()?.workspace)), { headers: { "Cache-Control": "no-store" } });
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

/** One bounded submission. No hidden model repair, provider failover, or transport retry. */
export async function runPaidText(
  input: {
    id?: string;
    model: string;
    messages: unknown[];
    maxTokens: number;
    effort?: string;
    maxCredits?: number;
    kind: string;
    projectId?: string | null;
    createdBy?: string | null;
    auth?: Record<string, string>;
    mock?: TextRun["mock"];
    timeoutMs?: number;
    /** Chat messages already keep their own cost row. Failed calls still remain in paid_text_jobs and meter_events. */
    recordSpend?: boolean;
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
) {
return await withRecoveryActivity('paid-text', async () => {

  const { model, estimate, requestBody } = await compilePaidText(input, overrides.model);
  requestMaxCredits(input.maxCredits, input.effort !== undefined);
  await paidTextReady();
  const id = input.id ?? newId("text");
  const prior = await db().execute({
    sql: `SELECT * FROM paid_text_jobs WHERE id=?`,
    args: [id],
  });
  if (prior.rows.length)
    throw new PaidTextError(
      "This text job already has a paid claim. Recover its saved result; it will not be submitted again.",
      409,
    );
  const ts = now();
  await db().execute({
    sql: `INSERT INTO paid_text_jobs(id,model,kind,status,estimate_usd,effort,request_body,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?)`,
    args: [id, input.model, input.kind, estimate, input.effort ?? null, textVendor(input.model) === 'openai' ? JSON.stringify({ ...JSON.parse(requestBody), pricingModel: model }) : requestBody, ts, ts],
  });
  const event = {
    id,
    kind: "text" as const,
    engine: textVendor(input.model) === "openai" ? "openai" : "vercel",
    model: input.model,
    projectId: input.projectId ?? null,
    createdBy: input.createdBy ?? currentTenant()?.user?.id ?? "",
  };
  await reserveGenerationSpend(
    { ...event, status: "running", engineCostUsd: estimate },
    { token: currentTenant()?.token },
  );
  let submitted = false;
  try {
    if (input.recordSpend !== false)
      await db().execute({
        sql: `INSERT INTO atomik_spend(id,kind,model,cost_usd,user_id,created_at) VALUES(?,?,?,?,?,?)`,
        args: [id, input.kind, input.model, estimate, event.createdBy, ts],
      });
    await db().execute({
      sql: `UPDATE paid_text_jobs SET status='running',updated_at=? WHERE id=?`,
      args: [now(), id],
    });
    const submit = overrides.submit ?? engineFor("vercel").run!;
    submitted = true;
    const response = await submit({
      body: requestBody,
      auth: input.auth,
      mock: input.mock,
      timeoutMs: input.timeoutMs ?? 270_000,
    });
    if (!response.ok) {
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(
        response.status,
      );
      await db().execute({
        sql: `UPDATE paid_text_jobs SET status=?,cost_usd=?,updated_at=? WHERE id=?`,
        args: [
          rejected ? "failed" : "uncertain",
          rejected ? 0 : estimate,
          now(),
          id,
        ],
      });
      if (rejected) {
        await db().execute({
          sql: `UPDATE atomik_spend SET cost_usd=0 WHERE id=?`,
          args: [id],
        });
        await meter({ ...event, status: "failed", engineCostUsd: 0 });
      } else
        await meter({ ...event, status: "failed", engineCostUsd: estimate });
      throw new PaidTextError(
        rejected
          ? `The text provider declined this request (${response.status}). No generation credits were charged.`
          : "The text provider returned an uncertain result. Its reserved credits are retained for reconciliation.",
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
      throw new PaidTextError(
        "The text provider returned an unreadable result. Its reservation is retained.",
      );
    }
    const content = json?.choices?.[0]?.message?.content;
    const direct = textVendor(input.model) === 'openai';
    let cost = direct && !engineMock() ? directTextCostUsd(model, json?.usage) : Number(json?.usage?.cost);
    if (direct && !engineMock() && (cost == null || !Number.isFinite(cost) || cost > estimate + 0.00000001)) {
      await db().execute({ sql: 'UPDATE paid_text_jobs SET response_json=?,updated_at=? WHERE id=?', args: [response.text, now(), id] });
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
    /* An empty answer is refused like any other unusable one. It used to
       settle as a success and bill the workspace in full while the person was
       told the model returned nothing they could use. */
    const verdict = typeof content !== "string" || !content.trim()
      ? { ok: false as const, reason: "The model completed, but returned no usable text." }
      : overrides.accept ? overrides.accept(content) : null;
    if (verdict && !verdict.ok) {
      /* Paid to the provider, refused by the caller: saved, settled at zero for the workspace. */
      await db().execute({
        sql: `UPDATE paid_text_jobs SET status='refused',cost_usd=?,response_json=?,updated_at=? WHERE id=?`,
        args: [cost, response.text, now(), id],
      });
      await db().execute({ sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`, args: [cost, id] });
      await meter({ ...event, status: "failed", engineCostUsd: 0 });
      throw new PaidTextError(`${verdict.reason} Nothing was charged.`, 502);
    }
    await db().execute({
      sql: `UPDATE paid_text_jobs SET status='succeeded',cost_usd=?,response_json=?,updated_at=? WHERE id=?`,
      args: [cost, response.text, now(), id],
    });
    await db().execute({
      sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`,
      args: [cost, id],
    });
    await meter({ ...event, status: "succeeded", engineCostUsd: cost });
    return {
      id,
      text: content as string,
      costUsd: cost,
      /* What the ledger billed, for the screen that shows it: credits are
         what a workspace on credits sees, never the vendor's dollars. */
      credits: await meteredCredits(id, paidByPlatform(textVendor(input.model)) ? billCredits(cost, "text") : 0),
    };
  } catch (error) {
    const record = (
      await db()
        .execute({
          sql: `SELECT status,cost_usd FROM paid_text_jobs WHERE id=?`,
          args: [id],
        })
        .catch(() => ({ rows: [] }))
    ).rows[0];
    if (error instanceof PaidTextError && record?.status === "running") {
      await db()
        .execute({
          sql: `UPDATE paid_text_jobs SET status='uncertain',cost_usd=?,updated_at=? WHERE id=?`,
          args: [estimate, now(), id],
        })
        .catch(() => {});
      await meter({ ...event, status: "failed", engineCostUsd: estimate });
    }
    if (!(error instanceof PaidTextError)) {
      const completed = record?.status === "succeeded";
      const cost = completed
        ? Number(record.cost_usd)
        : submitted
          ? estimate
          : 0;
      await db()
        .execute({
          sql: `UPDATE paid_text_jobs SET status=?,cost_usd=?,updated_at=? WHERE id=? AND status IN ('queued','running')`,
          args: [submitted ? "uncertain" : "failed", cost, now(), id],
        })
        .catch(() => {});
      await db()
        .execute({
          sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`,
          args: [cost, id],
        })
        .catch(() => {});
      await meter({
        ...event,
        status: completed ? "succeeded" : "failed",
        engineCostUsd: cost,
      });
      throw new PaidTextError(
        submitted
          ? "The text request was interrupted after submission. Its credits remain reserved; this request will not be sent again."
          : "The text request could not be prepared. No generation credits were spent.",
      );
    }
    throw error;
  }

});
}
