"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import {
  CONNECTED_LABEL, LEDGER_LABEL, fmtConnectedCredits, fmtLedgerCredits, ledgerAmount, monthLabel,
  type ConnectedLedgerPage, type LedgerPage,
} from "@/lib/usageLedgerTerms";

/**
 * Usage › the ledger, one job per row, under the bars (idea 25). It reads
 * GET /api/usage?rows=1 a page at a time, in the one unit the route says
 * this workspace pays in, and the viewer's own connected-account jobs
 * (?rows=connected) apart from it in that provider's credits. The month
 * filter and the CSV ask the same route, so the file follows the same
 * scope and unit as the rows on screen.
 */
const at = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const READ_FAILED = "The ledger could not be read.";

type Pageish = { months?: string[]; rows: unknown[]; next: string | null };
type List<P extends Pageish> = { first: P | null; rows: P["rows"]; next: string | null; months: string[]; error: string | null; loading: boolean; more: boolean; failed: string | null };

const url = (source: "1" | "connected", month: string | null, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ rows: source, ...(month ? { month } : {}), ...extra });
  return `/api/usage?${q}`;
};

/** One list: the first page for the month, then each next page on request. An answer for a month no longer shown is dropped. */
function useLedgerList<P extends Pageish>(source: "1" | "connected", month: string | null) {
  const scoped = useScopedFetch();
  const [list, setList] = useState<List<P>>({ first: null, rows: [], next: null, months: [], error: null, loading: true, more: false, failed: null });
  const epoch = useRef(0);
  const read = useCallback(async (cursor: string | null) => {
    const mine = cursor ? epoch.current : ++epoch.current;
    setList((l) => (cursor ? { ...l, more: true, error: null } : { ...l, first: null, rows: [], next: null, error: null, loading: true, more: false }));
    try {
      const response = await scoped(url(source, month, cursor ? { cursor } : {}), { cache: "no-store" });
      const json = (await response.json().catch(() => null)) as (P & { error?: string }) | null;
      if (!response.ok || !json || !Array.isArray(json.rows)) throw new Error(json?.error ?? READ_FAILED);
      if (mine !== epoch.current) return;
      setList((l) => ({
        first: cursor ? l.first : json, rows: cursor ? [...l.rows, ...json.rows] : json.rows, next: json.next ?? null,
        months: Array.isArray(json.months) ? json.months : l.months, error: null, loading: false, more: false, failed: null,
      }));
    } catch (caught) {
      if (mine !== epoch.current) return;
      setList((l) => ({ ...l, error: caught instanceof Error ? caught.message : READ_FAILED, loading: false, more: false, failed: cursor }));
    }
  }, [scoped, source, month]);
  useEffect(() => { const t = setTimeout(() => void read(null), 0); return () => clearTimeout(t); }, [read]);
  return { ...list, showMore: () => void read(list.next), retry: () => void read(list.failed) };
}

/**
 * One take's row of the ledger, for the Inspector's "Settled" fact: what the
 * ledger holds for it, read again whenever the take's status moves. Null
 * when there is nothing to read (an upload, or a take the connected account
 * made, which is priced in that provider's credits).
 */
export function useLedgerEntry(id: string | null, status?: string) {
  const scoped = useScopedFetch();
  const [entry, setEntry] = useState<{ id: string; status?: string; page: LedgerPage | null; failed: boolean } | null>(null);
  const read = useCallback(async () => {
    if (!id) return;
    setEntry({ id, status, page: null, failed: false });
    const mine = (e: typeof entry) => e?.id === id && e.status === status;
    try {
      const response = await scoped(url("1", null, { id }), { cache: "no-store" });
      const json = (await response.json().catch(() => null)) as LedgerPage | null;
      if (!response.ok || !json || !Array.isArray(json.rows)) throw new Error(READ_FAILED);
      setEntry((e) => (mine(e) ? { id, status, page: json, failed: false } : e));
    } catch { setEntry((e) => (mine(e) ? { id, status, page: null, failed: true } : e)); }
  }, [id, status, scoped]);
  useEffect(() => { const t = setTimeout(() => void read(), 0); return () => clearTimeout(t); }, [read]);
  const current = entry && entry.id === id && entry.status === status ? entry : null;
  return { page: current?.page ?? null, failed: current?.failed ?? false, retry: () => void read() };
}

/** The CSV, fetched under this page's scope so it can only be this workspace's, then handed to the browser as a file. */
function useExport(source: "1" | "connected", month: string | null) {
  const scoped = useScopedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const response = await scoped(url(source, month, { format: "csv" }), { cache: "no-store" });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "The file could not be made.");
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "usage.csv";
      const href = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The file could not be made."); }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}

/** The filter's totals in one line: charged, held while running, not billed — in the page's own unit. */
function summary(page: LedgerPage | null, month: string | null): string | null {
  if (!page?.totals) return null;
  const scope = month ? monthLabel(month) : "All months";
  const notBilled = (n: number) => (n > 0 ? `${n.toLocaleString("en-US")} not billed` : null);
  if (page.unit === "credits") {
    const t = page.totals!;
    return [scope, `${fmtLedgerCredits(t.charged)} charged`, t.held > 0 ? `${fmtLedgerCredits(t.held)} held while running` : null, notBilled(t.notBilled)].filter(Boolean).join(" · ");
  }
  const t = page.totals!;
  return [scope, `$${t.charged.toFixed(2)} charged`, notBilled(t.notBilled)].filter(Boolean).join(" · ");
}

