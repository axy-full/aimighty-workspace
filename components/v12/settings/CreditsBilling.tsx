"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { fmtCredits } from "@/lib/price";
import { creditRate, creditsUsd } from "@/lib/shell/price-words";
import { creditRateLine } from "@/lib/creditTerms";
import { HOUSE_NOT_BILLED } from "@/lib/houseWorkspace";
import type { CreditLedgerRow } from "@/lib/usageLedgerTerms";
import type { BillingSubscription, Topups } from "@/lib/shell/workspace-view";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { HERO_TAKE, PLAN_CARDS, type PlanCard } from "@/lib/marketing/planCards";
import { LOW_CREDIT_PERCENT } from "@/lib/v12/lowCredit";
import { useLowCredit } from "@/lib/v12/useLowCredit";
import { useQuote } from "@/lib/v12/useQuote";
import { boardRows, cycleDates, cycleNow, heroTakes, historyRows, planNowOf, signedCredits, takesWords, type BillingCycle } from "@/lib/v12/billing";
import { monthKey, monthLine, monthTotalsOf, planView, topUpLabel, topUpPack, type PlanDefLike } from "@/components/graphite/settings/model";
import { useRead } from "@/components/graphite/settings/use-settings";
import "./billing.css";

/**
 * Settings › Credits & billing in the new interface (docs/redesign-plan.md, item B2; docs/redesign/inventory.md § 5.6;
 * prototype `?view=billing`). Display only: every figure is a route's answer (lib/v12/billing.ts lists them) and the
 * plan cards are the display-only placeholders in lib/marketing/plans' sibling, lib/marketing/planCards.ts.
 *
 * Top up does not request, charge or pay here: it opens today's flow, unchanged (Settings › Plan & credits with its packs
 * open, `onTopUp`). The house workspace pays in dollars and is never shown credit figures.
 */
type Billing = { canManage?: boolean; plans?: PlanDefLike[]; subscription?: BillingSubscription | null; cycles?: BillingCycle[]; plan?: unknown };

