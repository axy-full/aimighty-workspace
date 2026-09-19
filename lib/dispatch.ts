/**
 * How background work leaves the request that asked for it.
 *
 * Three modes, decided from the environment alone so every module agrees:
 *
 *   native  — the app POSTs the event to its own /api/worker route on Vercel,
 *             authenticated by CRON_SECRET, and that route runs the handler
 *             in its own function lifetime (`after()` behind a 202). Nothing
 *             outside Vercel is involved. This is production's default.
 *   inngest — the event is sent to Inngest, which calls /api/inngest back.
 *             Only when the operator asks for it (DISPATCH_MODE=inngest) AND
 *             both keys are present; a half-configured Inngest is never used.
 *   inline  — no queue at all: callers run the work in their own `after()`,
 *             which is what local development and mocks have always done.
 *
 * This module deliberately imports nothing from the app so route tests can
 * load it with a fake fetch and a fake environment.
 */

/** Every event this app sends, named in one place so senders can't drift. */
export const EVENTS = {
  /** Wiring check, triggered by hand (Inngest dashboard, or a POST to /api/worker). */
  probe: "worker/probe",
  /** A still or a piece of audio whose row already exists as "running"; or a video to submit. */
  render: "render/requested",
  astraRender: "astra-blender/render.requested",
  development: "workbench/development.requested",
  /** A funded dubbing project to submit, ask after, or collect (lib/dubbing.ts). */
  dubbing: "audio/dubbing.requested",
} as const;

export type WorkerEventName = (typeof EVENTS)[keyof typeof EVENTS];
export const WORKER_EVENT_NAMES = [
  EVENTS.probe,
  EVENTS.render,
  EVENTS.astraRender,
  EVENTS.development,
  EVENTS.dubbing,
] as const satisfies readonly WorkerEventName[];

export type WorkerEvent = {
  id: string;
  name: WorkerEventName;
  data: Record<string, string>;
};

export type DispatchMode = "native" | "inngest" | "inline";
type Environment = Record<string, string | undefined>;

/** The origin the worker route is reached at; null when nothing names one. */
export function dispatchOrigin(env: Environment = process.env): string | null {
  const raw =
    env.APP_ORIGIN ||
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function dispatchMode(env: Environment = process.env): DispatchMode {
  if (
    env.DISPATCH_MODE === "inngest" &&
    env.INNGEST_EVENT_KEY &&
    env.INNGEST_SIGNING_KEY
  )
    return "inngest";
  const wantsNative =
    env.NODE_ENV === "production" || env.DISPATCH_MODE === "native";
  if (
    wantsNative &&
    env.CRON_SECRET &&
    dispatchOrigin(env) &&
    env.ENGINE_MOCK !== "1"
  )
    return "native";
  return "inline";
}

export const DISPATCH_TIMEOUT_MS = 15_000;

/** How one hand-off ended, in the same words the log line uses. */
export type DispatchOutcome = "sent" | "refused" | "failed" | "unconfigured";

export type DispatchResult = {
  outcome: DispatchOutcome;
  /** The worker route's HTTP status, when a response came back at all. */
  status?: number;
  durationMs?: number;
  /** Why a `failed` hand-off failed: the error's name (TimeoutError, TypeError), never its message. */
  reason?: string;
};

/**
 * Hand one event to this deployment's own worker route.
 *
 * True means the route answered 202 — it took the event, or it was busy and
 * left the job queued for the slot chain or the cron. Anything else (401,
 * 500, a timeout, no origin, no secret) is false, and never a throw: the
 * caller's fallback is what happens next, not an error page.
 *
 * The body carries identifiers only. Prompts, URLs and credentials stay in
 * tenant storage, so the log of a failed POST discloses nothing.
 */
export async function dispatchEvent(
  event: WorkerEvent,
  deps: { fetch?: typeof fetch; env?: Environment } = {},
): Promise<boolean> {
  return (await dispatchEventDetailed(event, deps)).outcome === "sent";
}

/**
 * The same hand-off, answering what happened rather than only whether it
 * worked, so the sender can record the outcome durably (lib/dispatch-log.ts)
 * without this module importing anything from the app.
 */
export async function dispatchEventDetailed(
  event: WorkerEvent,
  deps: { fetch?: typeof fetch; env?: Environment } = {},
): Promise<DispatchResult> {
  const env = deps.env ?? process.env;
  const origin = dispatchOrigin(env);
  const secret = env.CRON_SECRET;
  // Fixed-shape lines only: the event carries identifiers, never a prompt,
  // a URL or a credential, so the log can say exactly why a hand-off fell
  // back without disclosing anything.
  const report = (outcome: DispatchOutcome, extra: Record<string, unknown> = {}) =>
    console[outcome === "sent" ? "info" : "error"](
      JSON.stringify({ level: outcome === "sent" ? "info" : "error", event: `dispatch.${outcome}`, name: event.name, ...extra }),
    );
  if (!origin || !secret) {
    report("unconfigured", { origin: Boolean(origin), secret: Boolean(secret) });
    return { outcome: "unconfigured" };
  }
  const doFetch = deps.fetch ?? fetch;
  const startedAt = Date.now();
  try {
    const response = await doFetch(`${origin}/api/worker`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      cache: "no-store",
    });
    const durationMs = Date.now() - startedAt;
    const outcome: DispatchOutcome = response.status === 202 ? "sent" : "refused";
    report(outcome, { status: response.status, durationMs });
    return { outcome, status: response.status, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof Error ? error.name : "unknown";
    report("failed", { reason, durationMs });
    return { outcome: "failed", reason, durationMs };
  }
}
