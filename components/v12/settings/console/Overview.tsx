"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { fmtCredits, useMoney } from "@/lib/price";
import { creditRate, creditsUsd } from "@/lib/shell/price-words";
import { LOW_CREDIT_PERCENT } from "@/lib/v12/lowCredit";
import { useLowCredit } from "@/lib/v12/useLowCredit";
import { seatsLine } from "@/lib/v12/settingsConsole";
import { whenWords } from "@/lib/v12/billing";
import { monthKey, monthTotalsOf, topUpLabel, topUpPack } from "@/components/graphite/settings/model";
import { useRead } from "@/components/graphite/settings/use-settings";
import { useGoSettings } from "@/components/graphite/settings/navigate";
import type { Topups } from "@/lib/shell/workspace-view";
import type { CreditLedgerRow } from "@/lib/usageLedgerTerms";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { Problem, Sec, initialsOf } from "./parts";
import type { TeamBody } from "./People";

/** Settings › Overview: credits left, spent this month, people, renders running; the Low-credit warning; recent activity. All from routes that already serve them. */
const KIND: Record<string, string> = { video: "Clip", image: "Still", audio: "Sound", text: "Writing", training: "Identity" };

export function Overview({ account, team }: { account: WorkspaceAccount | null; team: { data: TeamBody | null; error: string | null; read: () => Promise<void> } }) {
  const session = useSession();
  const money = useMoney();
  const go = useGoSettings();
  const inCredits = session.rates.unit === "cr" && Boolean(session.credits);
  const rate = creditRate(session.rates.creditUsd);
  const balance = account?.credits?.balance ?? session.credits?.balance ?? null;
  const rule = useLowCredit(balance);
  const [now] = useState(() => Date.now());
  const month = monthKey(now);
  const ledger = useRead<{ unit?: string; rows?: CreditLedgerRow[] }>(inCredits ? `/api/usage?rows=1&month=${month}&limit=6` : null);
  const usage = useRead<{ spentUsd?: number }>(!inCredits ? "/api/usage" : null);
  const limits = useRead<{ standing?: { running?: number } }>("/api/limits");
  const topups = useRead<Topups>(inCredits ? "/api/workspaces/topups" : null);
  const totals = monthTotalsOf(ledger.data);
  const pack = topups.data?.applies && topups.data.canRequest ? topUpPack(topups.data.packs) : null;
  const people = team.data ? team.data.users.filter((u) => !u.disabled).length : null;
  const running = limits.data?.standing?.running ?? null;
  const spent = inCredits ? (totals ? fmtCredits(totals.charged) : null) : (typeof usage.data?.spentUsd === "number" ? money.price(usage.data.spentUsd) : null);
  const tiles: { label: string; value: string; sub: string; warn?: boolean }[] = [
    inCredits
      ? { label: "Credits left", value: balance != null ? fmtCredits(balance) : "—", sub: rule.base ? `of ${fmtCredits(rule.base)} a month` : "", warn: rule.low }
      : { label: "Billing", value: "At cost", sub: "In dollars, at the engines’ cost" },
    { label: inCredits ? "Spent this month" : "Spent · all time", value: spent ?? (ledger.error || usage.error ? "—" : "…"), sub: inCredits && totals && balance != null && rule.base ? `${Math.round((totals.charged / rule.base) * 100)} % of the month’s credits` : "" },
    { label: "People", value: people != null ? String(people) : team.error ? "—" : "…", sub: team.data ? seatsLine(team.data.seats, people ?? 0) : "" },
    { label: "Renders running", value: running != null ? String(running) : "—", sub: running === 0 ? "Nothing running" : "" },
  ];
  const activity = (ledger.data?.rows ?? []).filter((r) => r.credits > 0 || r.state === "held").slice(0, 5);
  return (
    <>
      <Sec testId="v12-settings-tiles">
        <div className="v12-ws-tiles">
          {tiles.map((t) => (
            <div key={t.label} className="v12-ws-tile" data-testid="v12-settings-tile">
              <span className="v12-ws-tile-label">{t.label}</span>
              <span className="v12-ws-tile-value" style={t.warn ? { color: "var(--gx-waiting-text)" } : undefined} title={t.label === "Credits left" && balance != null ? creditsUsd(balance, rate) ?? undefined : undefined}>{t.value}</span>
              <span className="v12-ws-tile-sub">{t.sub}</span>
            </div>
          ))}
        </div>
        {team.error ? <Problem text={team.error} onRetry={() => void team.read()} /> : null}
      </Sec>
      {inCredits && rule.low && balance != null ? (
        <div className="v12-ws-low" data-testid="v12-settings-low">
          <span className="v12-ws-low-line"><span className="v12-ws-dot" aria-hidden="true" />Low-credit warning · {fmtCredits(balance)} left{rule.base ? ` of ${fmtCredits(rule.base)}` : ""}, under {LOW_CREDIT_PERCENT} %. Renders keep going until 0.</span>
          {pack ? <button type="button" className="v12-ws-btn v12-ws-btn-primary" onClick={() => go("credits", "packs")} data-testid="v12-settings-topup">{topUpLabel(pack)}</button> : null}
        </div>
      ) : null}
      <Sec label="Recent activity" testId="v12-settings-activity">
        {ledger.error ? <Problem text={ledger.error} onRetry={() => void ledger.read()} /> : null}
        {activity.map((r) => (
          <div key={r.id} className="v12-ws-act" data-testid="v12-settings-activity-row">
            <span className="v12-ws-quiet">{whenWords(r.at, now)}</span>
            <span className="v12-ws-who"><span className="v12-ws-av" aria-hidden="true">{initialsOf(r.who ?? "")}</span>{r.who ?? "Atomik"}</span>
            <span title={`${KIND[r.kind] ?? r.kind} · ${r.engine}`}>{KIND[r.kind] ?? r.kind} · {r.engine}</span>
            <span className="v12-ws-mono">{r.state === "held" ? "held " : "−"}{fmtCredits(r.credits)}</span>
          </div>
        ))}
        {ledger.data && !activity.length ? <div className="v12-ws-empty">Nothing yet this month.</div> : null}
      </Sec>
    </>
  );
}
