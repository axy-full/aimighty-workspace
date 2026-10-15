"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { fmtCredits, useMoney } from "@/lib/price";
import { creditRate, creditsUsd } from "@/lib/shell/price-words";
import { creditRateLine } from "@/lib/creditTerms";
import { HOUSE_NOT_BILLED } from "@/lib/houseWorkspace";
import { houseCapUsdText, houseCapWarning, type HouseCapView } from "@/lib/houseCapText";
import { fmtLedgerUsd, type CreditLedgerRow, type DollarLedgerRow } from "@/lib/usageLedgerTerms";
import type { BillingSubscription, Topups } from "@/lib/shell/workspace-view";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { PlanPicker } from "./PlanPicker";
import { LOW_CREDIT_PERCENT } from "@/lib/v12/lowCredit";
import { useLowCredit } from "@/lib/v12/useLowCredit";
import { boardRows, cycleDates, cycleNow, dollarBoards, dollarHistoryRows, historyRows, planNowOf, signedCredits, takesWords, type BillingCycle } from "@/lib/v12/billing";
import { monthKey, monthLine, monthTotalsOf, planView, topUpLabel, topUpPack, type PlanDefLike } from "@/components/graphite/settings/model";
import { useRead } from "@/components/graphite/settings/use-settings";
import "./billing.css";

