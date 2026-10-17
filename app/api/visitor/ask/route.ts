import { createHash, randomBytes, randomUUID } from "node:crypto";
import { recoveryRoute } from "@/lib/recovery";
import { clientIp } from "@/lib/clientIp";
import { crossOriginProblem } from "@/lib/requestOrigin";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { askVisitorBar, cleanQuestion, visitorBarDoor, visitorBarEnabled } from "@/lib/visitor/bar";
import { addressBucket, admitShared, networkBucket } from "@/lib/visitor/limits";
import { recordVisitorSpend } from "@/lib/visitor/ledger";

export const dynamic = "force-dynamic";

/**
 * POST /api/visitor/ask: the visitor bar (v30 Phase A, item 9). A signed-out visitor's question about Particl, one
 * short screened answer back: `{ "question": "…" }` → `{ "answer": "…" }`. The answer is plain text: whatever shows it
 * must render it as text, never as HTML and never auto-linked.
 *
 * Off unless VISITOR_BAR_ENABLED=1. Off, it answers as a switched-off engine does (503, in words) before anything else
 * runs: no body read, no cookie, no database (the switch is read before the recovery wrapper opens its activity).
 * No session, no workspace, no credits: the bar charges nobody. Its cost is bounded by the site's daily cap
 * (lib/visitor/limits.ts) and written on the ledger as house spend marked "visitor" (lib/visitor/ledger.ts). In order:
 * the switch, the origin, a 4 KB body, a question of at most 400 characters, the answers in flight, the model's door
 * and the bar's own key (a misconfigured bar counts nothing and writes nothing), the per-visitor, per-address, per-/48
 * and site limits (each a UTC day, shared, in the platform database), the model and the screen, then the ledger.
 *
 * Every limit, when it is reached, answers in the owner's words (17 Oct 2026): LIMIT_REACHED below.
 *
 * The log line carries ids, outcomes, timings and token counts only, never the question or the answer (CLAUDE.md
 * rule 17).
 */

const COOKIE = "particl-visitor";
const COOKIE_VALUE = /^[a-f0-9]{32}$/;
const BODY_LIMIT = 4096;
const IN_FLIGHT = 4;
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What the bar says when any limit is reached: the owner's words, exactly. */
const LIMIT_REACHED = "That's all for today \u2014 request access to continue";
let inFlight = 0;

/** One-way and salted with the secret and fallbacks the review links and logins use: for counting, never for identifying anyone. */
function hashed(kind: string, value: string): string {
  const salt = process.env.SESSION_SECRET ?? process.env.TURSO_AUTH_TOKEN ?? "particl";
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

const ask = recoveryRoute(async function ask(req: Request): Promise<Response> {
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin." }, { status: 403, headers: NO_STORE });

  const id = randomUUID(), started = Date.now();
  const cookie = visitorCookie(req);
  const headers: Record<string, string> = { ...NO_STORE, ...(cookie.fresh ? { "Set-Cookie": setCookie(cookie.id, req) } : {}) };
  const reply = (body: Record<string, unknown>, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  /* Longer than VISITOR_BAR_MAX_QUESTION (or a body past 4 KB) is a limit reached too. */
  const tooLong = () => reply({ error: LIMIT_REACHED }, 413);
  const noAnswer = () => reply({ error: "No answer just now. Try again in a moment." }, 503, { "Retry-After": "30" });

  let raw: unknown;
  try { raw = JSON.parse(await readBoundedText(req, BODY_LIMIT)); }
  catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return tooLong();
    return reply({ error: "Send a question." }, 400);
  }
  const asked = cleanQuestion(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { question?: unknown }).question : undefined);
  if ("problem" in asked) return asked.problem === "long" ? tooLong() : reply({ error: "Send a question." }, 400);

  if (inFlight >= IN_FLIGHT) {
    log({ id, outcome: "busy", ms: Date.now() - started });
    return reply({ error: "Busy right now. Try again in a moment." }, 503, { "Retry-After": "5" });
  }
  const limited = (scope: string, retryAfterSeconds: number) => {
    log({ id, outcome: `limited:${scope}`, ms: Date.now() - started });
    return reply({ error: LIMIT_REACHED }, 429, { "Retry-After": String(retryAfterSeconds) });
  };
  /* Misconfigured (a model off the list, no direct door, no key of the bar's own): nothing is counted or sent. */
  const door = visitorBarDoor();
  if (!door.ok) {
    log({ id, outcome: door.reason, ms: Date.now() - started });
    return noAnswer();
  }
  inFlight++;
  try {
    let shared: Awaited<ReturnType<typeof admitShared>>;
    const ip = clientIp(req), network = networkBucket(ip);
    try { shared = await admitShared({ visitor: hashed("visitor", cookie.id), address: hashed("address", addressBucket(ip)), network: network ? hashed("network", network) : null }); }
    catch {
      /* The shared limits could not be read or written: refused, never let through. */
      log({ id, outcome: "limits_unavailable", ms: Date.now() - started });
      return noAnswer();
    }
    if (!shared.ok) return limited(shared.scope, shared.retryAfterSeconds);

    const result = await askVisitorBar(asked.question);
    if (!result.ok) {
      log({ id, outcome: result.reason, ms: Date.now() - started });
      return noAnswer();
    }
    /* MONEY: the model replied, so it cost something: house spend, marked "visitor". A miss never costs the visitor the answer. */
    const ledger = await recordVisitorSpend({ id, model: result.model, usage: result.usage });
    log({ id, outcome: result.held ? `held:${result.held}` : "answered", ms: Date.now() - started, in_tokens: result.inTokens, out_tokens: result.outTokens, ledger: ledger.recorded ? "recorded" : "not_recorded" });
    return reply({ answer: result.answer }, 200);
  } finally {
    inFlight--;
  }
});

export async function POST(req: Request): Promise<Response> {
  /* The switch first, outside the recovery wrapper: switched off, nothing runs and nothing is opened. */
  if (!visitorBarEnabled()) return Response.json({ error: "Questions here are switched off on this platform right now." }, { status: 503, headers: NO_STORE });
  return ask(req);
}
