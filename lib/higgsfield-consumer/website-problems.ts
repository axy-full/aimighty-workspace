/**
 * What a route answers when a website tool on the platform's account refuses
 * — one mapping for every consumer route. Each answer is neutral: it never
 * names the account, its wallet, its credits, the rate or a provider reply,
 * and every refusal here happened before anything was sent or charged.
 */
import { SpendReservationError } from "@/lib/generationRequests";
import { WebsiteToolsUnavailableError } from "./platform-account";
import { WebsitePriceChangedError } from "./account-billing";
import { ForeignAccountObjectError } from "./account-objects";
import { WebsiteRegistryError } from "./platform-jobs";

export function websiteProblem(error: unknown): { status: number; body: { code: string; error: string } } | null {
  if (error instanceof WebsiteToolsUnavailableError)
    return { status: 503, body: { code: "website_unavailable", error: error.reason === "busy" ? "Website tools are busy with other work. Try again shortly; nothing was charged." : error.message } };
  if (error instanceof WebsitePriceChangedError) return { status: 409, body: { code: error.code, error: error.message } };
  if (error instanceof ForeignAccountObjectError) return { status: error.status, body: { code: error.code, error: error.message } };
  if (error instanceof WebsiteRegistryError && error.code === "capacity") return { status: 429, body: { code: "capacity", error: error.message } };
  // The workspace's own balance, caps and limits: their messages are the customer's own figures, in credits.
  if (error instanceof SpendReservationError) return { status: error.status, body: { code: "reservation_refused", error: error.message } };
  return null;
}
