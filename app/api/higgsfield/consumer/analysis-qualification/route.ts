import { retiredResponse } from "@/lib/higgsfield-consumer/retired";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The connected account's analysis model definitions are retired with the Higgsfield sign-in (lib/higgsfield-consumer/retired.ts). */
export async function POST() {
  return retiredResponse();
}
