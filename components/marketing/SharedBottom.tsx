import Link from "next/link";
import { ParticlMark } from "@/components/ParticlMark";
import type { SitePrices } from "@/lib/marketing/prices.server";
import { planLines } from "@/lib/marketing/plans";
import { usd } from "@/lib/marketing/format";
import { APP_HREF, PRICING_HREF, SIGN_IN_HREF, SIGN_UP_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";
import AccessForm from "./AccessForm";
import { Chips, Cols, Grid, Head, Section, Tile, Window } from "./ui";

/** The six places → Shell → Pricing teaser → Sign up: the end of every page. */
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
    <Section id="suites" panel label="Particl">
      <Head
        eyebrow="Studio · Ads · Social · Make · Atomik"
        title="One board per production."
        aside={<p className="mk-lead" style={{ fontSize: 15, maxWidth: "46ch" }}>Set the look first, with a look board and storyboard frames before any video. Every price is on the button, and a person approves the spend.</p>}
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
  ["Projects", "Home opens on your projects", "Recent projects, saved projects, a new one. A project is one brief and one cast across Studio, Ads and Social; switching waits for pending saves."],
  ["⌘K", "Palette", "Make, every page, Settings, models, assets and “Ask Atomik: …”. Enter runs the top hit."],
  ["Library", "Tools | Assets", "On every stage. Every tile drags onto any reference well or Board node. Download original is always the original bytes."],
  ["⌘J", "Inspector", "Controls, Inputs and Versions for whatever is selected: asset, take, run, node, item or stage."],
  ["Right-click", "Menu everywhere", "Copy, cut, paste, duplicate, move to, retry, and a 20-deep undo."],
  ["Enhancer", "One prompt enhancer", "One provider, chosen once in Settings. Never on raw: prompts."],
];

function Shell() {
  return (
    <Section id="shell" label="Shell">
      <Head eyebrow="The shell" title="The same room on every page."
        lead="Library on the left, Inspector on the right, one composer, one prompt enhancer. Every card is a button; nothing dead-ends in a toast." />
      <Cols col={420}>
        <Window path="⌘K · search everything" src={shot("palette-cmd-k")} alt="The ⌘K palette" width={924} height={540} />
        <Grid col={200}>
          {SHELL_TILES.map(([tag, name, body]) => <Tile key={tag} tag={tag} name={name} body={body} />)}
        </Grid>
      </Cols>
      <Cols col={300} style={{ alignItems: "center", marginTop: 16 }}>
        <div className="mk-head">
          <div className="mk-eyebrow">On a phone</div>
          <h3 className="mk-h3">The same room, one hand.</h3>
          <p className="mk-lead">Home · Workflow · Canvas · Takes · Edit in a tab bar, stage sheets that pull up over the work. Every tap target is at least 44 px.</p>
          <Chips items={["Home", "Workflow", "Canvas", "Takes", "Edit", "≥ 44 px targets"]} />
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
    <section id="access" className="mk-section mk-access" aria-label="Sign up">
      <div className="mk-wrap">
        <span style={{ color: "var(--gx-accent-text)" }}><ParticlMark size={24} /></span>
        <h2 className="mk-h2">Invite-only, built for small teams.</h2>
        <p className="mk-lead">A stranger with an invite gets from email to first render in five minutes. Invites are one-time links, sent by a person.</p>
        {member ? (
          <a href={APP_HREF} className="mk-btn gx-primary" style={{ height: 44 }}>Open Particl</a>
        ) : (
          <>
            <a href={SIGN_UP_HREF} className="mk-btn gx-primary" style={{ height: 44 }}>Sign up</a>
            <p className="mk-body">No invitation yet? Ask for one.</p>
            <AccessForm />
            <p className="mk-body">Already have an account? <a href={SIGN_IN_HREF}>Sign in</a></p>
          </>
        )}
      </div>
    </section>
  );
}
