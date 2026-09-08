"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { usePageTitle } from "@/lib/usePageTitle";
import { useProject } from "@/lib/projectContext";
import { useSession, useSignInHref } from "@/lib/session";
import { RequestAccessButton } from "@/components/RequestAccess";
import { announceChange } from "@/lib/changes";
import { usd } from "@/lib/format";
import Boundary from "@/components/Boundary";
import { AtomikSpinner } from "@/components/AtomikMark";
import { AtomikStacked } from "@/components/AtomikMark";
import ApprovalCard from "@/components/atomik/ApprovalCard";
import ModelMenu, { type PlannerModel } from "@/components/atomik/ModelMenu";
import { useDraft } from "@/lib/useDraft";
import type { Chat, Message, Step, Engine, AgentMode } from "@/lib/atomik";
import { uploadFile } from "@/lib/uploadClient";
import { MAX_ATTACHMENTS, attachmentId, type Attachment } from "@/lib/attachments";
import { readDraggedAsset, readDraggedCast } from "@/lib/dnd";
import LazyMedia from "@/components/LazyMedia";
import type { Gen } from "@/components/GenCard";

/**
 * Atomik.
 *
 * One column of conversation and one gate. You describe a production, a
 * model you chose works out the shots, and every render it wants to make
 * stops at a card with the price on the button. Nothing is spent by the
 * agent; everything is spent by a person pressing Approve.
 *
 * The screen deliberately has no plan table, no step editor, no board. The
 * plan lives in the sentence the agent wrote and in the queue of cards
 * behind the gate — because the moment that matters is not "does this list
 * look right", it is "am I paying for this particular render", and that is
 * the only moment this screen tries to be good at.
 */

type Loaded = { chat: Chat; messages: Message[]; steps: Step[] };
type Index = {
  chats: (Chat & { needsApproval: boolean })[];
  engines: Engine[];
  models: { featured: PlannerModel[]; rest: PlannerModel[] };
};

/**
 * Picking something the workspace already has (attachments): its own takes,
 * or its cast. One sheet, because the two lists read the same way and the
 * agent treats what comes back the same way — as a thing it can look at and
 * hand on to a render.
 */
