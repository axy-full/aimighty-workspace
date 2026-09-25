import type { Metadata } from "next";
import Link from "next/link";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Cols, Grid, Head, Note, Section } from "@/components/marketing/ui";
import { creditRateUsd } from "@/lib/creditTerms";
import { BONUS_CAP } from "@/lib/packs";
import { count, cr, usd } from "@/lib/marketing/format";
import { PLAN_AUDIENCE, planLines } from "@/lib/marketing/plans";
import PlanCards, { type PlanCard } from "./PlanCards";
import s from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans, credit packs and the rate card, every figure computed from the rates the app bills from.",
};

export default async function Pricing() {
  const { perCredit, annualDiscountPercent, plans, inviteCredits, packs, rateCard } = await sitePrices();
  const unit = `$${creditRateUsd(perCredit) ?? perCredit}`;
  const cards: PlanCard[] = plans.map((plan) => ({
    id: plan.id, label: plan.label, priceUsd: plan.priceUsd,
    audience: PLAN_AUDIENCE[plan.id] ?? "", lines: planLines(plan, inviteCredits),
  }));

  return (
    <SitePage active="pricing">
      <Section id="plans" label="Plans" className={s.plans}>
        <PlanCards plans={cards} discountPercent={annualDiscountPercent}>
          <div className="mk-eyebrow">Pricing · 1 credit = US{unit}</div>
          <h1 className={`mk-h1 ${s.title}`}>Credits, not seats.</h1>
          <p className={`mk-lead ${s.lead}`}>Paid plans differ on credits and features, never headcount. Renders bill the workspace&rsquo;s own balance; every take carries who made it and what it cost.</p>
        </PlanCards>
        <Grid className={`${s.notes} ${s.four}`}>
          <Note lead="Included credits expire at cycle end.">No rollover.</Note>
          <Note lead="No seat fees">on any paid plan.</Note>
          <Note lead="Pack credits sit still on a paid plan.">Off a plan, they last 12 months.</Note>
          <Note lead="Failed renders">are never billed.</Note>
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
            <p className="mk-lead">Every figure is computed from the live engine rate, never hand-edited, and rounded up to the next whole credit. Batches multiply before rounding. The quote on the button is the one you pay.</p>
            <Link href="/#gen-engines" className={`mk-btn mk-btn--secondary ${s.more}`}>The engines &rarr;</Link>
          </div>
          <div className={`mk-card ${s.table}`}>
            <table>
              <thead>
                <tr><th scope="col">Action</th><th scope="col">Sells at</th></tr>
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
            <p className={s.foot}>Voice lines are priced per character and have no single row. Motion transfer and Marketing Studio jobs take a live quote first.</p>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
