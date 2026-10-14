/**
 * Who called the heartbeat route (app/api/cron/sync/route.ts), for the line the platform console and the health briefing show ("by"). Our own server's scheduled task
 * (ops/selfhost/cron-sync.mjs, run by Coolify) says who it is in its user-agent; anything else that holds the secret is "manual". The caller is only recorded, never
 * trusted for anything: the route's bearer secret is what lets it in.
 */
export const SCHEDULER_AGENT = "particl-scheduler/1";

export function cronCaller(userAgent: string | null | undefined): "scheduler" | "manual" {
  return userAgent?.trim() === SCHEDULER_AGENT ? "scheduler" : "manual";
}
