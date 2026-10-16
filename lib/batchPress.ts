import { createHash } from "node:crypto";
import { creditsApply, creditState } from "./credits";
import { requireTenant } from "./tenant";
import { isHouseWorkspace } from "./houseWorkspace";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { billedTo } from "./providers";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import { jobLineNow } from "./shotCap";
import { prepareGeneration, admitGeneration } from "./generationAdmission";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PrepareAdmissionResult, PreparedAdmission } from "./admissionTypes";
import { admissionReply, assertAdmissionActor } from "./admissionSupport";

/**
 * A multi-shot press is ONE job (owner, 16 Oct 2026, A.2): judged as one against the 200 cr line (SOW §7A guardrail 4), with one approval that shows the total.
 *
 * Without this, a press of N shots is N requests that are each under the line, and the line never sees the sum. Here the SERVER prices every member itself (the same
 * `prepareGeneration` every take is priced by; a total from the client is never read), adds their holds, and judges the sum with the one rule every job is judged by
 * (`jobLineNow`): over the line, a member of the workspace is told an admin has to start it, an admin's own tap clears it, and a token, an MCP client or Atomik can prepare it
 * and never start it. Exactly at the line is not over it.
 *
 * The approval is the person's, once, for exactly the listed members at their listed prices: it carries the batch's fingerprint (a hash of every member's own quote
 * fingerprint and the total), so a member added, removed or re-priced is another batch that asks again. The balance is checked against the total before the first
 * member starts. Each member is then admitted at its own quote through the ordinary generation admission, under a request key made from the batch, so a retry
 * starts nothing twice. A member that is refused (a cap, a rate limit) is named; the rest run, and what is left is asked again.
 *
 * Members are ordinary generation requests (the body POST /api/generate takes, with no `maxCredits`). The members do not carry `batchId`/`batchSize`: those are a composer's
 * own claim about its press (lib/batchLine.ts) and would judge each member by the first one's price times the rest; this endpoint has already judged the sum.
 */
export const BATCH_MAX_MEMBERS = 24;
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";

export type BatchSeams = {
  prepare?: (body: Record<string, unknown>, actor: AdmissionActor) => Promise<PrepareAdmissionResult>;
  admit?: (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; defer: AdmissionExecution["defer"]; run?: AdmissionExecution["run"] }) => Promise<AdmissionReply>;
};

/** What the line is judged on for one member: its price at its hold (the most it can settle at), and the engine's dollars at that hold (the house pays at cost). */
function holdOf(p: PreparedAdmission): { credits: number; usd: number } {
  const credits = p.quote.ceilingCredits ?? p.quote.estimatedCredits;
  const usd = p.quote.unit === "usd" ? p.quote.price * (p.quote.ceilingCredits != null && p.quote.estimatedCredits > 0 ? p.quote.ceilingCredits / p.quote.estimatedCredits : 1) : 0;
  return { credits, usd };
}
const platformKeyOf = (p: PreparedAdmission) => vendorKeyNameFor(billedTo(String((p.compiled.model as { provider?: unknown } | undefined)?.provider ?? "byteplus")));

