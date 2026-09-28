import { retiredResponse } from "@/lib/higgsfield-consumer/retired";

export const dynamic = "force-dynamic";

/**
 * The connected account's workflow bundles as Atomik recipes (the composer's
 * `/` menu) are retired with the Higgsfield sign-in
 * (lib/higgsfield-consumer/retired.ts): the account is not read, and `/name`
 * in a message is plain text. Particl's own saved recipes are unaffected.
 */
export async function GET() {
  return retiredResponse();
}