/**
 * Settings › Credits & billing in the new interface (docs/redesign-plan.md, item B2; docs/redesign/inventory.md § 5.6;
 * prototype `?view=billing`). Display only: every figure is a route's answer (lib/v12/billing.ts lists them) and the
 * plan cards are the owner's plans, display only (lib/planCards.ts, from lib/plans.ts).
 *
 * Top up does not request, charge or pay here: it opens today's flow, unchanged (Settings › Plan & credits with its packs
 * open, `onTopUp`). The house workspace pays in dollars, at the engines' cost, and is never shown credit figures: it gets the
 * same page in dollars from the Usage reads (GET /api/usage for spend by board, GET /api/usage?rows=1 for history and the
 * CSV), with no plans, no top-up and no balance.
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
  /* The house (lib/houseWorkspace.ts): the server hands "usd" to no other workspace. */
  const inDollars = session.rates.unit === "usd";
  const money = useMoney();
  const rate = creditRate(session.rates.creditUsd);
  const balance = account?.credits?.balance ?? session.credits?.balance ?? null;
  const rule = useLowCredit(balance);
  /* The month as the page opened: the ledger files a job by when it started (UTC). */
  const [now] = useState(() => Date.now());
  const [chooseNote, setChooseNote] = useState(false);
  const month = monthKey(now);
  const billing = useRead<Billing>(inCredits ? "/api/billing" : null);
  const topups = useRead<Topups>(inCredits ? "/api/workspaces/topups" : null);
  const ledger = useRead<{ unit?: string; rows?: CreditLedgerRow[] }>(inCredits ? `/api/usage?rows=1&month=${month}&limit=20` : null);
  const boards = useRead<unknown>(inCredits ? `/api/usage/boards?month=${month}` : null);
  /* The house reads the same Usage routes in their dollar form: the board totals (all time) and the month's dollar ledger. */
  const usage = useRead<{ spentUsd?: number; byProject?: unknown }>(inDollars ? "/api/usage" : null);
  /* The house's monthly engine cap and the month so far (lib/houseCap.ts). */
  const cap = useRead<{ houseCap?: HouseCapView | null }>(inDollars ? "/api/usage/house-cap" : null);
  const houseCap = cap.data?.houseCap ?? null;
  const dollarLedger = useRead<{ unit?: string; rows?: DollarLedgerRow[] }>(inDollars ? `/api/usage?rows=1&month=${month}&limit=20` : null);

  const totals = monthTotalsOf(ledger.data);
  const plan = planNowOf(billing.data);
  const sub = planView(billing.data?.plans, billing.data?.subscription);
  const cycle = cycleNow(billing.data?.cycles, now);
  /* As today's screen: only an owner or admin requests credits; a member is told who can. */
  const pack = topups.data?.applies && topups.data.canRequest ? topUpPack(topups.data.packs) : null;
  const askAdmin = Boolean(topups.data?.applies && !topups.data.canRequest);
  const history = historyRows(ledger.data?.unit === "credits" ? ledger.data.rows : [], topups.data?.history ?? [], now);
  const perBoard = boardRows(boards.data);
  const dollarBoardList = dollarBoards(usage.data);
  const dollarHistory = dollarHistoryRows(dollarLedger.data?.unit === "usd" ? dollarLedger.data.rows : [], now);
  const spentAll = typeof usage.data?.spentUsd === "number" ? usage.data.spentUsd : null;

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
          {inDollars ? (
            <>
              <div className="v12-bill-row" data-testid="v12-billing-house">
                <span>Billing</span>
                <span>In dollars, at the engines’ cost</span>
              </div>
              <div className="v12-bill-row" data-testid="v12-billing-spent">
                <span>Spent · all time</span>
                <span className="v12-bill-mono v12-bill-accent">{spentAll != null ? money.price(spentAll) : usage.error ? "—" : "Reading…"}</span>
              </div>
              {houseCap ? (
                <div className="v12-bill-row" data-testid="v12-billing-house-cap" data-state={houseCap.stop ? "stop" : houseCap.warn ? "warn" : "ok"}>
                  <span>Monthly cap</span>
                  <span className={houseCap.warn ? "v12-bill-low" : undefined}>
                    {houseCap.warn ? <span className="v12-bill-dot" aria-hidden="true" /> : null}
                    {houseCap.stop ? `Reached · ${houseCapUsdText(houseCap.capUsd)} used` : houseCap.warn ? houseCapWarning(houseCap) : `${houseCapUsdText(houseCap.capUsd)} · ${houseCap.pct}% used`}
                  </span>
                </div>
              ) : null}
              <div className="v12-bill-row" data-testid="v12-billing-no-topup">
                <span>Top up</span>
                <span className="v12-bill-quiet">None: this workspace has no credits to buy.</span>
              </div>
              {usage.error ? <Problem text={usage.error} onRetry={() => void usage.read()} /> : null}
            </>
          ) : !inCredits ? <div className="v12-bill-empty">{HOUSE_NOT_BILLED}</div> : (
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

        {inDollars ? (
          <section className="v12-bill-sec" data-testid="v12-billing-boards">
            <span className="v12-bill-eyebrow">Per board · all time</span>
            {usage.error ? <Problem text={usage.error} onRetry={() => void usage.read()} /> : dollarBoardList === null ? <div className="v12-bill-empty">Reading…</div> : null}
            {dollarBoardList?.map((b) => (
              <div key={b.name} className="v12-bill-board" data-testid="v12-billing-board">
                <span><span className="v12-bill-board-name">{b.name}</span><span className="v12-bill-sub">{takesWords(b.n)}</span></span>
                <span className="v12-bill-mono">{money.price(b.usd)}</span>
                <span />
              </div>
            ))}
            {dollarBoardList && !dollarBoardList.length ? <div className="v12-bill-empty">Nothing spent yet.</div> : null}
          </section>
        ) : null}

        {inDollars ? (
          <section className="v12-bill-sec" data-testid="v12-billing-history">
            <span className="v12-bill-eyebrow">History · this month</span>
            {dollarLedger.error ? <Problem text={dollarLedger.error} onRetry={() => void dollarLedger.read()} /> : null}
            {dollarHistory.map((h) => (
              <div key={h.id} className="v12-bill-hist" data-testid="v12-billing-history-row">
                <span className="v12-bill-quiet" style={{ fontSize: 13 }}>{h.when}</span>
                <span title={h.what}>{h.what}</span>
                <span className="v12-bill-mono">{fmtLedgerUsd(h.usd)}</span>
              </div>
            ))}
            {dollarLedger.data && !dollarHistory.length ? <div className="v12-bill-empty">Nothing spent this month yet.</div> : null}
            <a className="v12-bill-btn v12-bill-export" href={`/api/usage?rows=1&format=csv&month=${month}`} download data-testid="v12-billing-export">Export for billing · CSV</a>
          </section>
        ) : null}

        {inCredits ? (
          <section className="v12-bill-sec" data-testid="v12-billing-plans">
            <div className="v12-bill-head">
              <span className="v12-bill-eyebrow">Plans</span>
              <span className="v12-bill-meta">Monthly · checkout is not open yet</span>
            </div>
            <PlanPicker plans={billing.data?.plans} current={plan?.id ?? null} onChoose={() => setChooseNote(true)} />
            {chooseNote ? <div className="v12-bill-quiet" role="status" data-testid="v12-billing-choose-note">Checkout is not open yet. Nothing was changed.</div> : null}
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

function Problem({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="v12-bill-problem" role="alert">
      <span>{text}</span>
      <button type="button" className="v12-bill-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}
