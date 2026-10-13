"use client";
import { useEffect, useRef, useState } from "react";
import { BUSINESS, ENTERPRISE, cleanPlans, DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { businessFrom, businessLevels, individualCards } from "@/lib/planCards";
import { Btn, Note, Row, Section } from "../parts";

/**
 * The plans on the phone's Settings › Plan & credits, the same ones the desktop shows (lib/plans.ts through lib/planCards.ts, prototype v14):
 * Individual (Explore, Create, Master, each with its line), Business (from the lowest level per seat, its three levels) and Enterprise ("Get in
 * touch"). Every name, price and credit figure is read from the platform layer's plans that GET /api/billing already returned (the defaults
 * when it has none); nothing is typed here. Display only: Choose says what the desktop's says, and nothing is charged or changed.
 * They are their own view, opened from Plan & credits' "See plans" row, so the credits page itself holds no dollar but the balance row's and the top-up
 * label (the ledger spec's strayDollars floor).
 */
const money = (usd: number) => `$${usd.toLocaleString("en-US")}`;
const count = (n: number) => n.toLocaleString("en-US");
export const PLAN_NOTE = "Checkout is not open yet. Nothing was changed.";

export function PlanRows({ plans, current, onBack }: { plans: readonly unknown[] | undefined; current: string | null; onBack: () => void }) {
  const layer: PlanDef[] = plans && plans.length ? cleanPlans(plans) : DEFAULT_PLANS;
  const individual = individualCards(layer);
  const levels = businessLevels(layer);
  /* The note shows in the section whose button was tapped, and is brought into view: on a phone the other sections are off screen. */
  const [note, setNote] = useState<"individual" | "business" | "enterprise" | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (note) noteRef.current?.scrollIntoView({ block: "center" }); }, [note]);
  const shown = (where: "individual" | "business" | "enterprise") => (note === where ? <div ref={noteRef}><Note ok text={PLAN_NOTE} testId="settings-plan-choose-note" /></div> : null);
  const choose = (id: string, where: "individual" | "business") => (
    <Btn disabled={current === id} onClick={() => setNote(where)} testId="settings-plan-choose">{current === id ? "Current plan" : "Choose"}</Btn>
  );
  return (
    <>
      <Section label="Plans" meta="Monthly · checkout is not open yet" testId="settings-plans-individual">
        <Row name="Plan & credits"><Btn onClick={onBack} testId="settings-plans-back">Back</Btn></Row>
        {individual.map((card) => (
          <Row key={card.id} name={card.name} line={card.blurb ?? undefined} value={`${money(card.priceUsd)}/month · ${count(card.credits)} credits`} testId="settings-plan-card">
            {choose(card.id, "individual")}
          </Row>
        ))}
        {shown("individual")}
      </Section>
      <Section label={BUSINESS.label} meta={`from ${money(businessFrom(layer))} per seat`} testId="settings-plans-business">
        <Row name={BUSINESS.label} line={BUSINESS.note} />
        {levels.map((l) => (
          <Row key={l.id} name={l.name} line={`${money(l.perSeatUsd)} per seat/month · ${count(l.perSeatCredits)} credits per seat`} testId="settings-plan-level">
            {choose(l.id, "business")}
          </Row>
        ))}
        {shown("business")}
      </Section>
      <Section label={ENTERPRISE.label} testId="settings-plans-enterprise">
        <Row name={`${ENTERPRISE.label} — ${ENTERPRISE.blurb}`} testId="settings-plan-enterprise">
          <Btn onClick={() => setNote("enterprise")}>{ENTERPRISE.line}</Btn>
        </Row>
        {shown("enterprise")}
      </Section>
    </>
  );
}
