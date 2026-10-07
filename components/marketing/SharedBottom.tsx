import Link from "next/link";
import { ParticlMark } from "@/components/ParticlMark";
import type { SitePrices } from "@/lib/marketing/prices.server";
import { planLines } from "@/lib/marketing/plans";
import { usd } from "@/lib/marketing/format";
import { APP_HREF, PRICING_HREF, SIGN_IN_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";
import AccessForm from "./AccessForm";
import { Chips, Cols, Grid, Head, Section, Tile, Window } from "./ui";

/** Places strip → the board → Pricing teaser → Request access: the end of every page. */
export default function SharedBottom({ prices, member }: { prices: SitePrices; member: boolean }) {
  return (
    <>
      <SuitesStrip />
      <Shell />
      <PricingTeaser prices={prices} />
      <RequestAccess member={member} />
    </>
  );
}

function SuitesStrip() {
  return (
    <Section id="suites" panel label="Places">
      <Head
        eyebrow="Studio · Ads · Social · Make · Atomik"
        title="Every project is one board."
        aside={<p className="mk-lead" style={{ fontSize: 15, maxWidth: "46ch" }}>Studio, Ads and Social are boards. Make opens over any of them; Atomik sits beside.</p>}
      />
      <div className="mk-suites-grid">
        {SITE_SUITES.map((suite) => (
          <Link key={suite.id} href={suite.href} className="mk-card mk-suite-card">
            <span className="mk-suite-card-top"><span className="mk-tag">{suite.tag}</span><span className="mk-glow" aria-hidden="true" /></span>
            <span className="mk-name">{suite.name}</span>
            <span className="mk-body">{suite.blurb}</span>
            <span className="mk-suite-pages">{suite.pages.join(" · ")}</span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

const SHELL_TILES: [string, string, string][] = [
  ["Home", "What are we making?", "Start from a brief or a template: Film, Ad campaign, Social clips or a script. Your projects show what needs you."],
  ["⌘K", "Search and Atomik", "Go to any part of the board, open Make, or ask Atomik. Enter runs the top result."],
  ["⌥M", "Make", "Video, images and audio over any screen. The engine line shows the price before you press."],
  ["Library", "A drawer on the board", "Every take and reference, ready to drag onto a shot. Download keeps the original file."],
  ["⌘J", "Inspector", "Shows a take's prompt, engine and the price paid."],
  ["Right-click", "Menu everywhere", "Copy, duplicate, use as reference, or recreate at its price. Delete has Undo."],
];

function Shell() {
  return (
    <Section id="shell" label="The board">
      <Head eyebrow="The board" title="The whole production on one canvas."
        lead="Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver. Atomik plans each step and prices it; a person approves before anything is spent." />
      <Cols col={420}>
        <Window path="⌘K · search everything" src={shot("palette-cmd-k")} alt="The ⌘K palette" width={924} height={540} />
        <Grid col={200}>
          {SHELL_TILES.map(([tag, name, body]) => <Tile key={tag} tag={tag} name={name} body={body} />)}
        </Grid>
      </Cols>
      <Cols col={300} style={{ alignItems: "center", marginTop: 16 }}>
        <div className="mk-head">
          <div className="mk-eyebrow">On a phone</div>
          <h3 className="mk-h3">Judge the work, one hand.</h3>
          <p className="mk-lead">Home · Record · Make · Atomik in the tab bar. Approve a plan, review takes and ask for a fix. Every tap target is at least 44 px.</p>
          <Chips items={["Home", "Record", "Make", "Atomik", "≥ 44 px targets"]} />
        </div>
      </Cols>
    </Section>
  );
}

function PricingTeaser({ prices }: { prices: SitePrices }) {
  return (
    <Section id="pricing" panel label="Pricing">
      <Head eyebrow="Pricing" title="Credits, not seats."
        lead={`1 credit = US${usd(prices.perCredit)}. Plans differ on credits and features, never headcount.`}
        aside={<Link href={PRICING_HREF} className="mk-btn mk-btn--secondary" style={{ height: 38 }}>Plans, packs and the rate card →</Link>} />
      <Grid col={230}>
        {prices.plans.map((plan) => (
          <Link key={plan.id} href={PRICING_HREF} className={`mk-card${plan.id === "agency" ? " mk-card--hl" : ""}`}>
            <span className={`mk-tag${plan.id === "agency" ? "" : " mk-tag--muted"}`}>{plan.label}</span>
            <span className="mk-plan-price">{usd(plan.priceUsd)}{plan.priceUsd > 0 && <small>/mo</small>}</span>
            <span className="mk-body">{planLines(plan, prices.inviteCredits).slice(0, 3).join(" · ")}</span>
          </Link>
        ))}
      </Grid>
    </Section>
  );
}

function RequestAccess({ member }: { member: boolean }) {
  return (
    <section id="access" className="mk-section mk-access" aria-label="Request access">
      <div className="mk-wrap">
        <span style={{ color: "var(--gx-accent-text)" }}><ParticlMark size={24} /></span>
        <h2 className="mk-h2">Invite-only, built for small teams.</h2>
        <p className="mk-lead">A stranger with an invite gets from email to first render in five minutes. Invites are one-time links, sent by a person.</p>
        {member ? (
          <a href={APP_HREF} className="mk-btn gx-primary" style={{ height: 44 }}>Open Particl</a>
        ) : (
          <>
            <AccessForm />
            <p className="mk-body">Already invited? <a href={SIGN_IN_HREF}>Sign in</a></p>
          </>
        )}
      </div>
    </section>
  );
}
