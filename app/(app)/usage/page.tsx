"use client";

import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import { usePhone } from "@/lib/usePhone";
import { useMoney } from "@/lib/price";
import { Mono, PinnedBar, PinnedPrimary } from "@/components/ui";
import Link from "next/link";
import { useSignInHref } from "@/lib/session";
import { PageLoader } from "@/components/atomik/Loader";
import { burnLabel, headlineLine, type Block, type ShotUsage } from "@/lib/usageView";
import LegacyUsage from "@/components/usage/LegacyUsage";

/**
 * Usage (docs/particl-sow-v2.md §7.12; design/particl-sow board 12f):
 * where the credits went. Opened from the account menu, nowhere else. The
 * first thing it says is which shot is costing the most; then by
 * production, by person, by engine; then whether each project ends under
 * its cap. One button: the statement.
 *
 * The board, value for value: the body `26px 40px 40px` at a 1280 max,
 * cards 16 apart. The headline row — the month at 600 26/-0.02em over
 * `832 cr spent · 1,240 left · about 20 days at this pace` at 400 15
 * muted — with the one filled primary (40px, radius 10, `Download the
 * statement` + `CSV` in the cost slot; a member sees it outlined with the
 * reason). Card 1 (`--card`, .08, radius 12, `20px`): `The shots taking
 * the most takes` at 600 18, rows `200px | 1fr | 150px | 120px` 46 tall on
 * a .07 rule — `SH06 · Saltwater`, the takes as 28×14 blocks (approved in
 * accent, picked in ink, draft at .35, sent back at .12), `5 takes · 2
 * sent back`, the state word, the credits. Three cards across (`By
 * production · By person · By engine`, rows `120px | 1fr | 60px`, a 14px
 * bar on a .06 track, Planning at .4). Then `Will each project finish
 * under its cap?` — a two-layer bar (projected at .2 under spent in ink)
 * and `ends 28 cr under` / `ends 6 cr over its cap` in ink.
 *
 * Below 768 (the mobile README's chrome; M10 is the precedent for an
 * account-menu route): `‹ Back · Usage` in the header, one column at 16px,
 * the headline stacked, blocks 22×12, the bar rows as name and value over
 * the bar, and the one primary pinned above the dock — outlined while the
 * Atomik sheet is open. Every credit here is the platform ledger's, the
 * same source as the balance and the statement. A dollar workspace (the
 * studio's own, no credits) keeps its vendor ledgers.
 */
