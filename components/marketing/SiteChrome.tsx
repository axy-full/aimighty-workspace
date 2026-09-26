import Link from "next/link";
import { ParticlMark, ParticlWordmark } from "@/components/ParticlMark";
import ActiveTab from "./ActiveTab";
import { ACCESS_HREF, APP_HREF, PRICING_HREF, SIGN_IN_HREF, SITE_SUITES, type SiteSuiteId } from "@/lib/marketing/site";

/**
 * The site's header and footer. Server-rendered: the page says which tab is
 * current (the path cannot be trusted under the proxy's rewrites), and
 * whether the visitor already has a session, in which case the header offers
 * the app instead of sign-in and access.
 */

export function Brand() {
  return (
    <Link href="/" className="mk-brand" aria-label="particl studio, home">
      <ParticlMark size={14} />
      <ParticlWordmark size={21} />
      <span className="mk-brand-studio" aria-hidden="true">studio</span>
    </Link>
  );
}

export function SiteHeader({ active, member }: { active: SiteSuiteId | "pricing"; member: boolean }) {
  return (
    <header className="mk-header">
      <div className="mk-header-in">
        <Brand />
        <nav className="mk-nav" aria-label="Suites">
          {SITE_SUITES.map((suite) => (
            <Link key={suite.id} href={suite.href} className="mk-tab" aria-current={active === suite.id ? "page" : undefined}>
              {suite.tab}
            </Link>
          ))}
          <span className="mk-nav-rule" aria-hidden="true" />
          <Link href={PRICING_HREF} className="mk-tab" aria-current={active === "pricing" ? "page" : undefined}>Pricing</Link>
        </nav>
        <ActiveTab />
        {member ? (
          <a href={APP_HREF} className="mk-btn mk-btn--sm gx-primary">Open Particl</a>
        ) : (
          <>
            <a href={SIGN_IN_HREF} className="mk-btn mk-btn--sm mk-btn--secondary mk-hide-phone">Sign in</a>
            <a href={ACCESS_HREF} className="mk-btn mk-btn--sm gx-primary">Request access</a>
          </>
        )}
      </div>
    </header>
  );
}

export function SiteFooter({ member }: { member: boolean }) {
  const suite = (id: SiteSuiteId) => SITE_SUITES.find((s) => s.id === id)!;
  return (
    <footer className="mk-footer">
      <div className="mk-wrap">
        <div className="mk-footer-top">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Brand />
            <p className="mk-footer-blurb">The studio&rsquo;s own room for making shots, and for knowing what they cost.</p>
          </div>
          <div className="mk-footer-cols">
            <nav className="mk-footer-col" aria-label="Suites">
              <span className="mk-tag mk-tag--muted">Suites</span>
              {(["studio", "gen", "business", "viral", "atomik"] as const).map((id) => (
                <Link key={id} href={suite(id).href}>{suite(id).tab}</Link>
              ))}
            </nav>
            <nav className="mk-footer-col" aria-label="Site">
              <span className="mk-tag mk-tag--muted">Site</span>
              <Link href={PRICING_HREF}>Pricing</Link>
              {member ? <a href={APP_HREF}>Open Particl</a> : <>
                <a href={ACCESS_HREF}>Request access</a>
                <a href={SIGN_IN_HREF}>Sign in</a>
              </>}
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
            </nav>
            <nav className="mk-footer-col" aria-label="Workspace">
              <span className="mk-tag mk-tag--muted">Workspace</span>
              <Link href="/workspace">General · People · Plans &amp; credits</Link>
              <Link href="/workspace">Usage · Engines · Security</Link>
            </nav>
          </div>
        </div>
        <div className="mk-footer-bottom">
          <span>© {new Date().getFullYear()} particl</span>
          <span className="mk-tag">Failed renders are never billed · every take has an owner</span>
        </div>
      </div>
    </footer>
  );
}
