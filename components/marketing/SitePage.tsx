import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { cache } from "react";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { sitePrices as computePrices } from "@/lib/marketing/prices.server";
import type { SiteSuiteId } from "@/lib/marketing/site";
import SharedBottom from "./SharedBottom";
import { SiteFooter, SiteHeader } from "./SiteChrome";

/** Computed once per request, however many sections ask. */
export const sitePrices = cache(computePrices);

/** A session cookie is enough to offer the app; the app checks it properly. */
export const isMember = cache(async () => (await cookies()).has(SESSION_COOKIE));

/** Header, the page's own sections, the shared bottom, the footer. */
export default async function SitePage({ active, children, bottom = true }: {
  active: SiteSuiteId | "pricing"; children: ReactNode; bottom?: boolean;
}) {
  const [member, prices] = await Promise.all([isMember(), sitePrices()]);
  return (
    <>
      <SiteHeader active={active} member={member} />
      <main>
        {children}
        {bottom && <SharedBottom prices={prices} member={member} />}
      </main>
      <SiteFooter member={member} />
    </>
  );
}
