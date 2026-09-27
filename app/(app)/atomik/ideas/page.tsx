"use client";

import {usePaidAction,type PaidAction} from "@/lib/usePaidAction";
import { setAtomikRail } from "@/lib/atomikRail";

/**
 * Atomik · Ideas — from the pipeline handoff.
 *
 * A logline, a tone, a few references. Pin the ones worth a brief. When
 * one becomes a production it keeps its card, and the card keeps pointing
 * at it: the state is read off what happened — a card with a production
 * that has shots is IN PRODUCTION whatever anyone set.
 *
 * The new card carries a REASONING row: which model does the thinking,
 * chosen from what Vercel AI Gateway is serving today (the same menu the
 * agent uses), and a button that has that model write the note up into a
 * logline and tone list. The pick is saved on the idea and carried into
 * "Ask the agent", so a production planned from this card is planned by
 * the model that was chosen for it.
 *
 * Everything typed here is a draft that survives leaving the page.
 */
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useAtomikQuote } from "@/lib/useAtomikQuote";
import { useProject } from "@/lib/projectContext";
import { useUploadFile } from "@/lib/useUploadFile";
import { useDraft } from "@/lib/useDraft";
import { textCostLabel } from "@/lib/textCostLabel";
import { useMoney } from "@/lib/price";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { Empty, Waiting } from "@/components/ParticlMark";
import { EffortPicker } from "@/components/atomik/ModelPicker";
import ModelMenu, { type PlannerModel } from "@/components/atomik/ModelMenu";
import { usePageTitle } from "@/lib/usePageTitle";
import type { Idea, IdeaState } from "@/lib/atomikDocs";

type Row = Idea & { projectName: string | null; shots: number; byName: string | null; parkedByName: string | null };
type Filter = "all" | "pinned" | "production" | "parked";
type Models = { featured: PlannerModel[]; rest: PlannerModel[] };
type IdeaDraft = { logline: string; tone: string; refs: string[]; model: string; effort?: string };

const EMPTY_DRAFT: IdeaDraft = { logline: "", tone: "", refs: [], model: "auto", effort: "auto" };
const NO_MODELS: Models = { featured: [], rest: [] };

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const initials = (name: string | null) => (name ?? "—").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
/** The card's state is what happened to it, not only what was set. */
const shownState = (i: Row): IdeaState => (i.projectId && i.shots > 0 ? "production" : i.state === "production" ? "pinned" : i.state);
/** The tail of a gateway model id — `anthropic/claude-opus-5` reads as `claude-opus-5`. */
const modelTail = (id: string | null) => (id ?? "auto").split("/").pop() ?? "auto";

