import { retiredResponse } from "@/lib/higgsfield-consumer/retired";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Reading what the connected account offers (Settings' tool discovery and
 * Atomik › Tools & connections' reach check) is retired with the Higgsfield
 * sign-in (lib/higgsfield-consumer/retired.ts): the account is not read.
 */
export async function POST() {
  return retiredResponse();
}
