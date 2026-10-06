"use client";
import { useEffect, useMemo, useState } from "react";
import { posterSrc } from "@/lib/format";
import { dateWords } from "@/lib/security/consent-words";
import "./security.css";

/*
 * The client's view from a Crew review link (Gaps A, "?view=board&gap=client" and phone "screen=client"): the
 * production's review set, a player, the comments, and Approve or Request changes, with no sign-in. Under the
 * studio's own name (the existing review page's rule: nothing of the platform's branding in front of its client).
 *
 * The page reads only what its link returns (GET /api/review/<token>), and writes only a decision or a comment on a
 * take in that set (POST …/verdict, …/notes). Nothing here costs anything.
 */
export type ClientNote = { text: string; author: string; guest: boolean; at: number };
export type ClientTake = {
  id: string; kind: string; shot: string | null; title: string | null; version: number; state: "approved" | "review";
  verdict: { verdict: "approved" | "changes"; guest: string; at: number } | null; media: string; notes: ClientNote[];
};
export type ClientReviewData = { kind: "review"; workspace: { name: string; logo: string | null }; production: { name: string }; takes: ClientTake[]; expiresAt: number };

const takeName = (t: Pick<ClientTake, "shot" | "title" | "version">) => `${t.shot ?? t.title ?? "Take"} · v${t.version}`;
const stateWords = (t: ClientTake) =>
  t.verdict ? (t.verdict.verdict === "approved" ? `You approved this · ${dateWords(t.verdict.at)}` : `You asked for changes · ${dateWords(t.verdict.at)}`)
    : t.state === "approved" ? "Approved" : "Needs your review";

function Media({ take, thumb }: { take: ClientTake; thumb?: boolean }) {
  const label = takeName(take);
  if (take.kind === "image") {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={take.media} alt={thumb ? "" : label} />;
  }
  if (take.kind === "audio") return thumb ? <span className="gcl-thumb-word">Sound</span> : <audio src={take.media} controls preload="metadata" aria-label={label} />;
  if (take.kind === "model") return thumb ? <span className="gcl-thumb-word">3D</span> : <a className="gsec-btn" href={take.media} download>Download 3D model</a>;
  return thumb
    ? <video src={posterSrc(take.media)} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
    : <video key={take.id} src={posterSrc(take.media)} controls playsInline preload="metadata" aria-label={label} />;
}

export function ClientReview({ token, data, onChanged }: { token: string; data: ClientReviewData; onChanged: () => void }) {
  const first = useMemo(() => data.takes.find((t) => t.state === "review" && !t.verdict) ?? data.takes[0] ?? null, [data.takes]);
  const [pick, setPick] = useState<string | null>(first?.id ?? null);
  const take = data.takes.find((t) => t.id === pick) ?? first;
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { try { setName(localStorage.getItem("aw_review_name") ?? ""); } catch { /* storage off */ } }, []);

  /* The comment travels with the decision, as the design draws it: one press, one record. */
  const send = async (what: "approved" | "changes") => {
    if (!take || busy) return;
    setBusy(what); setSaid(null);
    try {
      const response = await fetch(`/api/review/${token}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genId: take.id, verdict: what, text, name }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "That didn’t go through. Try again.");
      try { if (name.trim()) localStorage.setItem("aw_review_name", name.trim()); } catch { /* storage off */ }
      setText("");
      setSaid({ ok: true, text: what === "approved" ? `${takeName(take)} approved · the production is told` : "Changes requested · the production is told" });
      onChanged();
    } catch (error) {
      setSaid({ ok: false, text: error instanceof Error ? error.message : "That didn’t go through. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="gcl" data-testid="client-review">
      <header className="gcl-head">
        <span className="gcl-brand">
          {data.workspace.logo
            /* eslint-disable-next-line @next/next/no-img-element */
            ? <img src={data.workspace.logo} alt={data.workspace.name} className="gcl-logo" />
            : <strong>{data.workspace.name}</strong>}
          <span className="gcl-prod" data-testid="client-production">{data.production.name} · review</span>
        </span>
        <span className="gcl-tag">No sign-in needed</span>
      </header>
      {!take ? <p className="gcl-empty" data-testid="client-empty">Nothing is waiting for your review yet.</p> : (
        <div className="gcl-body">
          <nav className="gcl-takes" aria-label="Takes">
            <span className="gsec-eyebrow">Takes</span>
            {data.takes.map((t) => (
              <button key={t.id} type="button" className="gcl-take" aria-current={t.id === take.id ? "true" : undefined} onClick={() => { setPick(t.id); setSaid(null); }} data-testid="client-take">
                <span className="gcl-thumb"><Media take={t} thumb /></span>
                <span className="gcl-take-words"><span>{takeName(t)}</span><span className="gcl-state" data-state={t.verdict?.verdict ?? t.state}>{stateWords(t)}</span></span>
              </button>
            ))}
          </nav>
          <section className="gcl-stage" aria-label={takeName(take)}>
            <div className="gcl-player"><Media take={take} /></div>
            <div className="gcl-meta"><strong data-testid="client-take-name">{takeName(take)}</strong>{take.title && take.shot ? <span>{take.title}</span> : null}</div>
          </section>
          <section className="gcl-side" aria-label="Comments">
            <span className="gsec-eyebrow">Comments</span>
            {take.notes.length ? take.notes.map((n, i) => (
              <div key={i} className="gsec-said"><span className="gsec-said-who">{n.author}</span><span className="gsec-said-text">{n.text}</span></div>
            )) : <span className="gsec-sub">No comments on this take yet.</span>}
            <label className="gsec-field"><span className="gsec-eyebrow">Your name</span>
              <input className="gsec-input gcl-in" value={name} maxLength={60} placeholder="So the production knows who said it" autoComplete="name" onChange={(e) => setName(e.target.value)} data-testid="client-name" />
            </label>
            <textarea className="gsec-input gcl-in gcl-text" value={text} maxLength={2000} rows={3} placeholder="A comment on this take" aria-label="A comment on this take" onChange={(e) => setText(e.target.value)} data-testid="client-comment" />
            <div className="gcl-acts">
              <button type="button" className="gsec-btn" disabled={busy != null} onClick={() => void send("changes")} data-testid="client-changes">{busy === "changes" ? "Sending…" : "Request changes"}</button>
              <button type="button" className="gsec-btn gsec-primary" disabled={busy != null} onClick={() => void send("approved")} data-testid="client-approve">{busy === "approved" ? "Sending…" : `Approve ${take.shot ?? "this take"}`}</button>
            </div>
            {said ? <p className={said.ok ? "gsec-sub" : "gsec-problem"} role="status" data-testid="client-said">{said.text}</p> : null}
            <span className="gsec-sub" data-testid="client-expiry">Shared by the production · expires {dateWords(data.expiresAt)}</span>
          </section>
        </div>
      )}
    </main>
  );
}
