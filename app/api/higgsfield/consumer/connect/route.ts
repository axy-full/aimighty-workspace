import { retiredResponse } from "@/lib/higgsfield-consumer/retired";
export const runtime = "nodejs";
/**
 * Connecting (and reconnecting) the Higgsfield account is retired: no new
 * sign-in starts, for anyone (lib/higgsfield-consumer/retired.ts). A grant
 * already held stays until the owner presses Disconnect in Workspace ›
 * Engines, so the jobs it started are still collected.
 */
export async function POST() {
  return retiredResponse();
}
