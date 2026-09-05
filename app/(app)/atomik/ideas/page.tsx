"use client";

/**
 * Atomik · Ideas — from the pipeline handoff.
 *
 * A logline, a tone, a few references. Pin the ones worth a brief. When
 * one becomes a production it keeps its card, and the card keeps pointing
 * at it: the state is read off what happened — a card with a production
 * that has shots is IN PRODUCTION whatever anyone set.
 */
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { uploadFile } from "@/lib/uploadClient";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { Empty, Waiting } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";
import type { Idea, IdeaState } from "@/lib/atomikDocs";

type Row = Idea & { projectName: string | null; shots: number; byName: string | null; parkedByName: string | null };
type Filter = "all" | "pinned" | "production" | "parked";

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const initials = (name: string | null) => (name ?? "—").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
/** The card's state is what happened to it, not only what was set. */
const shownState = (i: Row): IdeaState => (i.projectId && i.shots > 0 ? "production" : i.state === "production" ? "pinned" : i.state);

export default function IdeasPage() {
  usePageTitle("Atomik · Ideas");
  const router = useRouter();
  const { signedIn } = useSession();
  const { setSelection, refreshProjects } = useProject();
  const { data, refresh } = useApi<{ ideas: Row[] }>(signedIn ? "/api/atomik/ideas" : null, 15_000);
  const [filter, setFilter] = useState<Filter>("all");
  const [composing, setComposing] = useState(false);
  const ideas = data?.ideas ?? [];
  const shown = ideas.filter((i) => filter === "all" || shownState(i) === filter);
  const counts = { all: ideas.length, pinned: 0, production: 0, parked: 0 };
  for (const i of ideas) { const s = shownState(i); if (s !== "open") counts[s]++; }

  async function patch(i: Row, body: Record<string, unknown>) {
    const res = await fetch(`/api/atomik/ideas/${i.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { await appAlert("Not saved", `The server answered ${res.status}.`); return; }
    refresh();
  }
  async function remove(i: Row) {
    if (!(await appConfirm(`Delete idea #${String(i.num).padStart(2, "0")}?`, "Its production, if it has one, stays.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/atomik/ideas/${i.id}`, { method: "DELETE" });
    refresh();
  }
  /* Writing the treatment is what makes a production: the idea gets a
     project, the project gets a treatment seeded from the logline. */
  async function produce(i: Row) {
    const suggested = i.logline.split(/[.!?]/)[0]?.trim().slice(0, 40) ?? "";
    const name = await appPrompt("Name the production", suggested, "Northline");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id) { await appAlert("Couldn't create the production", json.error); return; }
    await fetch(`/api/atomik/ideas/${i.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: json.id, state: "pinned" }) });
    await fetch("/api/atomik/treatment", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: json.id, ideaId: i.id, title: name.trim(), logline: i.logline, setup: {}, scenes: [{ n: 1, title: "", secs: 5, prose: "" }], notes: [] }),
    });
    refreshProjects(); refresh();
    setSelection(json.id);
    router.push("/atomik/treatment");
  }

  return (
    <div className="ak-page">
      <div className="page-head">
        <div className="flex max-w-[640px] flex-col gap-2.5">
          <h1 className="ak-h1">Ideas</h1>
          <p className="ak-sub !text-[15px]">A logline, a tone, a few references. Pin the ones worth a brief. When one becomes a production it keeps its card, and the card keeps pointing at it.</p>
        </div>
        <div className="page-acts items-center">
          <div className="seg" role="tablist">
            {([["all", "All"], ["pinned", "Pinned"], ["production", "In production"], ["parked", "Parked"]] as [Filter, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={`seg-opt ${filter === k ? "is-on" : ""}`} onClick={() => setFilter(k)}>{l}<span className="seg-n">{counts[k]}</span></button>
            ))}
          </div>
          <Link href="/atomik/agent" className="btn-secondary !h-[38px]">Ask the agent →</Link>
          <button type="button" className="btn-primary !px-4" onClick={() => setComposing(true)} disabled={!signedIn}>New idea</button>
        </div>
      </div>

      {!signedIn ? (
        <Empty title="Ideas are for the team" line="Sign in to see what the studio is thinking about, and to pin what deserves a brief." />
      ) : !data ? (
        <Waiting label="Opening the ideas" />
      ) : (
        <div className="ak-ideas">
          {composing && <NewIdea onDone={() => { setComposing(false); refresh(); }} onCancel={() => setComposing(false)} />}
          {shown.map((i) => {
            const s = shownState(i);
            return (
              <article key={i.id} className={`ak-idea ${s === "production" ? "is-production" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="mono !tracking-[.14em] !text-[10px]">#{String(i.num).padStart(2, "0")} · {day(i.createdAt)}</span>
                  <span className={`ak-state ${s === "production" ? "is-approved" : s === "pinned" ? "is-ink" : ""}`}>
                    <span className={`dot dot-sm ${s === "production" ? "dot-approved" : s === "pinned" ? "dot-picked" : s === "parked" ? "dot-none" : "dot-draft"}`} />
                    {s.toUpperCase()}
                  </span>
                </div>
                <p className="ak-logline">{i.logline}</p>
                {i.tone.length > 0 && <div className="flex flex-wrap gap-[5px]">{i.tone.map((t) => <span key={t} className="ak-tag is-line">{t}</span>)}</div>}
                <div className="grid grid-cols-3 gap-1.5">
                  {i.refs.map((r) => (
                    <span key={r} className="ak-ref">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/uploads/${r}`} alt="" loading="lazy" />
                    </span>
                  ))}
                  {i.refs.length === 0 && <span className="ak-ref">no refs</span>}
                </div>
                <div className="ak-idea-foot">
                  <span className="ak-sub !text-[12px]">
                    {initials(i.byName)} · {i.pins.length} pin{i.pins.length === 1 ? "" : "s"}{s === "parked" && i.parkedByName ? ` · parked by ${initials(i.parkedByName)}` : ""}
                  </span>
                  <span className="flex items-center gap-3">
                    {s === "production" && i.projectId && (
                      <Link href={`/projects/${i.projectId}/canvas`} className="ak-act" onClick={() => setSelection(i.projectId!)}>
                        {(i.projectName ?? "production").toUpperCase()} · {i.shots} SHOT{i.shots === 1 ? "" : "S"} → PARTICL
                      </Link>
                    )}
                    {s !== "production" && i.projectId && (
                      <Link href="/atomik/shots" className="ak-act" onClick={() => setSelection(i.projectId!)}>{(i.projectName ?? "production").toUpperCase()} · BRIEF → SHOT LIST</Link>
                    )}
                    {s === "pinned" && !i.projectId && <button type="button" className="ak-act" onClick={() => produce(i)}>WRITE THE TREATMENT →</button>}
                    {s === "open" && <button type="button" className="ak-act" onClick={() => patch(i, { pin: true })}>PIN IT</button>}
                    {s === "pinned" && <button type="button" className="ak-act is-muted" onClick={() => patch(i, { pin: true })} title="Take your pin off">{i.pins.length > 1 ? "PIN" : "UNPIN"}</button>}
                    {s === "parked" && <button type="button" className="ak-act" onClick={() => patch(i, { state: i.pins.length ? "pinned" : "open" })}>UNPARK</button>}
                    {(s === "open" || s === "pinned") && !i.projectId && <button type="button" className="ak-act is-muted" onClick={() => patch(i, { state: "parked" })}>PARK</button>}
                    {!i.projectId && <button type="button" className="ak-act is-muted" onClick={() => remove(i)} title="Delete">×</button>}
                  </span>
                </div>
              </article>
            );
          })}
          {shown.length === 0 && !composing && (
            <div className="col-span-full"><Empty compact title={filter === "all" ? "No ideas yet" : `Nothing ${filter === "production" ? "in production" : filter}`} line={filter === "all" ? "Write the first one — a logline is enough." : undefined} /></div>
          )}
        </div>
      )}
    </div>
  );
}

/** The new card: a logline, tones, up to three references, then Save. */
function NewIdea({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [logline, setLogline] = useState("");
  const [tone, setTone] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  async function addRefs(files: FileList) {
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const f of Array.from(files).slice(0, 3 - refs.length)) ids.push((await uploadFile(f, "reference")).id);
      setRefs((r) => [...r, ...ids].slice(0, 3));
    } catch (e) { await appAlert("The reference didn't upload", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!logline.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/atomik/ideas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logline: logline.trim(), tone: tone.split(",").map((t) => t.trim()).filter(Boolean), refs }),
      });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      onDone();
    } catch (e) { await appAlert("Not saved", (e as Error).message); setBusy(false); }
  }
  return (
    <article className="ak-idea is-new">
      <span className="mono !tracking-[.14em] !text-[10px]">NEW IDEA</span>
      <textarea className="ak-idea-input" rows={4} value={logline} onChange={(e) => setLogline(e.target.value)} autoFocus
        placeholder="The logline. One or two sentences: who, what happens, and what it should feel like." />
      <input className="ak-idea-input !min-h-0" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tone, comma-separated — Tense, Practicals, Bleach bypass, 30s" />
      <div className="grid grid-cols-3 gap-1.5">
        {refs.map((r) => (
          <span key={r} className="ak-ref">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/uploads/${r}`} alt="" />
          </span>
        ))}
        {refs.length < 3 && <button type="button" className="ak-ref is-add" onClick={() => file.current?.click()} disabled={busy}>+ ref</button>}
      </div>
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addRefs(e.target.files); e.target.value = ""; }} />
      <div className="ak-idea-foot">
        <button type="button" className="ak-act is-muted" onClick={onCancel}>CANCEL</button>
        <button type="button" className="btn-primary !h-[34px] !px-3.5 !text-[12.5px]" onClick={save} disabled={busy || !logline.trim()}>{busy ? "Saving…" : "Save idea"}</button>
      </div>
    </article>
  );
}
