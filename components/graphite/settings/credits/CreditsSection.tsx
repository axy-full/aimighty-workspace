"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { creditRate, creditsText, creditsUsd } from "@/lib/shell/price-words";
import { revealClear } from "@/lib/shell/reveal";
import type { SettingsFold } from "@/lib/shell/settings";
import {
  checkoutUrl, grantRow, packLine, requestLine, requestRows, statementCsvHref, statementHref, statementMonthsOf, usageRows,
  type BillingSubscription, type Topups, type UsageBody,
} from "@/lib/shell/workspace-view";
import { leftFrom, type RateGroup, type WorkspaceReach } from "@/lib/mediaReach";
import { RateCard, ReachPair, ReachTile, leftAt } from "@/components/commercial/MediaReach";
import { UsageLedger } from "@/components/graphite/UsageLedger";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { Btn, Fold, Folded, LinkBtn, Note, Problem, Row, Section } from "../parts";
import { creditPriceLine, creditsWithUsd, monthKey, monthLine, monthTotalsOf, planView, topUpLabel, topUpPack, type PlanDefLike } from "../model";
import { lostConnection, useRead, useWrite } from "../use-settings";

/**
 * Settings › Plan & credits (README § 3.5; Workspace's Plans & credits and Usage tabs, § 1.2).
 *
 * The balance in credits with its dollars at the server's credit rate; what this month settled and what
 * running jobs hold (the ledger's own totals, GET /api/usage?rows=1); Top up, which is today's pack
 * request (POST /api/workspaces/topups: the owner or an admin asks, the platform approves, nothing is
 * charged here); the plan as GET /api/billing holds it. Packs, requests, credit history, usage,
 * statements and the rate card stay one fold away. A workspace billed in dollars on its own engines
 * shows no credit figures and no vendor dollars (DECISIONS 6).
 */
type Billing = { canManage: boolean; plans?: PlanDefLike[]; subscription?: BillingSubscription | null; reach?: WorkspaceReach | null; rates?: RateGroup[] | null };

