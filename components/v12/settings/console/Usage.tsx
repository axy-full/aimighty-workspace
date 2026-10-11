"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { fmtCredits } from "@/lib/price";
import { creditRate, creditsUsd } from "@/lib/shell/price-words";
import { monthChoices } from "@/lib/v12/settingsConsole";
import { boardRows, takesWords } from "@/lib/v12/billing";
import { monthTotalsOf, monthLine } from "@/components/graphite/settings/model";
import { useRead } from "@/components/graphite/settings/use-settings";
import { Problem, Sec, initialsOf } from "./parts";

/**
 * Settings › Usage (an admin) and Your usage (a member): where the credits went in a month, by board and by person. The routes
 * decide who sees what: an admin reads a row per person, a member only their own (GET /api/usage/people), and the per-board
 * spend is the workspace's own (GET /api/usage/boards).
 */
type People = { unit?: string; people?: { name: string; you: boolean; n: number; credits: number }[] };

export function Usage({ admin, onOpenProject }: { admin: boolean; onOpenProject: (id: string) => void }) {
  const session = useSession();
  const inCredits = session.rates.unit === "cr" && Boolean(session.credits);
  const rate = creditRate(session.rates.creditUsd);
  const [now] = useState(() => Date.now());
  const months = monthChoices(now);
  const [month, setMonth] = useState(months[0].key);
  const ledger = useRead<unknown>(inCredits ? `/api/usage?rows=1&month=${month}&limit=1` : null);
  const boards = useRead<unknown>(inCredits && admin ? `/api/usage/boards?month=${month}` : null);
  const people = useRead<People>(inCredits ? `/api/usage/people?month=${month}` : null);
  const totals = monthTotalsOf(ledger.data);
  const perBoard = boardRows(boards.data);
  const rows = people.data?.people ?? [];
  const top = Math.max(1, ...rows.map((r) => r.credits), ...(perBoard ?? []).map((b) => b.credits));
  if (!inCredits) return <Sec><div className="v12-ws-empty" data-testid="v12-settings-usage-house">This workspace is billed in dollars at the engines’ cost: see Credits &amp; billing.</div></Sec>;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="v12-ws-seg" role="group" aria-label="Month">
          {months.map((m) => <button key={m.key} type="button" aria-pressed={m.key === month} onClick={() => setMonth(m.key)} data-testid={`v12-settings-month-${m.key === months[0].key ? "this" : "last"}`}>{m.label}</button>)}
        </div>
        <span className="v12-ws-meta" data-testid="v12-settings-usage-total">{totals ? monthLine(totals) : ledger.error ? "—" : "Reading…"}</span>
      </div>
      {admin ? (
        <Sec label="By board" testId="v12-settings-usage-boards">
          {boards.error ? <Problem text={boards.error} onRetry={() => void boards.read()} /> : perBoard === null ? <div className="v12-ws-empty">Reading…</div> : null}
          {perBoard?.map((b, i) => (
            <div key={`${b.id ?? b.name}:${i}`} className="v12-ws-bar" data-testid="v12-settings-usage-board">
              <span><span style={{ display: "block", fontWeight: 500 }}>{b.name}</span><span className="v12-ws-row-line">{takesWords(b.n)}</span></span>
              <span className="v12-ws-bar-track"><span className="v12-ws-bar-fill" style={{ width: `${Math.round((b.credits / top) * 100)}%` }} /></span>
              <span style={{ display: "inline-flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                <span className="v12-ws-mono" title={creditsUsd(b.credits, rate) ?? undefined}>{fmtCredits(b.credits)}</span>
                {b.id ? <button type="button" className="v12-ws-btn" onClick={() => onOpenProject(b.id!)}>Open</button> : null}
              </span>
            </div>
          ))}
          {perBoard && !perBoard.length ? <div className="v12-ws-empty">Nothing settled this month.</div> : null}
        </Sec>
      ) : null}
      <Sec label={admin ? "By person" : "You"} testId="v12-settings-usage-people">
        {people.error ? <Problem text={people.error} onRetry={() => void people.read()} /> : !people.data ? <div className="v12-ws-empty">Reading…</div> : null}
        {rows.map((r, i) => (
          <div key={`${r.name}:${i}`} className="v12-ws-bar" data-testid="v12-settings-usage-person">
            <span className="v12-ws-who"><span className="v12-ws-av" aria-hidden="true">{initialsOf(r.name)}</span>{r.name}{r.you && admin ? <span className="v12-ws-you">you</span> : null}</span>
            <span className="v12-ws-bar-track"><span className="v12-ws-bar-fill" style={{ width: `${Math.round((r.credits / top) * 100)}%` }} /></span>
            <span className="v12-ws-mono" style={{ textAlign: "right" }} title={creditsUsd(r.credits, rate) ?? undefined}>{fmtCredits(r.credits)}</span>
          </div>
        ))}
        {people.data && !rows.length ? <div className="v12-ws-empty">{admin ? "Nobody has spent credits this month." : "You haven’t spent credits this month."}</div> : null}
      </Sec>
    </>
  );
}
