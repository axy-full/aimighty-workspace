import { withRecoveryActivity } from './recovery';
import { db, ready, id as newId, now } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { findModel, textCostUsd, type CatalogModel } from "./catalog";
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
      status TEXT NOT NULL, estimate_usd REAL NOT NULL, cost_usd REAL, response_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
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
): number {
  // Includes wire-format overhead and UTF-8 text; base64 references also receive a conservative bound.
  const input = Buffer.byteLength(JSON.stringify(messages), "utf8") + 512;
  if (
    model.type !== "language" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 4000 ||
    (model.maxTokens != null && maxTokens > model.maxTokens) ||
    (model.contextWindow != null && input + maxTokens > model.contextWindow)
  )
    throw new PaidTextError(
      "This request exceeds the selected model's context or output limit. Shorten it or choose another model.",
      400,
    );
  const estimate = textCostUsd(model, input, maxTokens);
  if (estimate == null || !Number.isFinite(estimate) || estimate <= 0)
    throw new PaidTextError(
      "This model has no confirmed price. Choose a priced language model.",
      503,
    );
  const configured = Number(process.env.ATOMIK_MAX_REQUEST_USD ?? 1);
  const cap =
    Number.isFinite(configured) && configured > 0 ? Math.min(configured, 5) : 1;
  if (estimate > cap)
    throw new PaidTextError(
      "This request exceeds the Atomik request budget. Use fewer references, shorter context, or an economy model.",
      409,
    );
  return estimate;
}

/** One bounded submission. No hidden model repair, provider failover, or transport retry. */
export async function runPaidText(
  input: {
    id?: string;
    model: string;
    messages: unknown[];
    maxTokens: number;
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
  } = {},
) {
return await withRecoveryActivity('paid-text', async () => {

  const model = overrides.model ?? (await findModel(input.model));
  if (!model)
    throw new PaidTextError(
      "Choose a language model from the current catalog.",
      400,
    );
  const estimate = textRequestEstimate(model, input.messages, input.maxTokens);
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
    sql: `INSERT INTO paid_text_jobs(id,model,kind,status,estimate_usd,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)`,
    args: [id, input.model, input.kind, estimate, ts, ts],
  });
  const event = {
    id,
    kind: "text" as const,
    engine: "vercel",
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
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        messages: input.messages,
        response_format: { type: "json_object" },
      }),
      auth: input.auth,
      mock: input.mock,
      timeoutMs: input.timeoutMs ?? 120_000,
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
    let cost = Number(json?.usage?.cost);
    if (!Number.isFinite(cost) || cost < 0) {
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
    await db().execute({
      sql: `UPDATE paid_text_jobs SET status='succeeded',cost_usd=?,response_json=?,updated_at=? WHERE id=?`,
      args: [cost, response.text, now(), id],
    });
    await db().execute({
      sql: `UPDATE atomik_spend SET cost_usd=? WHERE id=?`,
      args: [cost, id],
    });
    await meter({ ...event, status: "succeeded", engineCostUsd: cost });
    if (typeof content !== "string" || !content)
      throw new PaidTextError(
        "The model completed, but returned no usable text. The paid response has been saved.",
      );
    return { id, text: content, costUsd: cost };
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