export function CreditsSection({ account, open }: { account: WorkspaceAccount | null; open: SettingsFold | null }) {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const rate = creditRate(session.rates.creditUsd);
  const inCredits = session.rates.unit !== "usd";
  const balance = account?.credits?.balance ?? session.credits?.balance ?? null;
  const billing = useRead<Billing>("/api/billing");
  const topups = useRead<Topups>("/api/workspaces/topups");
  /* The month as the page opened: the ledger files a job by when it started (UTC). */
  const [month] = useState(() => monthKey(Date.now()));
  const ledger = useRead<unknown>(inCredits ? `/api/usage?rows=1&month=${month}` : null);
  const totals = monthTotalsOf(ledger.data);

  const [busy, setBusy] = useState<string | null>(null);
  const writing = useRef(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (note) revealClear(noteRef.current); }, [note]);
  const write = useWrite();

  const applies = Boolean(topups.data?.applies);
  const packs = applies ? topups.data!.packs : [];
  const canRequest = Boolean(topups.data?.canRequest);
  const requests = applies ? requestRows(topups.data!.requests) : [];
  const waiting = requests.filter((r) => r.status === "requested");
  const openLimit = topups.data?.openLimit ?? 3;
  const full = waiting.length >= openLimit;
  const first = topUpPack(packs);

  /* Today's request, as Workspace › Plans & credits makes it: one at a time, its answers word for word. */
  const request = async (packId: string) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(packId); setNote(null);
    const { json, error: refused } = await write<{ checkout?: { kind: string; url?: string }; emailed?: boolean }>("/api/workspaces/topups", "POST", { packId });
    writing.current = false;
    setBusy(null);
    if (refused) { setNote({ ok: false, text: lostConnection(refused) ? "The request was not confirmed. Check Requests below before asking again; nothing is charged either way." : refused }); void topups.read(); return; }
    if (json?.checkout?.kind === "redirect") {
      const url = checkoutUrl(json.checkout.url, window.location.origin);
      if (url) { window.location.assign(url); return; }
      setNote({ ok: false, text: "Checkout returned an address this page will not open." }); return;
    }
    setNote({ ok: true, text: `Requested. ${json?.emailed ? "The platform admin was emailed" : "It waits on the platform desk"}; nothing is charged here, and the credits land once payment is confirmed.` });
    void topups.read();
  };
  const withdraw = async (id: string) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(id); setNote(null);
    const { error: refused } = await write(`/api/workspaces/topups?id=${encodeURIComponent(id)}`, "DELETE");
    writing.current = false;
    setBusy(null);
    setNote(refused ? { ok: false, text: lostConnection(refused) ? "The withdrawal was not confirmed. Requests below show where it stands." : refused } : { ok: true, text: "Request withdrawn." });
    void topups.read();
  };

  const plan = planView(billing.data?.plans, billing.data?.subscription);
  const shown = balance != null && inCredits ? creditsWithUsd(balance, rate) : null;
  const topUp = first && canRequest ? (
    <button type="button" className="gs-primary" disabled={busy != null || full} title={full ? `${openLimit} requests are waiting` : undefined} onClick={() => void request(first.id)} data-testid="settings-top-up">
      {busy === first.id ? "Requesting…" : topUpLabel(first)}
    </button>
  ) : null;

  return (
    <>
      <Section label="Balance" meta={inCredits ? "one wallet for the workspace" : undefined} action={topUp} testId="settings-balance">
        {inCredits ? (
          <>
            <Row name="Credits" line={creditPriceLine(rate) ?? undefined} accent testId="settings-balance-credits"
              value={shown ? <>{shown.text}{shown.usd ? <span className="gs-usd"> · {shown.usd}</span> : null}</> : "— cr"} valueTitle={shown?.usd} />
            <Row name="This month" line="settled after the provider confirmed it" testId="settings-month"
              value={totals ? monthLine(totals) : ledger.error ? "—" : "Reading…"}
              valueTitle={totals ? [creditsUsd(totals.charged, rate), totals.held > 0 ? `${creditsUsd(totals.held, rate)} held` : null].filter(Boolean).join(" · ") || null : null} />
            {ledger.error ? <Problem text={ledger.error} onRetry={() => void ledger.read()} /> : null}
          </>
        ) : (
          <Row name="Credits" line="This workspace runs on its own engines and is not billed in credits." value="—" testId="settings-balance-credits" />
        )}
        {applies && !canRequest && topups.data ? <Row name="Top up" line="Ask an admin: the owner or an admin requests credits." testId="settings-top-up-ask" /> : null}
        {canRequest && full ? <Row name="Top up" line={`${openLimit} requests are waiting. Withdraw one, or wait for an answer.`} testId="settings-top-up-full" /> : null}
        {topups.error ? <Problem text={topups.error} onRetry={() => void topups.read()} testId="settings-topups-error" /> : null}
        {note ? <div ref={noteRef}><Note ok={note.ok} text={note.text} testId="settings-credits-note" /></div> : null}
      </Section>

      <Section label="Plan" meta={billing.data ? plan.meta : undefined} testId="settings-plan">
        {billing.error ? <Problem text={billing.error} onRetry={() => void billing.read()} /> : !billing.data ? <Row name="Reading the plan…" /> : null}
        {plan.included != null ? <Row name="Included" line="per month · no rollover" value={creditsText(plan.included)} valueTitle={creditsUsd(plan.included, rate)} testId="settings-plan-included" /> : null}
        {plan.status ? <Row name="Status" value={plan.status} /> : null}
        {billing.data ? (
          <Row name={plan.renews ? plan.renews.word : "Plan"} value={plan.renews?.date} line={plan.renews ? undefined : "Plans are chosen on the billing page"} testId="settings-plan-renews">
            {billing.data.canManage ? <LinkBtn href="/billing" testId="settings-change-plan">{billing.data.subscription?.planId ? "Change plan" : "Choose a plan"}</LinkBtn> : null}
          </Row>
        ) : null}
      </Section>

      {applies ? (
        <Folded name="packs" open={open} label="Packs and requests" meta={waiting.length ? `${waiting.length} waiting` : "a request, approved by the platform"}>
          {packs.map((p) => (
            <Row key={p.id} name={p.label} line={packLine(p)} testId="settings-pack">
              {canRequest ? <Btn disabled={busy != null || full} onClick={() => void request(p.id)} testId="settings-pack-request">{busy === p.id ? "Requesting…" : "Request"}</Btn> : null}
            </Row>
          ))}
          {requests.map((r) => (
            <Row key={r.id} name={requestLine(r)} testId="settings-topup-request">
              {r.status === "requested" && canRequest ? <Btn disabled={busy != null} onClick={() => void withdraw(r.id)} testId="settings-topup-withdraw">{busy === r.id ? "Withdrawing…" : "Withdraw"}</Btn> : null}
            </Row>
          ))}
        </Folded>
      ) : null}
      {applies ? (
        <Folded name="history" open={open} label="Credit history" meta="what came in and went out">
          {(topups.data?.history ?? []).map((g) => {
            const row = grantRow(g);
            return <Row key={g.id} name={row.what} line={row.when || undefined} value={row.amount} testId="settings-grant" />;
          })}
          {topups.data && !(topups.data.history ?? []).length ? <Row name="No credits in or out yet." /> : null}
        </Folded>
      ) : null}
      {inCredits ? <Usage open={open} /> : null}
      {admin && inCredits ? <Statements open={open} /> : null}
      {inCredits && (billing.data?.rates || billing.data?.reach) ? (
        <Folded name="rates" open={open} label="Credits per take" meta="what the balance buys">
          {billing.data.reach ? (
            <div className="gs-embed">
              <ReachPair testId="settings-reach"
                video={billing.data.reach.video ? <ReachTile kind="video" count={leftFrom(balance, billing.data.reach.video)} take={billing.data.reach.video} suffix={leftAt(billing.data.reach.video.basis)} /> : null}
                image={billing.data.reach.image ? <ReachTile kind="image" count={leftFrom(balance, billing.data.reach.image)} take={billing.data.reach.image} suffix={leftAt(billing.data.reach.image.basis)} /> : null} />
            </div>
          ) : null}
          {billing.data.rates ? <div className="gs-embed"><RateCard groups={billing.data.rates} reference={billing.data.reach ?? null} legend="Your balance is counted at the outlined prices." testId="settings-rate-card" /></div> : null}
        </Folded>
      ) : null}
    </>
  );
}

