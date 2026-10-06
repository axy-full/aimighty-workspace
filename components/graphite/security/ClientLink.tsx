"use client";
import { useCallback, useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { dateWords } from "@/lib/security/consent-words";
import "./security.css";

/*
 * "Copy client link" in Crew review (Gaps A): a link that opens this production's review set to a client who does
 * not sign in, where they can approve a take or ask for changes and comment, and nothing else (GET/POST/DELETE
 * /api/review-links; lib/security/review-link.ts).
 *
 * - The link's secret is shown once, when it is made: it is stored only as a hash, so a later Copy makes a new link.
 * - An owner or admin makes and withdraws links; everyone on the production sees what clients said.
 * - Withdrawing stops the link at once. Links expire on their own (30 days).
 * Nothing here spends.
 */
type Link = { id: string; live: boolean; createdAt: number; expiresAt: number; revokedAt: number | null };
type Said = { genId: string; shot: string | null; version: number; guest: string; verdict: "approved" | "changes" | null; text: string | null; at: number };
type Reply = { canManage: boolean; days: number; links: Link[]; said: Said[] };

export function ClientLink({ productionId, toast }: { productionId: string | null; toast: (text: string) => void }) {
  const scoped = useScopedFetch();
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!productionId) return;
    try {
      const response = await scoped(`/api/review-links?${new URLSearchParams({ projectId: productionId })}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) throw new Error(body?.error ?? "Client links could not be read.");
      setData(body as Reply); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Client links could not be read."); }
  }, [scoped, productionId]);
  useEffect(() => { const t = setTimeout(() => void read(), 0); return () => clearTimeout(t); }, [read]);

  const copy = async () => {
    if (!productionId || busy) return;
    setBusy("make");
    try {
      const response = await scoped("/api/review-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: productionId }) });
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.url !== "string") throw new Error(body?.error ?? "The link could not be made.");
      setFresh(body.url);
      try { await navigator.clipboard.writeText(body.url); toast("Client link copied · it opens this production’s review only"); }
      catch { toast("Link made. Select it and copy it."); }
      void read();
    } catch (e) { toast(e instanceof Error ? e.message : "The link could not be made."); }
    finally { setBusy(null); }
  };
  const withdraw = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const response = await scoped(`/api/review-links?${new URLSearchParams({ id })}`, { method: "DELETE" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "The link could not be withdrawn.");
      setFresh(null);
      toast("Client link withdrawn · it stops working now");
      void read();
    } catch (e) { toast(e instanceof Error ? e.message : "The link could not be withdrawn."); }
    finally { setBusy(null); }
  };

  const live = (data?.links ?? []).filter((l) => l.live);
  const until = live[0]?.expiresAt ?? (data ? Date.now() + data.days * 86_400_000 : null);
  return (
    <section className="gsec-link" aria-label="Client link" data-testid="client-link">
      <span className="gsec-eyebrow">Client link</span>
      {!productionId ? <span>Save the production first; a client link opens a saved production.</span>
        : error ? <span role="alert">{error} <button type="button" className="gsec-btn" onClick={() => void read()}>Try again</button></span>
        : !data ? <span>Reading…</span> : (
          <>
            {fresh ? <span className="gsec-link-url" data-testid="client-link-url">{fresh}</span> : null}
            <div className="gsec-tags">
              <span className="gsec-tag">Can approve</span><span className="gsec-tag">Can comment</span>
              <span className="gsec-tag" data-testid="client-link-expiry">No sign-in · expires {until ? dateWords(until) : "in 30 days"}</span>
            </div>
            <span data-testid="client-link-count">{live.length ? `${live.length} live ${live.length === 1 ? "link" : "links"} · this production’s review only` : "No live link. Copy one to share the review."}</span>
            {data.canManage ? live.map((l) => (
              <div key={l.id} className="gsec-link-row" data-testid="client-link-live">
                <span>Made {dateWords(l.createdAt)} · expires {dateWords(l.expiresAt)}</span>
                <button type="button" className="gsec-btn" disabled={busy != null} onClick={() => void withdraw(l.id)} data-testid="client-link-withdraw">{busy === l.id ? "Withdrawing…" : "Withdraw"}</button>
              </div>
            )) : null}
            <div className="gsec-link-row">
              {data.canManage ? null : <span>An owner or admin makes a client link.</span>}
              {/* Outlined: "Ask the crew" above is the panel's one filled button. */}
              <button type="button" className="gsec-btn" disabled={!data.canManage || busy != null} onClick={() => void copy()} data-testid="client-link-copy">
                {busy === "make" ? "Making the link…" : "Copy client link"}
              </button>
            </div>
            {data.said.length ? (
              <div data-testid="client-said-list">
                <span className="gsec-eyebrow">From the client</span>
                {data.said.slice(0, 8).map((s, i) => (
                  <div key={i} className="gsec-said" data-testid="client-said-row">
                    <span className="gsec-said-who">{s.guest} · {s.shot ?? "Take"} · v{s.version}{s.verdict ? ` · ${s.verdict === "approved" ? "approved" : "asked for changes"}` : ""}</span>
                    {s.text ? <span className="gsec-said-text">{s.text}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
    </section>
  );
}
