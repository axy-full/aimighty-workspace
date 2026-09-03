"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApi } from "@/lib/useApi";
import { timeAgo } from "@/lib/format";
import { uploadFile } from "@/lib/uploadClient";
import { IconClose, IconPlus } from "./Icons";

type Member = { id: string; name: string };
type Attachment = {
  id: string; name: string; bytes: number; kind: string; mime: string;
  sha256: string; url: string;
};
type Msg = {
  id: string; userId: string; author: string; text: string;
  mentions: string[]; createdAt: number; attachment: Attachment | null;
};
type ChatResp = { messages: Msg[]; unread: number; mentioned: number; me: string };

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
  : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`;

/* Dock state lives in localStorage so it survives navigation. Read through
 * useSyncExternalStore: the server snapshot says closed, the client snapshot
 * reads storage, and React reconciles the difference after hydration instead
 * of tripping a mismatch error. */
const OPEN_KEY = "aw_chat_open";
const openListeners = new Set<() => void>();
function subscribeOpen(cb: () => void) {
  openListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { openListeners.delete(cb); window.removeEventListener("storage", cb); };
}
function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

export default function ChatDock() {
  const open = useSyncExternalStore(subscribeOpen, readOpen, () => false);
  function toggle(next: boolean) {
    try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* fine */ }
    openListeners.forEach((l) => l());
  }

  // Cheap count poll while closed; full feed while open.
  const { data: counts } = useApi<ChatResp>(open ? null : "/api/chat?count=1", 8000);
  const { data: feed, refresh } = useApi<ChatResp>(open ? "/api/chat" : null, 3000);
  const { data: membersResp } = useApi<{ members: Member[] }>(open ? "/api/members" : null);
  const members = useMemo(() => membersResp?.members ?? [], [membersResp]);

  const unread = (open ? 0 : counts?.unread ?? 0);
  const mentioned = (open ? 0 : counts?.mentioned ?? 0);

  // Opening the dock marks everything read.
  const openedAt = useRef(0);
  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    fetch("/api/chat/read", { method: "POST" }).catch(() => {});
  }, [open]);
  const lastCount = useRef(0);
  useEffect(() => {
    const n = feed?.messages.length ?? 0;
    if (open && n > lastCount.current && lastCount.current !== 0) {
      fetch("/api/chat/read", { method: "POST" }).catch(() => {});
    }
    lastCount.current = n;
  }, [feed, open]);

  // The offsets belong ON the badge. They used to live on a zero-width
  // wrapper span, so the badge started at the FAB's right edge and grew
  // outward — on a phone the FAB is 14px from the edge, so a two-digit or
  // "99+" count was cut off by the screen.
  const badge = unread > 0 && (
    <span className={`absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-semibold ring-2 ring-panel ${
      mentioned > 0 ? "bg-lift text-white" : "bg-panel3 text-dim"
    }`}>
      {unread > 99 ? "99+" : unread}
    </span>
  );

  return (
    <div className="flex h-full shrink-0">
      {open && (
        <ChatPanel
          feed={feed} members={members} refresh={refresh} onClose={() => toggle(false)}
        />
      )}
      {!open && (
        <>
          <button
            onClick={() => toggle(true)}
            title="Team chat"
            className="chat-fab fixed right-5 z-40 grid h-[52px] w-[52px] place-items-center rounded-full bg-panel text-dim shadow-[var(--shadow-pop)] transition-transform hover:scale-105 max-[860px]:right-3.5"
          >
            <ChatGlyph />
            {badge}
          </button>
        </>
      )}
    </div>
  );
}

function ChatGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" />
    </svg>
  );
}

/* ── the open panel ─────────────────────────────────────────────────── */

function ChatPanel({ feed, members, refresh, onClose }: {
  feed: ChatResp | null; members: Member[]; refresh: () => void; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const mentionIds = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  // @mention autocomplete
  const [menu, setMenu] = useState<{ q: string; at: number } | null>(null);
  const [sel, setSel] = useState(0);
  // Highlight a row only once arrow keys are in play — a phantom keyboard
  // cursor on touch just spotlights a random row.
  const [kbNav, setKbNav] = useState(false);
  const matches = useMemo(() => {
    if (!menu) return [];
    const q = menu.q.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 5);
  }, [menu, members]);

  const msgs = feed?.messages ?? [];
  const me = feed?.me;

  // Stick to the bottom unless the reader has scrolled up.
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  function onScroll() {
    const el = listRef.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function onType(v: string) {
    setText(v);
    const el = taRef.current;
    const caret = el?.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    const m = upto.match(/@([\w ]{0,30})$/);
    if (m && members.length) {
      setMenu({ q: m[1], at: caret - m[1].length - 1 });
      setSel(0);
      // Desktop keeps its instant first-row highlight (Enter picks it); touch
      // stays unhighlighted until a hardware arrow key proves a keyboard.
      setKbNav(!matchMedia("(hover: none) and (pointer: coarse)").matches);
    }
    else setMenu(null);
  }

  function pick(member: Member) {
    if (!menu) return;
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, menu.at)}@${member.name} ${text.slice(caret)}`;
    setText(next);
    mentionIds.current.add(member.id);
    setMenu(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = menu.at + member.name.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  }

  async function send(uploadId?: string) {
    const body = text.trim();
    if (!body && !uploadId) return;
    setSending(true); setErr(null);
    try {
      // Catch names typed by hand as well as picked from the menu.
      const ids = new Set(mentionIds.current);
      for (const m of members) if (body.includes(`@${m.name}`)) ids.add(m.id);
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, uploadId, mentions: [...ids] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not send");
      setText(""); mentionIds.current.clear();
      nearBottom.current = true;
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setSending(false); }
  }

  async function attach(file: File) {
    setErr(null); setUploadName(file.name); setUploadPct(0);
    try {
      const up = await uploadFile(file, "chat", setUploadPct);
      await send(up.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploadPct(null); setUploadName(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function renderText(m: Msg) {
    // Highlight @Name for every known member; your own name pops in red.
    let parts: (string | React.ReactNode)[] = [m.text];
    for (const mem of members) {
      const token = `@${mem.name}`;
      parts = parts.flatMap((p) => {
        if (typeof p !== "string" || !p.includes(token)) return [p];
        const bits = p.split(token);
        const out: (string | React.ReactNode)[] = [];
        bits.forEach((b, i) => {
          out.push(b);
          if (i < bits.length - 1) out.push(
            <span key={`${m.id}-${mem.id}-${i}`}
              className={mem.id === me ? "rounded-[5px] bg-blue/15 px-0.5 font-medium text-blue" : "text-blue"}>
              {token}
            </span>
          );
        });
        return out;
      });
    }
    return parts;
  }

  return (
    <>
      {/* Tap-outside-to-close scrim while the panel overlays the page.
          z-40 ties the island; painting later in the DOM wins the tie. */}
      <div className="fixed inset-0 z-40 bg-scrim backdrop-blur-[2px]" onClick={onClose} />
      <aside
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) attach(e.dataTransfer.files[0]); }}
      className={`chat-panel fixed bottom-5 right-5 top-[calc(var(--topbar)+12px)] z-40 flex w-[360px] flex-col overflow-hidden rounded-[20px] bg-panel shadow-[var(--shadow-pop)] ${drag ? "!bg-blue/5" : ""} max-[860px]:inset-x-3 max-[860px]:bottom-3 max-[860px]:w-auto`}
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-4">
        <h2 className="text-[16px] font-semibold tracking-[-0.015em]">Team chat</h2>
        <span className="text-[13px] text-mute">#general</span>
        <button onClick={onClose} title="Collapse"
          className="ml-auto grid h-8 w-8 place-items-center rounded-full text-mute transition-colors hover:bg-chip hover:text-bone">
          <IconClose />
        </button>
      </header>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {msgs.length === 0 && (
          <p className="py-10 text-center text-[14px] text-mute">Nothing yet — say hello.</p>
        )}
        {msgs.map((m, i) => {
          const day = new Date(m.createdAt).toDateString();
          const divider = i === 0 || day !== new Date(msgs[i - 1].createdAt).toDateString();
          return (
            <div key={m.id}>
              {divider && (
                <div className="my-2 flex items-center gap-2">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-[12px] text-mute">
                    {new Date(m.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <div className="group mb-2.5">
                <div className="flex items-baseline gap-2">
                  <span className={`text-[14px] font-semibold ${m.userId === me ? "text-blue" : "text-bone"}`}>
                    {m.author}
                  </span>
                  <span className="text-[12px] text-mute">{timeAgo(m.createdAt)}</span>
                </div>
                {m.text && (
                  <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-bone">
                    {renderText(m)}
                  </p>
                )}
                {m.attachment && <AttachmentTile a={m.attachment} />}
              </div>
            </div>
          );
        })}
      </div>

      {(err || uploadPct != null) && (
        <div className="shrink-0 border-t border-line px-2.5 py-1.5">
          {uploadPct != null && (
            <div>
              <p className="mb-1 flex justify-between font-mono text-[9px] text-dim">
                <span className="min-w-0 truncate">{uploadName}</span><span>{uploadPct}%</span>
              </p>
              <div className="h-[3px] w-full rounded-full bg-panel2">
                <div className="h-full rounded-full bg-blue transition-[width]" style={{ width: `${uploadPct}%` }} />
              </div>
            </div>
          )}
          {err && <p className="text-[13px] text-lift">{err}</p>}
        </div>
      )}

      <div className="relative shrink-0 border-t border-hair p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        {menu && matches.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-[14px] bg-panel p-1 shadow-[var(--shadow-pop)]">
            {matches.map((mm, i) => (
              <button key={mm.id}
                onMouseDown={(e) => { e.preventDefault(); pick(mm); }}
                className={`menu-item !rounded-none ${kbNav && i === sel ? "bg-chip font-medium text-blue" : "text-dim"}`}>
                @{mm.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <button onClick={() => fileRef.current?.click()} disabled={uploadPct != null}
            title="Attach a file (up to 2 GB, byte-identical)"
            className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-panel2 text-dim transition-colors hover:bg-chip2 disabled:opacity-40">
            <IconPlus />
          </button>
          <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])} />
          <textarea
            ref={taRef} value={text} rows={1}
            autoCapitalize="sentences"
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (menu && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setKbNav(true); setSel((s) => (s + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setKbNav(true); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
                if ((e.key === "Enter" || e.key === "Tab") &&
                    (kbNav || !matchMedia("(hover: none) and (pointer: coarse)").matches)) {
                  e.preventDefault(); pick(matches[sel]); return;
                }
                if (e.key === "Escape") { setMenu(null); return; }
              }
              // Touch keyboards have no Shift+Enter — there, Return makes a
              // newline and the Send button sends.
              if (e.key === "Enter" && !e.shiftKey &&
                  !matchMedia("(hover: none) and (pointer: coarse)").matches) {
                e.preventDefault(); send();
              }
            }}
            placeholder="Message the team — @ to mention"
            className="autosize max-h-[120px] min-h-[38px] w-full resize-none rounded-[19px] bg-panel2 px-3.5 py-2 text-[15px] leading-relaxed text-bone placeholder:text-mute focus:bg-panel3 focus:outline-none"
          />
          <button onClick={() => send()} disabled={sending || (!text.trim())}
            className="btn-render h-[38px] shrink-0 px-4 text-[14px]">
            Send
          </button>
        </div>
      </div>
    </aside>
    </>
  );
}

function AttachmentTile({ a }: { a: Attachment }) {
  if (a.kind === "image") {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="mt-1 block w-fit max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={a.url} alt={a.name} title={`${a.name} · ${fmtBytes(a.bytes)}`}
          className="max-h-[160px] max-w-full rounded-[8px] border border-line object-contain" />
      </a>
    );
  }
  if (a.kind === "video") {
    return (
      <video src={`${a.url}#t=0.1`} controls preload="metadata" playsInline
        className="mt-1.5 max-h-[200px] w-full rounded-[12px] bg-black" />
    );
  }
  return (
    <a href={a.url} download={a.name}
      title={`sha256 ${a.sha256.slice(0, 16)}… — stored byte-identical`}
      className="mt-1.5 flex w-fit max-w-full items-center gap-2 rounded-[12px] bg-panel2 px-3 py-2 transition-colors hover:bg-chip2">
      <span className="text-[14px] text-blue">↓</span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] text-bone">{a.name}</span>
        <span className="text-[12px] text-mute">{fmtBytes(a.bytes)} · original bytes</span>
      </span>
    </a>
  );
}