function Usage({ open }: { open: SettingsFold | null }) {
  const [shown, setShown] = useState(open === "usage");
  const { data, error, read } = useRead<UsageBody>(shown ? "/api/usage" : null);
  const { unit, rows, total } = usageRows(data);
  const list = unit === "cr" ? rows.filter((r) => r.amount > 0 || r.n > 0).sort((a, b) => b.amount - a.amount) : [];
  return (
    <Fold label="Usage" meta="settled, by engine" open={shown} onToggle={() => setShown((v) => !v)} testId="settings-fold-usage">
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <Row name="Reading usage…" /> : null}
      {data && unit === "cr" ? <Row name="All time" value={`${creditsText(Math.round(total))} settled`} testId="settings-usage-total" /> : null}
      {list.map((r) => <Row key={r.id} name={r.label} line={`${r.n} ${r.n === 1 ? "job" : "jobs"}`} value={creditsText(Math.round(r.amount))} testId="settings-usage-row" />)}
      {data && unit === "cr" && !list.length ? <Row name="Nothing settled yet." /> : null}
      {data && unit === "cr" ? <div className="gs-embed"><UsageLedger /></div> : null}
    </Fold>
  );
}

function Statements({ open }: { open: SettingsFold | null }) {
  const [shown, setShown] = useState(open === "statements");
  const { data, error, read } = useRead<unknown>(shown ? "/api/statements" : null);
  const months = statementMonthsOf(data).slice(0, 12);
  return (
    <Fold label="Statements" meta="a printable month, or CSV" open={shown} onToggle={() => setShown((v) => !v)} testId="settings-fold-statements">
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <Row name="Reading statements…" /> : null}
      {months.map((m) => (
        <Row key={m.month} name={m.month} line={`${m.takes} ${m.takes === 1 ? "take" : "takes"}`} testId="settings-statement">
          <LinkBtn href={statementHref(m.month)}>Open</LinkBtn>
          <a className="gs-btn" href={statementCsvHref(m.month)} download aria-label={`${m.month} as CSV`}>CSV</a>
        </Row>
      ))}
      {data && !months.length ? <Row name="Nothing billed yet." /> : null}
    </Fold>
  );
}
