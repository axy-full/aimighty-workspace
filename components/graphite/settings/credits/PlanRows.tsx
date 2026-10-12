"use client";
import { useState } from "react";
import { BUSINESS, ENTERPRISE, cleanPlans, DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { businessFrom, businessLevels, individualCards } from "@/lib/planCards";
import { Btn, Note, Row, Section } from "../parts";

/**
 * The plans on the phone's Settings › Plan & credits, the same ones the desktop shows (lib/plans.ts through lib/planCards.ts, prototype v14):
 * Individual (Explore, Create, Master, each with its line), Business (from the lowest level per seat, its three levels) and Enterprise ("Get in
 * touch"). Every name, price and credit figure is read from the platform layer's plans that GET /api/billing already returned (the defaults
 * when it has none); nothing is typed here. Display only: Choose says what the desktop's says, and nothing is charged or changed.
 */
const money = (usd: number) => `$${usd.toLocaleString("en-US")}`;
const count = (n: number) => n.toLocaleString("en-US");
export const PLAN_NOTE = "Checkout is not open yet. Nothing was changed.";

export function PlanRows({ plans, current }: { plans: readonly unknown[] | undefined; current: string | null }) {
  const layer: PlanDef[] = plans && plans.length ? cleanPlans(plans) : DEFAULT_PLANS;
  const individual = individualCards(layer);
  const levels = businessLevels(layer);
  const [note, setNote] = useState(false);
  const choose = (id: string) => (
    <Btn disabled={current === id} onClick={() => setNote(true)} testId="settings-plan-choose">{current === id ? "Current plan" : "Choose"}</Btn>
  );
  return (
    <>
      <Section label="Plans" meta="Monthly · checkout is not open yet" testId="settings-plans-individual">
        {individual.map((card) => (
          <Row key={card.id} name={card.name} line={card.blurb ?? undefined} value={`${money(card.priceUsd)}/month · ${count(card.credits)} credits`} testId="settings-plan-card">
            {choose(card.id)}
          </Row>
        ))}
      </Section>
      <Section label={BUSINESS.label} meta={`from ${money(businessFrom(layer))} per seat`} testId="settings-plans-business">
        <Row name={BUSINESS.label} line={BUSINESS.note} />
        {levels.map((l) => (
          <Row key={l.id} name={l.name} line={`${money(l.perSeatUsd)} per seat/month · ${count(l.perSeatCredits)} credits per seat`} testId="settings-plan-level">
            {choose(l.id)}
          </Row>
        ))}
      </Section>
      <Section label={ENTERPRISE.label} testId="settings-plans-enterprise">
        <Row name={`${ENTERPRISE.label} — ${ENTERPRISE.blurb}`} testId="settings-plan-enterprise">
          <Btn onClick={() => setNote(true)}>{ENTERPRISE.line}</Btn>
        </Row>
        {note ? <Note ok text={PLAN_NOTE} testId="settings-plan-choose-note" /> : null}
      </Section>
    </>
  );
}