export default function IdeasPage() {
  usePageTitle("Atomik · Ideas");
  const router = useRouter();
  const { signedIn } = useSession();
  const { setSelection, refreshProjects } = useProject();
  const { data, refresh } = useApi<{ ideas: Row[] }>(signedIn ? "/api/atomik/ideas" : null, 15_000);
  /* The planner menu rides along with the agent's index — a cached read of
     the gateway's catalogue, not a query worth its own endpoint. */
  const { data: index } = useApi<{ models: Models }>(signedIn ? "/api/atomik" : null, 0);
  const models = index?.models ?? NO_MODELS;
  const [filter, setFilter] = useState<Filter>("all");
  const draft = useDraft<IdeaDraft>("atomik-idea", EMPTY_DRAFT);
  const paid=usePaidAction("/api/atomik/ideas/draft");
  const [composingChoice, setComposingChoice] = useState<boolean | null>(null);
  /* The card is open when someone opened it — or when a draft came back
     from the last visit, so the words are on screen rather than in storage. */
  const composing = !!paid.pending || (composingChoice ?? draft.restored);
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
    if (!(await appConfirm(`Delete idea #${String(i.num).padStart(2, "0")}?`, "Its project, if it has one, stays.", { confirmLabel: "Delete", danger: true }))) return;
    const res = await fetch(`/api/atomik/ideas/${i.id}`, { method: "DELETE" });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await appAlert("Not deleted", j.error ?? `The server answered ${res.status}.`); return; }
    refresh();
  }
  /* Writing the treatment is what makes a production: the idea gets a
     project, the project gets a treatment seeded from the logline. */
  async function produce(i: Row) {
    const suggested = i.logline.split(/[.!?]/)[0]?.trim().slice(0, 40) ?? "";
    const name = await appPrompt("Name the project", suggested, "Northline");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id) { await appAlert("Couldn't create the project", json.error); return; }
    /* The project exists from here on. If linking the card or seeding the
       treatment fails, say which, and stay on the card: the project is kept
       and the treatment can be written by hand. */
    const failed = async (res: Response) => (res.ok ? null : ((await res.json().catch(() => ({}))).error as string | undefined) ?? `The server answered ${res.status}.`);
    const linked = await failed(await fetch(`/api/atomik/ideas/${i.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: json.id, state: "pinned" }) }));
    const seeded = linked ? null : await failed(await fetch("/api/atomik/treatment", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: json.id, ideaId: i.id, title: name.trim(), logline: i.logline, setup: {}, scenes: [{ n: 1, title: "", secs: 5, prose: "" }], notes: [] }),
    }));
    refreshProjects(); refresh();
    if (linked || seeded) {
      await appAlert(linked ? `${name.trim()} was made, but this card isn't linked to it` : `${name.trim()} was made, but its treatment wasn't started`, linked ?? seeded ?? "");
      return;
    }
    setSelection(json.id);
    router.push("/atomik/treatment");
  }

  return (
    <div className="ak-page">
      <div className="page-head">
        <div className="flex max-w-[640px] flex-col gap-2.5">
          <h1 className="ak-h1">Ideas</h1>
          <p className="ak-sub !text-[15px]">A logline, a tone, a few references. Pin the ones worth a brief. When one becomes a project it keeps its card, and the card keeps pointing at it.</p>
        </div>
        <div className="page-acts items-center">
          <div className="seg" role="tablist">
            {([["all", "All"], ["pinned", "Pinned"], ["production", "In production"], ["parked", "Parked"]] as [Filter, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={`seg-opt ${filter === k ? "is-on" : ""}`} onClick={() => setFilter(k)}>{l}<span className="seg-n">{counts[k]}</span></button>
            ))}
          </div>
          <button type="button" onClick={() => setAtomikRail("compact")} className="btn-secondary !h-[38px]">Ask Atomik →</button>
          <button type="button" className="btn-primary !px-4" onClick={() => setComposingChoice(true)} disabled={!signedIn} title={signedIn ? undefined : "Sign in to write an idea"}>New idea</button>
        </div>
      </div>

      {!signedIn ? (
        <Empty title="Ideas are for the team" line="Sign in to see what the studio is thinking about, and to pin what deserves a brief." />
      ) : !data ? (
        <Waiting label="Opening the ideas" />
      ) : (
        <div className="ak-ideas">
          {composing && (
            <NewIdea onWriting={()=>setComposingChoice(true)} paid={paid} draft={draft.value} set={draft.set} models={models}
              onDone={() => { draft.clear(); setComposingChoice(false); refresh(); }}
              onCancel={() => { draft.clear(); setComposingChoice(false); }} />
          )}
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
                    {initials(i.byName)} · {i.pins.length} pin{i.pins.length === 1 ? "" : "s"}{s === "parked" && i.parkedByName ? ` · parked by ${initials(i.parkedByName)}` : ""}{i.model ? ` · ${modelTail(i.model)}${i.effort && i.effort !== "auto" ? ` · ${i.effort} effort` : ""}` : ""}
                  </span>
                  <span className="flex items-center gap-3">
                    {s === "production" && i.projectId && (
                      <Link href={`/projects/${i.projectId}/canvas`} className="ak-act" onClick={() => setSelection(i.projectId!)}>
                        {(i.projectName ?? "project").toUpperCase()} · {i.shots} SHOT{i.shots === 1 ? "" : "S"} → PARTICL
                      </Link>
                    )}
                    {s !== "production" && i.projectId && (
                      <Link href="/atomik/shots" className="ak-act" onClick={() => setSelection(i.projectId!)}>{(i.projectName ?? "project").toUpperCase()} · BRIEF → SHOT LIST</Link>
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

/**
 * The new card: a logline, tones, up to three references, the reasoning
 * model, then Save. The words live in the page's draft, so they are still
 * here after a detour to another screen.
 */
function NewIdea({ draft: currentDraft, paid, set, models, onDone, onCancel, onWriting }: {
  draft: IdeaDraft; paid:PaidAction; set: (next: IdeaDraft | ((prev: IdeaDraft) => IdeaDraft)) => void; models: Models;
  onDone: () => void; onCancel: () => void; onWriting:()=>void;
}) {
  const uploadFile = useUploadFile();
  const pendingBody=paid.pending?JSON.parse(paid.pending.body):null;
  const d:IdeaDraft=pendingBody?{...currentDraft,logline:pendingBody.brief,tone:pendingBody.tone,model:pendingBody.model,effort:pendingBody.effort??"auto"}:currentDraft;
  const [busy, setBusy] = useState<"" | "refs" | "write" | "save">("");
  /* What the model replaced, so one click brings the person's own words back. */
  const [written, setWritten] = useState<{ before: { logline: string; tone: string }; model: string; cost: string | null } | null>(null);
  const money = useMoney();
  const file = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<IdeaDraft>) => set((x) => ({ ...x, ...p }));

  async function addRefs(files: FileList) {
    setBusy("refs");
    try {
      const ids: string[] = [];
      for (const f of Array.from(files).slice(0, 3 - d.refs.length)) ids.push((await uploadFile(f, "reference")).id);
      set((x) => ({ ...x, refs: [...x.refs, ...ids].slice(0, 3) }));
    } catch (e) { await appAlert("The reference didn't upload", (e as Error).message); }
    finally { setBusy(""); }
  }
  /* What the write will cost, from the model that will run it — the one picked, else the platform's routing (brief 1.8). */
  const { quote, error: quoteError, loading: quoting } = useAtomikQuote("/api/atomik/ideas/draft", !paid.pending && d.logline.trim() ? { brief: d.logline, tone: d.tone, model: d.model, effort: d.effort ?? "auto" } : null);
  async function write() {
    if (!d.logline.trim() || (!paid.pending && !quote)) return;
    onWriting();
    setBusy("write");
    try {
      const {data:j}=await paid.run<{logline?:string;tone?:string[];model?:string;costUsd?:number;credits?:number|null}>("/api/atomik/ideas/draft",pendingBody ?? {brief:d.logline,tone:d.tone,model:quote!.model,effort:d.effort??"auto",maxCredits:quote!.estimateCredits});
      /* What the ledger billed, in credits; dollars only for a workspace on its own keys. */
      const cost = textCostLabel(money, j);
      setWritten({ before: { logline: d.logline, tone: d.tone }, model: String(j.model ?? d.model), cost });
      patch({
        logline: typeof j.logline === "string" && j.logline ? j.logline : d.logline,
        tone: Array.isArray(j.tone) && j.tone.length ? j.tone.join(", ") : d.tone,
      });
    } catch (e) { await appAlert("The model didn't answer", (e as Error).message); }
    finally { setBusy(""); }
  }
  function restore() {
    if (!written) return;
    patch(written.before);
    setWritten(null);
  }
  async function save() {
    if (!d.logline.trim()) return;
    setBusy("save");
    try {
      const res = await fetch("/api/atomik/ideas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logline: d.logline.trim(),
          tone: d.tone.split(",").map((t) => t.trim()).filter(Boolean),
          refs: d.refs,
          model: d.model === "auto" ? null : d.model,
          effort: d.effort ?? "auto",
        }),
      });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      onDone();
    } catch (e) { await appAlert("Not saved", (e as Error).message); setBusy(""); }
  }
  return (
    <article className="ak-idea is-new">
      <span className="mono !tracking-[.14em] !text-[10px]">NEW IDEA</span>
      {paid.error&&<p role="alert">{paid.error}</p>}
      {paid.pending&&<p role="status" className="ak-sub">Recover the saved writing request before continuing.</p>}
      <textarea className="ak-idea-input" rows={4} disabled={!!paid.pending} value={d.logline} onChange={(e) => patch({ logline: e.target.value })} autoFocus
        placeholder="The logline. One or two sentences: who, what happens, and what it should feel like — or just a note, and let the model write it up." />
      <input className="ak-idea-input !min-h-0" disabled={!!paid.pending} value={d.tone} onChange={(e) => patch({ tone: e.target.value })} placeholder="Tone, comma-separated — Tense, Practicals, Bleach bypass, 30s" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono !tracking-[.14em] !text-[10px]">REASONING</span>
        <ModelMenu value={d.model} models={models} onPick={(id) => patch({ model: id, effort: "auto" })} disabled={busy !== ""||!!paid.pending} />
        <EffortPicker value={d.effort ?? "auto"} model={[...models.featured, ...models.rest].find((m) => m.id === d.model)} onPick={(effort) => patch({ effort })} disabled={busy !== "" || !!paid.pending} compact />
        <button type="button" className="ak-act" onClick={write} disabled={busy !== "" || !!paid.error || !d.logline.trim() || (!paid.pending && !quote)}
          title="The model turns what you typed into a logline and a tone list. Your own words stay one click away.">
          {busy === "write" ? "WRITING…" : paid.pending ? "Recover writing request" : quote ? `WRITE IT · ${quote.estimateUsd === undefined ? `${quote.estimateCredits} CR RESERVED` : `$${quote.estimateUsd.toFixed(3)} ESTIMATE`} →` : quoting ? "QUOTING…" : "WRITE IT WITH THE MODEL"}
        </button>
        {written && (
          <span className="ak-sub !text-[11px] inline-flex items-center gap-2">
            {modelTail(written.model)}{written.cost ? ` · ${written.cost}` : ""}
            <button type="button" className="ak-act is-muted" onClick={restore}>MY WORDS</button>
          </span>
        )}
      </div>
      {quoteError && <p role="status" className="ak-sub">{quoteError}</p>}
      <div className="grid grid-cols-3 gap-1.5">
        {d.refs.map((r) => (
          <span key={r} className="ak-ref">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/uploads/${r}`} alt="" />
          </span>
        ))}
        {d.refs.length < 3 && <button type="button" className="ak-ref is-add" onClick={() => file.current?.click()} disabled={busy !== ""}>+ ref</button>}
      </div>
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addRefs(e.target.files); e.target.value = ""; }} />
      <div className="ak-idea-foot">
        <button type="button" className="ak-act is-muted" onClick={onCancel}>CANCEL</button>
        <button type="button" className="btn-primary !h-[34px] !px-3.5 !text-[12.5px]" onClick={save} disabled={busy !== "" || !!paid.pending || !!paid.error || !d.logline.trim()}>{busy === "save" ? "Saving…" : "Save idea"}</button>
      </div>
    </article>
  );
}
