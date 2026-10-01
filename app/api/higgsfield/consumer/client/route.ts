import { retiredResponse } from "@/lib/higgsfield-consumer/retired";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The sign-in client's metadata is withdrawn with the sign-in itself
 * (lib/higgsfield-consumer/retired.ts): without it no new authorization can
 * start. Unauthenticated, as before; it never held a credential.
 */
export async function GET() {
  return retiredResponse();
}