type Row = { name: string; credits: number; planning?: boolean };
type Burn = { projectId: string; name: string; production: string | null; spent: number; cap: number | null; projected: number | null; known: boolean; over: boolean };
type UsageData = {
  cycle: { key: string; from: number; to: number };
  spentThisCycle: number; balance: number | null; runwayDays: number | null;
  mostTakes: ShotUsage[]; byProduction: Row[]; byPerson: Row[]; byEngine: Row[]; burn: Burn[];
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BLOCK: Record<Block, string> = { a: "bg-accent", p: "bg-ink", d: "bg-[rgba(245,246,248,.35)]", x: "bg-[rgba(245,246,248,.12)]", r: "bg-[rgba(245,246,248,.2)]", f: "bg-[rgba(245,246,248,.12)]" };
const BLOCK_WORD: Record<Block, string> = { a: "approved", p: "picked", d: "draft", x: "sent back", r: "rendering", f: "failed" };

export default function UsagePage() {
  const { signedIn, role } = useSession();
  const signIn = useSignInHref();
  const money = useMoney();
  const phone = usePhone();
  const rail = useAtomikRail();
  usePageTitle("Usage");
  const { data, error, refresh } = useApi<UsageData>(signedIn && money.inCredits ? "/api/usage" : null, 30_000);

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body"><Link href={signIn} className="text-ink underline decoration-[rgba(245,246,248,.3)] underline-offset-[3px]">Sign in</Link> to see where the credits went.</div>;
  if (!money.inCredits) return <LegacyUsage />;
  if (!data) return error
    ? <div className="flex items-center gap-[12px] p-[24px] text-[13px] text-ink-body">Usage did not load. <button type="button" onClick={refresh} className="tap44 rounded-pill border border-border-mid px-[11px] py-[8px] text-[12.5px] font-medium leading-none text-ink">Try again</button></div>
    : <PageLoader what="Reading · Usage" />;

  const cr = (n: number) => `${Math.round(n).toLocaleString()} cr`;
  const num = (n: number) => Math.round(n).toLocaleString();
  const month = MONTHS[new Date(data.cycle.from).getUTCMonth()] ?? data.cycle.key;
  const line = headlineLine(data.spentThisCycle, data.balance, data.runwayDays, cr);
  const admin = role === "owner" || role === "admin";   // the server folds owner into admin; the session does not
  const download = () => { if (admin) window.open(`/api/statements?month=${encodeURIComponent(data.cycle.key)}&format=csv`, "_blank", "noopener"); };   // a download, not a page
  const blocks = (s: ShotUsage) => (
    <span className="flex flex-wrap items-center gap-[4px]">
      {s.blocks.map((b, i) => <span key={i} title={`v${s.versions[i] ?? i + 1} · ${BLOCK_WORD[b]}`} className={`block rounded-[3px] ${phone ? "h-[12px] w-[22px]" : "h-[14px] w-[28px]"} ${BLOCK[b]}`} />)}
      <span className={`ml-[6px] ${phone ? "text-[12px]" : "text-[13px]"} leading-none text-ink-muted`}>{s.takes} {s.takes === 1 ? "take" : "takes"}{s.sentBack ? ` · ${s.sentBack} sent back` : ""}</span>
    </span>
  );
  const bar = (v: number, max: number, planning = false) => (
    <span className="block h-[14px] w-full overflow-hidden rounded-[3px] bg-[rgba(245,246,248,.06)]" aria-hidden="true">
      <span className={`block h-full rounded-[3px] ${planning ? "bg-[rgba(245,246,248,.4)]" : "bg-ink"}`} style={{ width: `${max > 0 ? Math.min(100, (v / max) * 100) : 0}%` }} />
    </span>
  );
  const barCard = (title: string, rows: Row[], empty: string) => {
    const max = Math.max(0, ...rows.map((r) => r.credits));
    return (
      <section aria-label={title} className="flex flex-col gap-[12px] rounded-card border border-border bg-card p-[20px] max-md:p-[16px]">
        <h2 className="text-[16px] font-semibold leading-none text-ink">{title}</h2>
        {rows.length ? rows.map((r) => (
          phone
            ? <span key={r.name} className="flex flex-col gap-[6px]"><span className="flex items-baseline justify-between gap-[10px] text-[14px] leading-none"><span className="min-w-0 truncate text-ink-body">{r.name}</span><span className="font-medium text-ink">{num(r.credits)}</span></span>{bar(r.credits, max, r.planning)}</span>
            : <span key={r.name} className="grid grid-cols-[120px_minmax(0,1fr)_60px] items-center gap-[10px] text-[14px] leading-none"><span className="min-w-0 truncate text-ink-body">{r.name}</span>{bar(r.credits, max, r.planning)}<span className="text-right font-medium text-ink">{num(r.credits)}</span></span>
        )) : <span className="text-[13px] leading-[1.5] text-ink-body">{empty}</span>}
      </section>
    );
  };
  const shots = (
    <section aria-label="The shots taking the most takes" className="flex flex-col rounded-card border border-border bg-card p-[20px] max-md:p-[16px]">
      <h2 className="pb-[10px] text-[18px] font-semibold leading-none text-ink">The shots taking the most takes</h2>
      {data.mostTakes.length ? data.mostTakes.map((s) => (
        phone
          ? <span key={s.shotId} className="flex flex-col gap-[8px] border-t border-[rgba(245,246,248,.07)] py-[12px]">
              <span className="flex items-baseline justify-between gap-[8px]"><span className="min-w-0 truncate text-[15px] font-medium leading-none text-ink">{s.code}<span className="font-normal text-ink-muted"> · {s.project}</span></span><span className="text-[15px] font-medium leading-none text-ink">{cr(s.credits)}</span></span>
              <span className="flex items-center justify-between gap-[8px]">{blocks(s)}<span className={`text-[13px] font-medium leading-none ${s.state === "Approved" ? "text-accent" : s.state === "Picked" ? "text-ink" : "text-ink-body"}`}>{s.state}</span></span>
            </span>
          : <span key={s.shotId} className="grid min-h-[46px] grid-cols-[200px_minmax(0,1fr)_150px_120px] items-center gap-[16px] border-t border-[rgba(245,246,248,.07)] py-[8px]" data-shot-row="">
              <span className="min-w-0 truncate text-[15px] font-medium leading-none text-ink">{s.code}<span className="font-normal text-ink-muted"> · {s.project}</span></span>
              {blocks(s)}
              <span className={`text-[13px] font-medium leading-none ${s.state === "Approved" ? "text-accent" : s.state === "Picked" ? "text-ink" : "text-ink-body"}`}>{s.state}</span>
              <span className="text-right text-[15px] font-medium leading-none text-ink">{cr(s.credits)}</span>
            </span>
      )) : <span className="border-t border-[rgba(245,246,248,.07)] pt-[12px] text-[13px] leading-[1.5] text-ink-body">No takes on a shot yet this month.</span>}
    </section>
  );
  const burn = (
    <section aria-label="Will each project finish under its cap?" className="flex flex-col gap-[12px] rounded-card border border-border bg-card p-[20px] max-md:p-[16px]">
      <span className="flex flex-col gap-[6px]">
        <h2 className="text-[16px] font-semibold leading-none text-ink">Will each project finish under its cap?</h2>
        <span className="text-[13px] leading-[1.4] text-ink-muted">bright is spent · dim is where it will end at this rate</span>
      </span>
      {data.burn.length ? data.burn.map((b) => {
        const label = burnLabel(b, cr);
        const cap = b.cap ?? 0;
        const track = (
          <span className="relative block h-[14px] w-full overflow-hidden rounded-[3px] bg-[rgba(245,246,248,.06)]" aria-hidden="true">
            {b.projected != null && <span className="absolute inset-y-0 left-0 rounded-[3px] bg-[rgba(245,246,248,.2)]" style={{ width: `${cap > 0 ? Math.min(100, (b.projected / cap) * 100) : 0}%` }} />}
            <span className="absolute inset-y-0 left-0 rounded-[3px] bg-ink" style={{ width: `${cap > 0 ? Math.min(100, (b.spent / cap) * 100) : 0}%` }} />
          </span>
        );
        const name = <span className="min-w-0 truncate text-[14px] leading-none text-ink-body">{b.name}{b.production && b.production !== b.name ? <span className="text-ink-muted"> · {b.production}</span> : null}</span>;
        const word = <span className={`text-[14px] font-medium leading-none ${label.over ? "text-ink" : "text-ink-muted"}`}>{label.text}</span>;
        return phone
          ? <span key={b.projectId} className="flex flex-col gap-[6px]"><span className="flex items-baseline justify-between gap-[10px]">{name}<Mono cost>{num(b.spent)} of {num(cap)}</Mono></span>{track}{word}</span>
          : <span key={b.projectId} className="grid grid-cols-[200px_minmax(0,1fr)_220px] items-center gap-[16px]" data-burn-row="">{name}{track}<span className="text-right">{word}</span></span>;
      }) : <span className="text-[13px] leading-[1.5] text-ink-body">No project has a cap yet. Set one on a project and the projection appears here.</span>}
    </section>
  );
  const primaryDesktop = admin
    ? <button type="button" onClick={download} className={`flex h-[40px] flex-none items-center gap-[10px] rounded-[10px] px-[16px] text-[13.5px] font-semibold leading-none ${rail.open ? "border border-[rgba(245,246,248,.2)] bg-transparent text-ink-body" : "bg-ink text-ground"}`}>Download the statement<span className={`ui-mono ui-mono-cost ${rail.open ? "text-ink-muted" : "text-on-primary-cost"}`}>CSV</span></button>
    : <span className="flex flex-col items-end gap-[6px]"><button type="button" disabled className="flex h-[40px] flex-none items-center gap-[10px] rounded-[10px] border border-[rgba(245,246,248,.2)] px-[16px] text-[13.5px] font-semibold leading-none text-ink-body">Download the statement<span className="ui-mono ui-mono-cost text-ink-muted">CSV</span></button><Mono>Admins download statements</Mono></span>;

  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[16px] pb-[10px] pt-[16px]" data-phone-body="">
          <span className="flex flex-col gap-[6px]">
            <h1 className="text-[24px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">{month}</h1>
            <span className="text-[14px] leading-[1.4] text-ink-muted" data-usage-line="">{line}</span>
          </span>
          {shots}
          {barCard("By production", data.byProduction, "Nothing billed to a production this month.")}
          {barCard("By person", data.byPerson, "Nobody has spent a credit this month.")}
          {barCard("By engine", data.byEngine, "No engine has run this month.")}
          {burn}
        </div>
        <PinnedBar className="flex-col gap-[6px]">
          {!admin && <Mono className="px-[2px]">Admins download statements</Mono>}
          <PinnedPrimary cost="CSV" outlined={rail.open || !admin} disabled={!admin} onClick={download}>Download the statement</PinnedPrimary>
        </PinnedBar>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-ground text-ink">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-[16px] px-[40px] pb-[40px] pt-[26px] max-lg:px-[24px]">
        <div className="flex items-start justify-between gap-[16px]">
          <span className="flex min-w-0 flex-col gap-[8px]">
            <h1 className="text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">{month}</h1>
            <span className="text-[15px] leading-none text-ink-muted" data-usage-line="">{line}</span>
          </span>
          {primaryDesktop}
        </div>
        {shots}
        <div className="grid grid-cols-3 gap-[14px] max-lg:grid-cols-1">
          {barCard("By production", data.byProduction, "Nothing billed to a production this month.")}
          {barCard("By person", data.byPerson, "Nobody has spent a credit this month.")}
          {barCard("By engine", data.byEngine, "No engine has run this month.")}
        </div>
        {burn}
      </div>
    </div>
  );
}
