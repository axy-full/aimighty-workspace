/**
 * What a route answers when a website tool on the platform's account refuses
 * — one mapping for every consumer route. Each answer is neutral: it never
 * names the account, its wallet, its credits, the rate or a provider reply,
 * and every refusal here happened before anything was sent or charged.
 */
import { SpendReservationError } from "@/lib/generationRequests";
import { currentTenant } from "@/lib/tenant";
import { WebsiteToolsUnavailableError } from "./platform-account";
import { WebsitePriceChangedError } from "./account-billing";
import { ForeignAccountObjectError } from "./account-objects";
import { WebsiteRegistryError } from "./platform-jobs";
import { ConsumerVideoError } from "./video-contract";
import { ConsumerDiscoveryError } from "./mcp";
import { ShortsStudioError } from "./shorts-studio";
import { MarketingTemplateError } from "./marketing-templates";

const UNAVAILABLE = "Website tools are temporarily unavailable. Nothing was charged.";
/** A managed workspace runs these tools only on the platform's website account. */
const managed = () => currentTenant()?.workspace?.usesPlatformKeys === true;
/** What the account itself refused, in words a client may read: the account's wallet, price, tools and connection stay on the server. */
function accountRefusal(error: unknown): { status: number; body: { code: string; error: string } } | null {
  if (error instanceof ConsumerVideoError) {
    // Input the client can fix still says so.
    if (error.code === "invalid_input") return null;
    if (error.code === "quote_changed" || error.code === "unapproved_adjustment")
      return { status: 409, body: { code: "price_changed", error: new WebsitePriceChangedError().message } };
    return { status: 503, body: { code: "website_unavailable", error: UNAVAILABLE } };
  }
  if (error instanceof ConsumerDiscoveryError) return { status: 503, body: { code: "website_unavailable", error: UNAVAILABLE } };
  if ((error instanceof ShortsStudioError || error instanceof MarketingTemplateError) &&
      (error.status >= 500 || ["contract_unverified", "invalid_session", "price_unknown"].includes(error.code)))
    return { status: 503, body: { code: "website_unavailable", error: UNAVAILABLE } };
  return null;
}

export function websiteProblem(error: unknown): { status: number; body: { code: string; error: string } } | null {
  if (error instanceof WebsiteToolsUnavailableError)
    return { status: 503, body: { code: "website_unavailable", error: error.reason === "busy" ? "Website tools are busy with other work. Try again shortly; nothing was charged." : error.message } };
  if (error instanceof WebsitePriceChangedError) return { status: 409, body: { code: error.code, error: error.message } };
  if (error instanceof ForeignAccountObjectError) return { status: error.status, body: { code: error.code, error: error.message } };
  if (error instanceof WebsiteRegistryError && error.code === "capacity") return { status: 429, body: { code: "capacity", error: error.message } };
  // The workspace's own balance, caps and limits: their messages are the customer's own figures, in credits.
  if (error instanceof SpendReservationError) return { status: error.status, body: { code: "reservation_refused", error: error.message } };
  // In a managed workspace the account's own refusals read neutrally too.
  if (managed()) return accountRefusal(error);
  return null;
}