export function UsageLedger() {
  const [month, setMonth] = useState<string | null>(null);
  const jobs = useLedgerList<LedgerPage>("1", month);
  const connected = useLedgerList<ConnectedLedgerPage>("connected", month);
  const exportJobs = useExport("1", month);
  const exportConnected = useExport("connected", month);
  const months = [...new Set([...jobs.months, ...connected.months])].sort().reverse();
  const scopeName = month ? monthLabel(month) : null;
  const line = summary(jobs.first, month);
  const connectedTotals = connected.first?.totals;
  return (
    <section className="wsx-ledger" aria-labelledby="ws-ledger-title" data-testid="ws-ledger">
      <div className="wsx-ledger-head">
        <h2 className="wsx-ledger-title" id="ws-ledger-title">Ledger</h2>
        <div className="wsx-actions">
          <select className="cw-select wsx-ledger-month" aria-label="Month" value={month ?? ""} onChange={(e) => setMonth(e.target.value || null)} data-testid="ws-ledger-month">
            <option value="">All months</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="button" className="gx-hbtn" disabled={exportJobs.busy || !jobs.rows.length} onClick={() => void exportJobs.run()} data-testid="ws-ledger-export">
            {exportJobs.busy ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>
      {line ? <p className="wsx-ledger-line" data-testid="ws-ledger-summary">{line}</p> : null}
      {exportJobs.error ? <p className="gx-gen-error" role="alert">{exportJobs.error}</p> : null}
      {jobs.rows.length ? (
        <ul className="wsx-ledger-rows" aria-label="Jobs">
          {jobs.rows.map((r) => (
            <li className="wsx-ledger-row" key={r.id} data-state={r.state} data-testid="ws-ledger-row">
              <span className="wsx-ledger-what">{r.engine}</span>
              <span className="wsx-ledger-meta"><span className="wsx-ledger-when">{at(r.at)}</span>{r.who ? <span className="wsx-ledger-who">{r.who}</span> : null}</span>
              <span className="wsx-ledger-state" data-state={r.state}>{LEDGER_LABEL[r.state]}</span>
              <span className="wsx-ledger-amt">{ledgerAmount(r)}</span>
              {r.why ? <span className="wsx-ledger-why" data-testid="ws-ledger-why">{[r.why, "provider" in r ? r.provider : null].filter(Boolean).join(" · ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : jobs.first && !jobs.loading ? (
        <p className="wsx-ledger-line" data-testid="ws-ledger-empty">{scopeName ? `No jobs in ${scopeName}.` : "No jobs yet."}</p>
      ) : null}
      {jobs.loading ? <p className="wsx-ledger-line" role="status">Reading the ledger…</p> : null}
      {jobs.error ? (
        <div className="wsx-actions" role="alert" data-testid="ws-ledger-error">
          <span className="gx-gen-error">{jobs.error}</span>
          <button type="button" className="gx-hbtn" onClick={jobs.retry}>Try again</button>
        </div>
      ) : null}
      {jobs.next && !jobs.error ? (
        <button type="button" className="gx-hbtn wsx-ledger-more" disabled={jobs.more} onClick={jobs.showMore} data-testid="ws-ledger-more">{jobs.more ? "Reading…" : "Show more"}</button>
      ) : null}
      {connected.rows.length || connected.error ? (
        <div className="wsx-ledger-connected" data-testid="ws-ledger-connected">
          <div className="wsx-ledger-head">
            <h3 className="wsx-ledger-title">Your connected account</h3>
            {connected.rows.length ? (
              <button type="button" className="gx-hbtn" disabled={exportConnected.busy} onClick={() => void exportConnected.run()} data-testid="ws-ledger-connected-export">
                {exportConnected.busy ? "Exporting…" : "Export CSV"}
              </button>
            ) : null}
          </div>
          <p className="wsx-ledger-line">
            {connectedTotals ? `${connectedTotals.jobs.toLocaleString("en-US")} ${connectedTotals.jobs === 1 ? "job" : "jobs"} · ${fmtConnectedCredits(connectedTotals.quoted)} quoted` : "Quoted"} in the account&rsquo;s own credits
          </p>
          {exportConnected.error ? <p className="gx-gen-error" role="alert">{exportConnected.error}</p> : null}
          {connected.rows.length ? (
            <ul className="wsx-ledger-rows wsx-ledger-rows--connected" aria-label="Connected-account jobs">
              {connected.rows.map((r) => (
                <li className="wsx-ledger-row" key={r.id} data-state={r.state} data-testid="ws-ledger-connected-row">
                  <span className="wsx-ledger-what">{r.project ? `${r.workflow} · ${r.project}` : r.workflow}</span>
                  <span className="wsx-ledger-meta"><span className="wsx-ledger-when">{at(r.at)}</span></span>
                  <span className="wsx-ledger-state" data-state={r.state}>{CONNECTED_LABEL[r.state]}</span>
                  <span className="wsx-ledger-amt">{fmtConnectedCredits(r.quotedCredits)}</span>
                  {r.why ? <span className="wsx-ledger-why" data-testid="ws-ledger-why">{[r.why, r.provider].filter(Boolean).join(" · ")}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {connected.error ? (
            <div className="wsx-actions" role="alert">
              <span className="gx-gen-error">{connected.error}</span>
              <button type="button" className="gx-hbtn" onClick={connected.retry}>Try again</button>
            </div>
          ) : null}
          {connected.next && !connected.error ? (
            <button type="button" className="gx-hbtn wsx-ledger-more" disabled={connected.more} onClick={connected.showMore} data-testid="ws-ledger-connected-more">{connected.more ? "Reading…" : "Show more"}</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
