import { createHash, randomBytes, randomUUID } from "node:crypto";
import { recoveryRoute } from "@/lib/recovery";
import { clientIp } from "@/lib/clientIp";
import { crossOriginProblem } from "@/lib/requestOrigin";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { askVisitorBar, cleanQuestion, visitorBarEnabled, VISITOR_BAR_MAX_QUESTION } from "@/lib/visitor/bar";
import { VisitorLimiter } from "@/lib/visitor/limits";

export const dynamic = "force-dynamic";

/**
 * POST /api/visitor/ask: the visitor bar (v30 Phase A, item 9). A signed-out visitor's question about Particl, one
 * short screened answer back: `{ "question": "…" }` → `{ "answer": "…" }`.
 *
 * Off unless VISITOR_BAR_ENABLED=1; off, it answers as a switched-off engine does (503, in words) and reads nothing.
 * No session, no workspace, no credits: the bar charges nobody, and its cost is bounded by the platform-wide hourly
 * cap (lib/visitor/limits.ts). In order: the switch, the origin, a 4 KB body, a question of at most 500 characters,
 * the per-visitor, per-address and hourly limits, at most a few answers in flight, then the model and the screen.
 *
 * The log line carries ids, outcomes, timings and token counts only, never the question or the answer (CLAUDE.md
 * rule 17).
 */

const COOKIE = "particl-visitor";
const COOKIE_VALUE = /^[a-f0-9]{32}$/;
const BODY_LIMIT = 4096;
const IN_FLIGHT = 4;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const limiter = new VisitorLimiter();
let inFlight = 0;

/** One-way and salted, as the access-request route counts addresses: for counting, never for identifying anyone. */
function hashed(kind: string, value: string): string {
  const salt = process.env.SESSION_SECRET ?? "particl";
  return createHash("sha256").update(`${salt}:visitor-bar:${kind}:${value}`).digest("hex").slice(0, 32);
}

function visitorCookie(req: Request): { id: string; fresh: boolean } {
  const found = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === COOKIE)?.[1];
  return found && COOKIE_VALUE.test(found) ? { id: found, fresh: false } : { id: randomBytes(16).toString("hex"), fresh: true };
}

function setCookie(id: string, req: Request): string {
  const secure = new URL(req.url).protocol === "https:" || process.env.NODE_ENV === "production";
  return `${COOKIE}=${id}; Path=/api/visitor; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function log(line: Record<string, string | number | null>) {
  console.info(JSON.stringify({ event: "visitor_bar", ...line }));
}

export const POST = recoveryRoute(async function POST(req: Request): Promise<Response> {
  if (!visitorBarEnabled()) return Response.json({ error: "Questions here are switched off on this platform right now." }, { status: 503, headers: NO_STORE });
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin." }, { status: 403, headers: NO_STORE });

  const id = randomUUID(), started = Date.now();
  const cookie = visitorCookie(req);
  const headers: Record<string, string> = { ...NO_STORE, ...(cookie.fresh ? { "Set-Cookie": setCookie(cookie.id, req) } : {}) };
  const reply = (body: Record<string, unknown>, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

  let raw: unknown;
  try { raw = JSON.parse(await readBoundedText(req, BODY_LIMIT)); }
  catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: `Ask in ${VISITOR_BAR_MAX_QUESTION} characters or fewer.` }, 413);
    return reply({ error: "Send a question." }, 400);
  }
  const asked = cleanQuestion(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { question?: unknown }).question : undefined);
  if ("problem" in asked) return reply({ error: asked.problem === "long" ? `Ask in ${VISITOR_BAR_MAX_QUESTION} characters or fewer.` : "Send a question." }, asked.problem === "long" ? 413 : 400);

  if (inFlight >= IN_FLIGHT) {
    log({ id, outcome: "busy", ms: Date.now() - started });
    return reply({ error: "Busy right now. Try again in a moment." }, 503, { "Retry-After": "5" });
  }
  const admitted = limiter.admit(hashed("visitor", cookie.id), hashed("address", clientIp(req)));
  if (!admitted.ok) {
    log({ id, outcome: `limited:${admitted.scope}`, ms: Date.now() - started });
    return reply({ error: "That's all the questions for now. Try again later, or use Request access." }, 429, { "Retry-After": String(admitted.retryAfterSeconds) });
  }

  inFlight++;
  try {
    const result = await askVisitorBar(asked.question);
    if (!result.ok) {
      log({ id, outcome: result.reason, ms: Date.now() - started });
      return reply({ error: "No answer just now. Try again in a moment." }, 503, { "Retry-After": "30" });
    }
    log({ id, outcome: result.held ? `held:${result.held}` : "answered", ms: Date.now() - started, in_tokens: result.inTokens, out_tokens: result.outTokens });
    return reply({ answer: result.answer }, 200);
  } finally {
    inFlight--;
  }
});