function PickSheet({ what, onPick, onClose }: {
  what: "take" | "cast";
  onPick: (a: Attachment) => void;
  onClose: () => void;
}) {
  const { selection } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  const { data: takes } = useApi<{ generations: Gen[] }>(
    what === "take" ? `/api/jobs?limit=60&sync=0${scoped ? `&projectId=${encodeURIComponent(selection)}` : ""}` : null, 0);
  const { data: cast } = useApi<{ cast: { id: string; name: string; kind: string; uploadId: string | null }[] }>(
    what === "cast" ? "/api/cast?projectId=all" : null, 0);
  const rows = (takes?.generations ?? []).filter((g) => g.status === "succeeded" && g.storedUrl && g.kind !== "audio");
  const people = (cast?.cast ?? []).filter((c) => c.uploadId);

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="ws-bar-h">{what === "take" ? "A take from the wall" : "Someone from the cast"}</span>
          <button type="button" className="chip ml-auto" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          {what === "take" ? (
            rows.length ? (
              <div className="pick-grid">
                {rows.map((g) => (
                  <button key={g.id} type="button" className="pick-tile"
                    onClick={() => { onPick({ genId: g.id, kind: g.kind === "image" ? "image" : "video", name: g.title || g.shotCode || g.id, mime: g.kind === "image" ? "image/png" : "video/mp4" }); onClose(); }}>
                    <LazyMedia url={g.storedUrl as string} kind={g.kind === "image" ? "image" : "video"} alt="" className="!absolute inset-0" />
                    <span className="pick-cap">{g.shotCode ? `${g.shotCode} v${g.version ?? 1}` : (g.title || "take")}</span>
                  </button>
                ))}
              </div>
            ) : <p className="rail-help">Nothing rendered yet in this production.</p>
          ) : (
            people.length ? (
              <div className="pick-grid">
                {people.map((c) => (
                  <button key={c.id} type="button" className="pick-tile"
                    onClick={() => { onPick({ uploadId: c.uploadId as string, kind: "image", name: c.name, mime: "image/png", cast: c.name }); onClose(); }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/uploads/${c.uploadId}`} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    <span className="pick-cap">@{c.name}</span>
                  </button>
                ))}
              </div>
            ) : <p className="rail-help">Nobody in the cast has a still yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AtomikPage() {
  usePageTitle("Atomik · Agent");
  const router = useRouter();
  const params = useSearchParams();
  const chatId = params.get("c");
  const { selection } = useProject();
  const { signedIn } = useSession();
  const signIn = useSignInHref();

  const { data: index, refresh: refreshIndex } = useApi<Index>("/api/atomik", 0);
  const { data: loaded, error: loadError, refresh: refreshChat } =
    useApi<Loaded>(chatId ? `/api/atomik/${encodeURIComponent(chatId)}` : null, 0);

  /* What is being typed survives leaving the room; cleared only when sent. */
  const { value: draft, set: setDraft, clear: clearDraft } = useDraft("atomik-agent", "");
  /* What the person hands the agent: it looks at the stills, and a render
     it proposes for them carries the same files (attachments). */
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [plus, setPlus] = useState(false);
  const [picking, setPicking] = useState<"take" | "cast" | null>(null);
  const [thinking, setThinking] = useState(false);
  const [busyStep, setBusyStep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The chat row is the truth; this is only what someone has just picked,
     remembered against the chat it was picked for. Mirroring the row into
     state instead would mean an effect that writes state on every load —
     a cascading render, and a choice that silently follows you into the
     next conversation. */
  const [picked, setPicked] = useState<{ id: string | null; model: string; mode: AgentMode } | null>(() => {
    /* An idea card hands its reasoning model over in the URL for the chat
       it is about to start; an existing chat keeps its own. */
    const want = params.get("model");
    return want && !chatId ? { id: null, model: want, mode: "ask" } : null;
  });
  const mine = picked && picked.id === chatId ? picked : null;
  const bottom = useRef<HTMLDivElement>(null);

  /* A live handle on the CURRENT refresh.
     send() starts while this chat has no id and therefore no url, and
     useApi's refresh is bound to the url it was made with — so the refresh
     captured at the top of send() is a no-op for the chat send() is about
     to create. The first reply of every new conversation never appeared
     because of it. */
  const refreshRef = useRef(refreshChat);
  useEffect(() => { refreshRef.current = refreshChat; }, [refreshChat]);

  /* Steps this browser has already sent to a vendor. The server refuses a
     second claim, so this cannot prevent a double charge — it prevents the
     pointless second request, and keeps the auto-mode effect from looping
     on a step whose refresh has not landed yet. */
  const dispatched = useRef<Set<string>>(new Set());

  const engines = useMemo(() => index?.engines ?? [], [index]);
  const model = mine?.model ?? loaded?.chat.model ?? "auto";
  const mode: AgentMode = mine?.mode ?? loaded?.chat.agentMode ?? "ask";
  const messages = loaded?.messages ?? [];
  const steps = loaded?.steps ?? [];
  const pending = steps.find((s) => s.status === "proposed") ?? null;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending?.id, thinking]);

  /* ── sending ── */

  const send = useCallback(async (text: string) => {
    const body = text.trim();
    if (!body || thinking) return;
    setError(null);
    setThinking(true);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch("/api/atomik", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model, agentMode: mode,
            projectId: selection === "all" || selection === "unfiled" ? null : selection,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error ?? "Couldn't start a chat.");
        id = j.id as string;
        router.replace(`/atomik/agent?c=${encodeURIComponent(id)}`);
      }
      clearDraft();
      setFiles([]);   // they went with the message
      const res = await fetch(`/api/atomik/${encodeURIComponent(id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, attachments: files }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(j.error ?? "The planner didn't answer.");
      refreshRef.current();
      refreshIndex();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
    }
  }, [chatId, thinking, model, mode, selection, router, refreshIndex, clearDraft, files]);

  /** A take from the wall, or a cast member's still: attached like any file. */
  const addAttachment = (a: Attachment) => setFiles((prev) =>
    prev.some((x) => attachmentId(x) === attachmentId(a)) ? prev : [...prev, a].slice(0, MAX_ATTACHMENTS));

  /** Upload what was picked or dropped, and keep it until the message goes. */
  async function attach(list: FileList | null) {
    const picked = [...(list ?? [])].slice(0, MAX_ATTACHMENTS - files.length);
    if (!picked.length) return;
    setAttaching(true);
    try {
      const added: Attachment[] = [];
      for (const f of picked) {
        const up = await uploadFile(f, "reference");
        added.push({ uploadId: up.id, kind: up.kind === "video" ? "video" : "image", name: f.name, mime: up.mime || f.type || "image/png" });
      }
      setFiles((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS));
    } catch (e) { setError((e as Error).message); }
    finally { setAttaching(false); }
  }

  /* ── the gate ── */

  /**
   * Approve one step: turn it into a real render.
   *
   * It goes through the ordinary generate routes rather than a private
   * path, so an Atomik render is indistinguishable from a hand-made one
   * afterwards — same project, same wall, same ledger, same retry rules.
   * The step keeps the generation's id so the card can become a thumbnail.
   */
  const approve = useCallback(async (proposed: Step) => {
    if (busyStep || dispatched.current.has(proposed.id)) return;
    dispatched.current.add(proposed.id);
    setBusyStep(true);
    setError(null);
    try {
      /* Claim it first. The server moves the row from proposed to running
         in one conditional UPDATE and hands back the step AS STORED, so
         two tabs, a double click and a re-running effect all resolve to one
         winner — and the render is billed for what was priced rather than
         for whatever this browser had in memory. */
      const claim = await fetch(`/api/atomik/steps/${proposed.id}/claim`, { method: "POST" });
      const cj = await claim.json().catch(() => ({}));
      if (!claim.ok) {
        if (claim.status !== 409) setError(cj.error ?? "That step couldn't be started.");
        return;
      }
      const step: Step = cj.step;

      const projectId = loaded?.chat.projectId ?? null;
      const res = step.kind === "audio"
        ? await fetch("/api/audio", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: typeof step.params.task === "string" ? step.params.task : "sound",
            text: step.prompt, projectId, title: step.title,
            durationSeconds: Number(step.params.seconds) || undefined,
          }),
        })
        : await fetch("/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: step.prompt, model: step.model, projectId,
            ratio: step.params.ratio, resolution: step.params.resolution,
            duration: Number(step.params.seconds) || undefined,
            /* What the person attached, on the render the agent proposed for it. */
            references: step.refs?.length ? step.refs : undefined,
          }),
        });
      const j = await res.json().catch(() => ({}));

      if (!res.ok) {
        await fetch(`/api/atomik/steps/${step.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "failed", error: j.error ?? `Failed (${res.status})` }),
        });
        setError(j.error ?? "That render didn't start.");
      } else {
        await fetch(`/api/atomik/steps/${step.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", genId: j.id ?? null }),
        });
        announceChange();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      /* The refresh lands BEFORE the button is released. Releasing first
         re-rendered the page with the step still reading "proposed", which
         is what let auto mode approve — and pay for — the same step twice. */
      await refreshRef.current();
      setBusyStep(false);
    }
  }, [busyStep, loaded]);

  const reject = useCallback(async (step: Step, instead: string) => {
    if (busyStep) return;
    setBusyStep(true);
    try {
      await fetch(`/api/atomik/steps/${step.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      });
      await refreshRef.current();
      if (instead) await send(instead);
    } finally {
      await refreshRef.current();
      setBusyStep(false);
    }
  }, [busyStep, send]);

  /* Awaited, so the price on the button is the re-priced one before anyone
     can press it. */
  const editStep = useCallback(async (patch: {
    prompt?: string; params?: Record<string, unknown>;
  }) => {
    if (!pending) return;
    const res = await fetch(`/api/atomik/steps/${pending.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "That change didn't stick.");
    }
    await refreshRef.current();
  }, [pending]);

  /* An optimistic control that never checks the write is a control that
     lies: the menu would keep showing the model you chose while the chat
     went on planning with the old one. */
  const setChatModel = useCallback(async (id: string) => {
    const was = model;
    setPicked({ id: chatId, model: id, mode });
    if (!chatId) return;
    const res = await fetch(`/api/atomik/${encodeURIComponent(chatId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
    });
    if (!res.ok) {
      setPicked({ id: chatId, model: was, mode });
      setError("That planner didn't stick. Still using " + was + ".");
      return;
    }
    refreshChat();
  }, [chatId, refreshChat, mode, model]);

  const setChatMode = useCallback(async (m: AgentMode) => {
    const was = mode;
    setPicked({ id: chatId, model, mode: m });
    if (!chatId) return;
    const res = await fetch(`/api/atomik/${encodeURIComponent(chatId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentMode: m }),
    });
    if (!res.ok) {
      setPicked({ id: chatId, model, mode: was });
      setError("That didn't stick — still " + (was === "ask" ? "asking before each render." : "generating without asking."));
      return;
    }
    refreshChat();
  }, [chatId, refreshChat, model, mode]);

  /* Auto mode: the person has said they do not want to be asked, so the
     gate approves itself. Deferred off the effect body because `approve`
     sets state on its first synchronous line, and the same call is used
     either way — so the ledger and the step row cannot tell the two modes
     apart. */
  useEffect(() => {
    if (mode !== "auto" || !pending || busyStep || thinking) return;
    const step = pending;
    let live = true;
    Promise.resolve().then(() => { if (live) approve(step); });
    return () => { live = false; };
  }, [mode, pending, busyStep, thinking, approve]);

  /* A chat that failed to LOAD is not an empty chat. Falling through to the
     hero told someone whose transcript was one network blip away that they
     had no conversation at all. */
  const brokenLoad = Boolean(chatId && loadError && !loaded);
  const empty = !brokenLoad && (!chatId || (messages.length === 0 && !thinking));

  return (
    <div className="atomik">
      <div className="atomik-scroll">
        {brokenLoad ? (
          <div className="atomik-hero">
            <p className="atomik-sub">This conversation didn&rsquo;t load.</p>
            <p className="text-[12.5px] text-mute">{loadError}</p>
            <button type="button" className="chip mt-2" onClick={() => refreshChat()}>
              Try again
            </button>
          </div>
        ) : empty ? (
          <div className="atomik-hero">
            {/* The one place the section introduces itself, so it does it
                properly: the stacked lockup with the parent's name under it.
                Once there is a conversation this is gone for good. */}
            <AtomikStacked size={30} className="text-ink" />
            <h1 className="atomik-h1">What are we creating today?</h1>
            <p className="atomik-sub">
              Describe the whole thing. Atomik works out the shots and asks before it spends.
            </p>
            {!signedIn && (
              <p className="atomik-sub !text-[13px]">
                <a href={signIn} className="text-ink underline underline-offset-4">Sign in</a>
                {" or "}
                <RequestAccessButton className="text-ink underline underline-offset-4"
                  label="contact management" />
                {" to use it."}
              </p>
            )}
            <div className="atomik-seeds">
              {SEEDS.map((s) => (
                <button key={s} type="button" className="atomik-seed"
                  onClick={() => { setDraft(s); }}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="atomik-thread">
            <Boundary what="This conversation" compact resetKey={chatId ?? ""}>
              {messages.map((m) => (
                <Turn key={m.id} message={m} steps={steps.filter((s) => s.messageId === m.id)}
                  onAnswer={send} />
              ))}
            </Boundary>
            {thinking && (
              <p className="atomik-working">
                <AtomikSpinner size={15} className="text-blue" />
                Working…
              </p>
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <div className="atomik-dock">
        {error && (
          <p className="atomik-error" onClick={() => setError(null)} title="Dismiss">{error}</p>
        )}

        {pending && mode === "ask" && (
          <ApprovalCard
            step={pending} engines={engines} busy={busyStep}
            onApprove={approve} onReject={reject} onEdit={editStep}
            onAlwaysAllow={() => setChatMode("auto")}
          />
        )}

        {picking && <PickSheet what={picking} onPick={addAttachment} onClose={() => setPicking(null)} />}
        <div className="atomik-composer"
          onDragOver={(e) => { if (signedIn) e.preventDefault(); }}
          onDrop={(e) => {
            if (!signedIn) return;
            e.preventDefault();
            /* Atomik and particl are one app: a take dragged off the wall or
               a cast member dragged out of the Studio attaches here exactly
               as a file does. */
            const gen = readDraggedAsset(e);
            if (gen) { addAttachment({ genId: gen.gen.id, kind: gen.gen.kind === "image" ? "image" : "video", name: gen.gen.title || gen.gen.id, mime: gen.gen.kind === "image" ? "image/png" : "video/mp4" }); return; }
            const cast = readDraggedCast(e);
            if (cast?.uploadId) { addAttachment({ uploadId: cast.uploadId, kind: "image", name: cast.name, mime: "image/png", cast: cast.name }); return; }
            if (cast) { setDraft(`${draft}${draft.endsWith(" ") || !draft ? "" : " "}@${cast.name} `); return; }
            void attach(e.dataTransfer.files);
          }}>
          {files.length > 0 && (
            <div className="atomik-files">
              {files.map((f) => (
                <span key={attachmentId(f)} className="atomik-file"
                  onContextMenu={(e) => { e.preventDefault(); setFiles((prev) => prev.filter((x) => attachmentId(x) !== attachmentId(f))); }}
                  title="Right-click to take it off">
                  {f.kind === "image"
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={f.genId ? `/api/media/${f.genId}` : `/api/uploads/${f.uploadId}`} alt="" />
                    : <span className="atomik-file-kind">CLIP</span>}
                  <span className="truncate">{f.name || f.uploadId}</span>
                  <button type="button" onClick={() => setFiles((prev) => prev.filter((x) => attachmentId(x) !== attachmentId(f)))} aria-label={`Remove ${f.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault(); send(draft);
              }
            }}
            rows={1}
            disabled={!signedIn}
            placeholder={!signedIn
              ? "Sign in to plan a production — the rest of this screen is yours to look at."
              : pending
                ? "Approve the card above, or say what to do instead…"
                : "Describe what you want made…"}
            className="atomik-input"
          />
          <div className="atomik-controls">
            <ModelMenu value={model} models={index?.models ?? { featured: [], rest: [] }}
              onPick={setChatModel} disabled={thinking} />

            {/* One button, three places a thing can come from: this machine,
                the workspace's own takes, or its cast. Atomik and particl are
                one app, so the agent reaches everything the wall does. */}
            <span className="relative">
              <button type="button" className={`chip-ctl ${plus ? "is-open" : ""}`} disabled={!signedIn || attaching || files.length >= MAX_ATTACHMENTS}
                onClick={() => setPlus((v) => !v)}
                title={files.length >= MAX_ATTACHMENTS ? `${MAX_ATTACHMENTS} at a time` : "Attach a still, a clip, a take or someone from the cast"}>
                {attaching ? "Attaching…" : "+ Attach"}
              </button>
              {plus && (
                <span className="menu-pop atomik-plus">
                  <label className="menu-item cursor-pointer">
                    Attach a file
                    <input type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" className="sr-only"
                      onChange={(e) => { setPlus(false); void attach(e.target.files); e.target.value = ""; }} />
                  </label>
                  <button type="button" className="menu-item" onClick={() => { setPlus(false); setPicking("take"); }}>A take from the wall</button>
                  <button type="button" className="menu-item" onClick={() => { setPlus(false); setPicking("cast"); }}>Someone from the cast</button>
                </span>
              )}
            </span>

            <button type="button" disabled={thinking}
              onClick={() => setChatMode(mode === "ask" ? "auto" : "ask")}
              className={`chip-ctl ${mode === "ask" ? "" : "is-on"}`}
              title={mode === "ask"
                ? "Every generation stops for your approval"
                : "Generations run as soon as the agent decides on them"}>
              {mode === "ask" ? "Ask before generating" : "Generate without asking"}
            </button>

            <span className="ml-auto flex items-center gap-2">
              {loaded && loaded.chat.textCostUsd > 0 && (
                <span className="atomik-spent" title="What the thinking has cost in this chat">
                  {usd(loaded.chat.textCostUsd, 3)}
                </span>
              )}
              {signedIn ? (
                <button type="button" className="btn-render !px-4 !py-2"
                  disabled={thinking || !draft.trim()}
                  onClick={() => send(draft)}>
                  {thinking ? "…" : "Send"}
                </button>
              ) : (
                <a href={signIn} className="btn-render !px-4 !py-2 !text-[14px]">Sign in</a>
              )}
            </span>
          </div>
        </div>
        <p className="atomik-fineprint">
          Models can be wrong, and every render costs money. Nothing is spent until you approve it.
        </p>
      </div>
    </div>
  );
}

const SEEDS = [
  "A 20 second cinematic ad for a stainless steel water bottle",
  "Three product stills of a leather bag, warm window light",
  "A 30 second title sequence for a documentary about monsoon farming",
];

/* ── One turn ─────────────────────────────────────────────────────────── */

function Turn({ message, steps, onAnswer }: {
  message: Message; steps: Step[]; onAnswer: (t: string) => void;
}) {
  const [openActivity, setOpenActivity] = useState(false);

  if (message.role === "user") {
    return <p className="atomik-said">{message.text}</p>;
  }

  const worked = message.workedMs
    ? message.workedMs > 60_000
      ? `${Math.round(message.workedMs / 60_000)}m ${Math.round((message.workedMs % 60_000) / 1000)}s`
      : `${(message.workedMs / 1000).toFixed(0)}s`
    : null;

  return (
    <div className="atomik-turn">
      {(worked || message.activity.length > 0) && (
        <button type="button" className="atomik-worked"
          onClick={() => setOpenActivity((v) => !v)}
          aria-expanded={openActivity}>
          <span className={`atomik-worked-caret ${openActivity ? "is-open" : ""}`}>›</span>
          {worked ? `Worked for ${worked}` : "What it weighed"}
          {message.activity.length > 0 && (
            <span className="atomik-worked-n">{message.activity.length}</span>
          )}
        </button>
      )}
      {openActivity && message.activity.length > 0 && (
        <ul className="atomik-activity">
          {message.activity.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}

      {message.text && <p className="atomik-says">{message.text}</p>}

      {message.ask && (
        <div className="atomik-ask">
          <p className="atomik-ask-q">{message.ask.question}</p>
          {message.ask.options.length > 0 && (
            <div className="atomik-ask-opts">
              {message.ask.options.map((o) => (
                <button key={o} type="button" className="chip !text-[13px]"
                  onClick={() => onAnswer(o)}>{o}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {steps.length > 0 && (
        <ul className="atomik-steps">
          {steps.map((s) => <StepRow key={s.id} step={s} />)}
        </ul>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const tone =
    step.status === "done" ? "is-done"
      : step.status === "failed" ? "is-failed"
        : step.status === "rejected" ? "is-rejected"
          : step.status === "running" ? "is-running" : "";
  const said =
    step.status === "done" ? "Rendering"
      : step.status === "failed" ? (step.error ?? "Failed")
        : step.status === "rejected" ? "Rejected"
          : step.status === "running" ? "Starting…"
            : "Waiting for approval";
  return (
    <li className={`atomik-step ${tone}`}>
      <span className="atomik-step-kind">{step.kind}</span>
      <span className="min-w-0 flex-1 truncate" title={step.prompt}>{step.title}</span>
      <span className="atomik-step-state">{said}</span>
    </li>
  );
}
