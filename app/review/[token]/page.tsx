"use client";

import "./review.css";
import { use, useCallback, useEffect, useState } from "react";
import { posterSrc } from "@/lib/format";
import { ClientReview, type ClientReviewData } from "@/components/graphite/security/ClientReview";

/**
 * A client review page (brief 2.6).
 *
 * A production's Approved takes, in shot order, under the studio's own
 * name and mark — no login, no app chrome, and nothing of the platform's
 * branding in front of someone else's client. A comment goes back to the
 * take's notes, where the team reads it beside their own.
 */
type Note = { text: string; author: string; guest: boolean; at: number };
type Take = { id: string; kind: "video" | "image" | "audio" | "model"; shot: string | null; title: string | null; version: number; prompt: string; approvedBy: string | null; media: string; notes: Note[] };
type Review = { workspace: { name: string; logo: string | null }; production: { name: string; description: string }; takes: Take[]; expiresAt: number };

export default function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Review | ClientReviewData | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  /* The name a client last used, read once when the page mounts. */
  const [name, setName] = useState(() => { try { return localStorage.getItem("aw_review_name") ?? ""; } catch { return ""; } });

  /* Read on mount, and again when a comment lands. */
  const [round, setRound] = useState(0);
  const load = useCallback(() => setRound((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    fetch(`/api/review/${token}`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!live) return;
        if (ok) setData(body as Review | ClientReviewData);
        else setGone((body as { error?: string }).error ?? "This review link is not available.");
      })
      .catch(() => { if (live) setGone("This review could not be opened."); });
    return () => { live = false; };
  }, [token, round]);

  if (gone) return <main className="rv"><p className="rv-gone">{gone}</p></main>;
  if (!data) return <main className="rv"><p className="rv-gone">Opening the review…</p></main>;
  /* A Crew review link opens the review set, where the client approves or asks for changes (Gaps A). */
  if ("kind" in data && data.kind === "review") return <ClientReview token={token} data={data} onChanged={load} />;
  const approved = data as Review;

  return (
    <main className="rv">
      <header className="rv-head">
        {approved.workspace.logo
          /* eslint-disable-next-line @next/next/no-img-element */
          ? <img src={approved.workspace.logo} alt={approved.workspace.name} className="rv-logo" />
          : <span className="rv-name">{approved.workspace.name}</span>}
        <div className="rv-title">
          <h1>{approved.production.name}</h1>
          <p>{approved.takes.length} approved take{approved.takes.length === 1 ? "" : "s"}{approved.production.description ? ` · ${approved.production.description}` : ""}</p>
        </div>
      </header>

      {approved.takes.length === 0 && <p className="rv-gone">Nothing has been approved yet.</p>}

      <ol className="rv-list">
        {approved.takes.map((t) => (
          <li key={t.id} className="rv-take">
            <div className={t.kind === "audio" || t.kind === "model" ? "rv-media is-flat" : "rv-media"}>
              {t.kind === "image"
                /* eslint-disable-next-line @next/next/no-img-element */
                ? <img src={t.media} alt={t.title ?? t.shot ?? "take"} />
                : t.kind === "audio"
                  ? <audio src={t.media} controls preload="metadata" aria-label={t.title ?? t.shot ?? "take"} />
                  : t.kind === "model"
                    ? <a className="rv-file" href={t.media} download>Download 3D model</a>
                    /* Same reason as the canvas rail: a paused <video> on a bare
                       url decodes no frame and shows black. This is the page a
                       client opens, so it is the last place that should. */
                    : <video src={posterSrc(t.media)} controls playsInline preload="metadata" />}
            </div>
            <div className="rv-body">
              <h2>{t.shot ? `${t.shot} · v${t.version}` : `v${t.version}`}{t.title ? ` — ${t.title}` : ""}</h2>
              <p className="rv-prompt">{t.prompt}</p>
              {t.notes.length > 0 && (
                <ul className="rv-notes">
                  {t.notes.map((n, i) => (
                    <li key={i}><span className={n.guest ? "rv-who is-guest" : "rv-who"}>{n.author}</span>{n.text}</li>
                  ))}
                </ul>
              )}
              <Comment token={token} take={t} name={name} setName={setName} onSent={load} />
            </div>
          </li>
        ))}
      </ol>

      <footer className="rv-foot">
        <span>{approved.workspace.name}</span>
        <span>This link expires on {new Date(approved.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.</span>
      </footer>
    </main>
  );
}

function Comment({ token, take, name, setName, onSent }: { token: string; take: Take; name: string; setName: (s: string) => void; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function send() {
    if (!text.trim()) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/review/${token}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genId: take.id, text, name }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent.");
      try { localStorage.setItem("aw_review_name", name); } catch { /* fine */ }
      setText(""); onSent();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="rv-say">
      <input className="rv-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
      <textarea className="rv-in rv-text" value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="A note on this take…" aria-label={`A note on ${take.shot ?? "this take"}`} />
      <button type="button" className="rv-send" onClick={send} disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      {err && <span className="rv-err">{err}</span>}
    </div>
  );
}