export async function admitBatch(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: BatchSeams = {}): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (options.checkpoint) return admissionReply({ error: "A batch is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  const quoteOnly = input.quoteOnly === true;
  const members = input.members;
  if (!Array.isArray(members) || !members.length) return admissionReply({ error: "Add the shots to make." }, { status: 400 });
  if (members.length > BATCH_MAX_MEMBERS) return admissionReply({ error: `A press takes up to ${BATCH_MAX_MEMBERS} shots at a time.` }, { status: 400 });
  const prepare = seams.prepare ?? prepareGeneration;
  const admit = seams.admit ?? admitGeneration;

  /* ── The server prices every member itself ── */
  const prepared: PreparedAdmission[] = [];
  for (const [i, raw] of members.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return admissionReply({ error: `Shot ${i + 1} is not valid.` }, { status: 400 });
    const { maxCredits: _a, quoteFingerprint: _b, batchId: _c, batchSize: _d, ...member } = raw as Record<string, unknown>;
    void _a; void _b; void _c; void _d;
    const p = await prepare(member, got);
    if (!p.ok) return admissionReply({ ...p.body, error: `Shot ${i + 1}: ${typeof p.body.error === "string" ? p.body.error : "It can't be priced."}` }, { status: p.status });
    prepared.push(p.value);
  }
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const holds = prepared.map(holdOf);
  const credits = holds.reduce((n, h) => n + h.credits, 0);
  const usd = holds.reduce((n, h) => n + h.usd, 0);
  const price = prepared.reduce((n, p) => n + p.quote.price, 0);
  const estimatedCredits = prepared.reduce((n, p) => n + p.quote.estimatedCredits, 0);

  /* ── Guardrail 4 on the SUM, by the one rule every job is judged by ── */
  const anyPlatform = prepared.find((p) => paidByPlatform(platformKeyOf(p)));
  if (anyPlatform || isHouseWorkspace(requireTenant())) {
    const over = jobLineNow({ credits, usd, key: platformKeyOf(anyPlatform ?? prepared[0]), actor: got, auto: options.run?.auto === true });
    if (over) return admissionReply({ error: over, needsAdmin: true, members: prepared.length }, { status: 403 });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, members: prepared.map((p) => p.quote.fingerprint), credits })).digest("hex");
  const batchId = `bt_${fingerprint.slice(0, 24)}`;
  if (quoteOnly) return admissionReply({ estimatedCredits, price: unit === "cr" ? estimatedCredits : Math.round(price * 1e6) / 1e6, unit, members: prepared.length, batchId, fingerprint, ...(credits > estimatedCredits ? { ceilingCredits: credits } : {}) });

  /* ── The approval: one person, once, for exactly these members at these prices ── */
  if (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  if (typeof input.fingerprint !== "string" || input.fingerprint !== fingerprint)
    return admissionReply({ error: "The shots or their prices changed. Look at the total again before approving.", quoteChanged: true }, { status: 409 });
  if (!Number.isInteger(input.maxCredits) || (input.maxCredits as number) < 0 || credits > (input.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the total is above the approved credit amount." }, { status: 409 });
  /* The balance against the whole total, before the first member starts (rule 14): never halfway through. */
  const state = unit === "cr" ? await creditState() : null;
  if (state && state.balance < credits)
    return admissionReply({ error: `Short by ${Math.ceil((credits - state.balance) * 10) / 10} cr. Top up, then approve. Nothing is spent until you do.`, short: true }, { status: 402 });

  /* ── Each member, at its own quote, under a key made from the batch ── */
  /* The press's own request key (the route's Idempotency-Key) makes the members' keys: a replay of the same press starts nothing twice, and a new press of the same shots is a new press. */
  const press = options.requestClaim ? createHash("sha256").update(options.requestClaim.key).digest("hex").slice(0, 12) : "direct";
  const out: { index: number; id?: string; status?: string; error?: string; code?: number }[] = [];
  for (const [index, p] of prepared.entries()) {
    const reply = await admit(p, got, { requestKey: `${batchId}:${press}:${index}`, defer: options.defer, ...(options.run ? { run: options.run } : {}) });
    if (reply.status === 200 || reply.status === 202) out.push({ index, id: typeof reply.body.id === "string" ? reply.body.id : undefined, status: typeof reply.body.status === "string" ? reply.body.status : "running" });
    else out.push({ index, error: typeof reply.body.error === "string" ? reply.body.error : "It did not start.", code: reply.status });
  }
  const refused = out.filter((m) => m.error).length;
  return admissionReply({ id: batchId, batchId, status: refused ? (refused === out.length ? "refused" : "partial") : "started", estimatedCredits, members: out, ...(refused ? { retry: "Ask again with the same shots: what started is not started twice, and the rest asks at its price." } : {}) }, { status: refused === out.length ? out[0].code ?? 502 : 200 });
}