export function CreditsBilling({ account, onTopUp, onOpenBoard }: {
  account: WorkspaceAccount | null;
  /** Today's top-up flow. */
  onTopUp: () => void;
  /** Opens a board by its project id. */
  onOpenBoard: (projectId: string) => void;
}) {
  const session = useSession();
  const inCredits = session.rates.unit === "cr" && Boolean(session.credits);
  const rate = creditRate(session.rates.creditUsd);
  const balance = account?.credits?.balance ?? session.credits?.balance ?? null;
  const rule = useLowCredit(balance);
  /* The month as the page opened: the ledger files a job by when it started (UTC). */
  const [now] = useState(() => Date.now());
  const month = monthKey(now);
  const billing = useRead<Billing>(inCredits ? "/api/billing" : null);
  const topups = useRead<Topups>(inCredits ? "/api/workspaces/topups" : null);
  const ledger = useRead<{ unit?: string; rows?: CreditLedgerRow[] }>(inCredits ? `/api/usage?rows=1&month=${month}&limit=20` : null);
  const boards = useRead<unknown>(inCredits ? `/api/usage/boards?month=${month}` : null);
  const hero = useQuote(inCredits ? { route: "engine", ...HERO_TAKE } : null);

  const totals = monthTotalsOf(ledger.data);
  const plan = planNowOf(billing.data);
  const sub = planView(billing.data?.plans, billing.data?.subscription);
  const cycle = cycleNow(billing.data?.cycles, now);
  /* As today's screen: only an owner or admin requests credits; a member is told who can. */
  const pack = topups.data?.applies && topups.data.canRequest ? topUpPack(topups.data.packs) : null;
  const askAdmin = Boolean(topups.data?.applies && !topups.data.canRequest);
  const history = historyRows(ledger.data?.unit === "credits" ? ledger.data.rows : [], topups.data?.history ?? [], now);
  const perBoard = boardRows(boards.data);
  const perTake = hero.state === "ready" && hero.price.unit === "cr" && hero.price.value.kind !== "free" ? hero.price.value.credits : null;

  return (
    <div className="v12-bill" data-testid="v12-billing" data-screen-label="Settings · Credits & billing">
      <div className="v12-bill-col">
        <div>
          <div className="v12-bill-eyebrow">Settings</div>
          <h1 className="v12-bill-h1">Credits &amp; billing</h1>
        </div>

        <section className="v12-bill-sec" data-testid="v12-billing-balance">
          <div className="v12-bill-head">
            <span className="v12-bill-eyebrow">Balance</span>
            {inCredits && creditRateLine(rate) ? <span className="v12-bill-meta">{creditRateLine(rate)}</span> : null}
          </div>
          {!inCredits ? <div className="v12-bill-empty">{HOUSE_NOT_BILLED}</div> : (
            <>
              <div className="v12-bill-row" data-testid="v12-billing-credits">
                <span>Credits</span>
                <span className="v12-bill-mono v12-bill-accent" title={balance != null ? creditsUsd(balance, rate) ?? undefined : undefined}>{balance != null ? fmtCredits(balance) : "—"}</span>
              </div>
              <div className="v12-bill-row" data-testid="v12-billing-plan">
                <span>Plan</span>
                <span>{billing.data ? (plan?.label ?? sub.meta) : billing.error ? "—" : "Reading…"}</span>
              </div>
              {cycle ? (
                <div className="v12-bill-row" data-testid="v12-billing-cycle">
                  <span>This cycle</span>
                  <span>{cycleDates(cycle)} <span className="v12-bill-quiet">· {fmtCredits(cycle.credits)} included</span></span>
                </div>
              ) : null}
              <div className="v12-bill-row" data-testid="v12-billing-month">
                <span>This month</span>
                <span className="v12-bill-mono">{totals ? monthLine(totals) : ledger.error ? "—" : "Reading…"}</span>
              </div>
              <div className="v12-bill-row" data-testid="v12-billing-low" data-low={rule.low ? "true" : "false"}>
                <span>Low-balance chip</span>
                {rule.low ? (
                  <span className="v12-bill-low"><span className="v12-bill-dot" aria-hidden="true" />Showing now · below {fmtCredits(rule.threshold ?? 0)}</span>
                ) : (
                  <span className="v12-bill-quiet">below {LOW_CREDIT_PERCENT}% of your plan’s credits{rule.threshold != null ? ` · ${fmtCredits(rule.threshold)}` : ""}</span>
                )}
              </div>
              {billing.error ? <Problem text={billing.error} onRetry={() => void billing.read()} /> : null}
              {pack ? (
                <div className="v12-bill-act">
                  <button type="button" className="v12-bill-primary" onClick={onTopUp} title={`$${pack.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} data-testid="v12-billing-top-up">{topUpLabel(pack)}</button>
                </div>
              ) : askAdmin ? (
                <div className="v12-bill-act"><span className="v12-bill-quiet" data-testid="v12-billing-ask-admin">Ask an admin: the owner or an admin requests credits.</span></div>
              ) : null}
            </>
          )}
        </section>

        {inCredits ? (
          <section className="v12-bill-sec" data-testid="v12-billing-plans">
            <div className="v12-bill-head">
              <span className="v12-bill-eyebrow">Plans</span>
              <span className="v12-bill-meta">Placeholders · names and prices are not final</span>
            </div>
            <div className="v12-bill-cards">
              {PLAN_CARDS.map((card) => <PlanCardView key={card.id} card={card} perTake={perTake} rate={rate} />)}
            </div>
          </section>
        ) : null}

        {inCredits ? (
          <section className="v12-bill-sec" data-testid="v12-billing-boards">
            <span className="v12-bill-eyebrow">Per board · this month</span>
            {boards.error ? <Problem text={boards.error} onRetry={() => void boards.read()} /> : perBoard === null ? <div className="v12-bill-empty">Reading…</div> : null}
            {perBoard?.map((b) => (
              <div key={b.id ?? b.name} className="v12-bill-board" data-testid="v12-billing-board">
                <span><span className="v12-bill-board-name">{b.name}</span><span className="v12-bill-sub">{takesWords(b.n)}</span></span>
                <span className="v12-bill-mono" title={creditsUsd(b.credits, rate) ?? undefined}>{fmtCredits(b.credits)}</span>
                {b.id ? <button type="button" className="v12-bill-btn" onClick={() => onOpenBoard(b.id!)}>Open</button> : <span />}
              </div>
            ))}
            {perBoard && !perBoard.length ? <div className="v12-bill-empty">Nothing settled this month yet.</div> : null}
          </section>
        ) : null}

        {inCredits ? (
          <section className="v12-bill-sec" data-testid="v12-billing-history">
            <span className="v12-bill-eyebrow">History</span>
            {ledger.error ? <Problem text={ledger.error} onRetry={() => void ledger.read()} /> : null}
            {history.map((h) => (
              <div key={h.id} className="v12-bill-hist" data-testid="v12-billing-history-row">
                <span className="v12-bill-quiet" style={{ fontSize: 13 }}>{h.when}</span>
                <span title={h.what}>{h.what}</span>
                <span className={`v12-bill-mono${h.credits > 0 && !h.held ? " v12-bill-in" : ""}`} title={creditsUsd(Math.abs(h.credits), rate) ?? undefined}>{signedCredits(h, fmtCredits)}</span>
              </div>
            ))}
            {ledger.data && topups.data && !history.length ? <div className="v12-bill-empty">No credits in or out yet.</div> : null}
            <a className="v12-bill-btn v12-bill-export" href={`/api/usage?rows=1&format=csv&month=${month}`} download data-testid="v12-billing-export">Export for billing · CSV</a>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function PlanCardView({ card, perTake, rate }: { card: PlanCard; perTake: number | null; rate: number | null }) {
  const takes = card.line === "hero-takes" ? heroTakes(card.credits, perTake) : null;
  const line = card.line === "hero-takes" ? (takes != null ? `about ${takes} hero takes` : null) : card.line;
  return (
    <div className="v12-bill-card" data-testid="v12-billing-plan-card" data-plan={card.id}>
      <span className="v12-bill-card-name">{card.name}</span>
      <span className="v12-bill-mono" title={creditsUsd(card.credits, rate) ?? undefined}>{fmtCredits(card.credits)} · ${card.priceUsd.toLocaleString("en-US")}</span>
      {line ? <span className="v12-bill-sub">{line}</span> : null}
    </div>
  );
}

function Problem({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="v12-bill-problem" role="alert">
      <span>{text}</span>
      <button type="button" className="v12-bill-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}
