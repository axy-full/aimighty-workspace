import type { Metadata } from "next";
import Link from "next/link";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Cols, Grid, Head, Note, Section } from "@/components/marketing/ui";
import { creditRateUsd } from "@/lib/creditTerms";
import { BONUS_CAP } from "@/lib/packs";
import { count, cr, usd } from "@/lib/marketing/format";
import { PLAN_AUDIENCE, planLines } from "@/lib/marketing/plans";
import { ENTERPRISE, businessFromUsd, plansIn, type PlanDef } from "@/lib/plans";
import PlanCards, { type PlanCard } from "./PlanCards";
import s from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans, credit packs and the rate card.",
};

export default async function Pricing() {
  const { perCredit, plans, inviteCredits, packs, rateCard } = await sitePrices();
  const unit = `$${creditRateUsd(perCredit) ?? perCredit}`;
  const card = (plan: PlanDef, badge?: string): PlanCard => ({
    id: plan.id, label: plan.label, price: usd(plan.priceUsd), unit: "/mo", badge, cta: "Request access",
    audience: plan.blurb ?? PLAN_AUDIENCE[plan.id] ?? "", lines: planLines(plan, inviteCredits),
  });
  const individual = plansIn(plans, "individual").map((plan) => card(plan, plan.badge ?? undefined));
  const levels = plansIn(plans, "business");
  const from = businessFromUsd(plans);
  /* The team plans are one card: the lowest level's price a seat, and each level's credits a seat, pooled across the seats. The public
     site does not print the plans' in-app names (its retired words, tests/unit/publicSitePages.spec.ts): levels read by price. */
  const business: PlanCard = {
    id: "business", label: "Team seats", price: from == null ? null : `from ${usd(from)}`, unit: " per seat · a month", cta: "Request access",
    audience: "A team sharing one pool of credits. One level at a time.",
    lines: [
      ...levels.map((plan) => `${count(plan.includedCredits)} credits a seat · ${usd(plan.priceUsd)} a seat`),
      "Credits pooled across every seat",
      ...planLines(levels[0] ?? plans[0], inviteCredits).slice(3),
    ],
  };
  const enterprise: PlanCard = { id: ENTERPRISE.id, label: ENTERPRISE.label, price: null, unit: "", cta: "Get in touch", audience: "Your own terms, volume and setup.", lines: [] };

  return (
    <SitePage active="pricing">
      <Section id="plans" label="Plans" className={s.plans}>
        <PlanCards individual={individual} team={[business, enterprise]}>
          <div className="mk-eyebrow">Pricing · 1 credit = US{unit}</div>
          <h1 className={`mk-h1 ${s.title}`}>Pick a plan. Credits are the unit.</h1>
          <p className={`mk-lead ${s.lead}`}>One person pays a month for their credits. A team pays a seat a month, and the seats' credits are pooled.</p>
        </PlanCards>
        <Grid className={s.notes}>
          <Note lead="Included credits expire at cycle end.">No rollover.</Note>
          <Note lead="Team plans are priced a seat,">and their credits are pooled across the seats.</Note>
          <Note lead="Pack credits sit still on a paid plan.">Off a plan, they last 12 months.</Note>
        </Grid>
      </Section>

      <Section id="packs" panel label="Credit packs" className={s.band}>
        <Head eyebrow="Credit packs" title="Top up when a production runs long."
          aside={<p className={`mk-lead ${s.aside}`}>The unit stays {unit}. Pack discounts come only as bonus credits, capped at {Math.round(BONUS_CAP * 100)}%.</p>} />
        <Grid className={s.four}>
          {packs.map((pack) => (
            <div key={pack.id} className={`mk-card ${s.pack}`}>
              <span className="mk-tag mk-tag--muted">{pack.label}</span>
              <span className={s.packPrice}>{usd(pack.usd)}</span>
              <span className={s.packCredits}>
                {count(pack.credits)} cr{pack.bonus > 0 && <span className={s.bonus}> + {count(pack.bonus)}</span>}
              </span>
              <span className={s.perCredit}>${pack.perCredit.toFixed(3)} a credit</span>
            </div>
          ))}
        </Grid>
      </Section>

      <Section id="rate-card" label="Rate card" className={s.rates}>
        <Cols col={380} style={{ gap: "clamp(32px, 5vw, 72px)" }}>
          <div className={`mk-head ${s.copy}`}>
            <div className="mk-eyebrow">Rate card</div>
            <h2 className="mk-h2">What a render costs.</h2>
            <Link href="/#gen-engines" className={`mk-btn mk-btn--secondary ${s.more}`}>The engines &rarr;</Link>
          </div>
          <div className={`mk-card ${s.table}`}>
            <table>
              <thead>
                <tr><th scope="col">Action</th><th scope="col">Credits</th></tr>
              </thead>
              <tbody>
                {rateCard.map((row) => (
                  <tr key={`${row.action} ${row.spec}`}>
                    <td>{row.action} <span className={s.spec}>{row.spec}</span></td>
                    <td className={s.cr}>{cr(row.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
