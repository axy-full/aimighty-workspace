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

  return (
    <div className="flex h-full shrink-0">
      {open && (
        <ChatPanel
          feed={feed} members={members} refresh={refresh} onClose={() => toggle(false)}
        />
      )}
      {!open && (
        <button
          onClick={() => toggle(true)}
          title="Team chat"
          className="relative flex h-full w-[30px] flex-col items-center gap-2 border-l border-line bg-chrome pt-3 text-mute transition-colors hover:text-lift"
        >
          <ChatGlyph />
          <span className="lbl rotate-180 [writing-mode:vertical-rl]">CHAT</span>
          {unread > 0 && (
            <span className={`absolute top-1 grid h-[16px] min-w-[16px] place-items-center rounded-full px-0.5 font-mono text-[9px] text-white ${mentioned > 0 ? "bg-red" : "bg-panel3 text-dim"}`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
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
    if (m && members.length) { setMenu({ q: m[1], at: caret - m[1].length - 1 }); setSel(0); }
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
              className={mem.id === me ? "rounded-[2px] bg-red/25 px-0.5 text-lift" : "text-run"}>
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
    <aside
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) attach(e.dataTransfer.files[0]); }}
      className={`flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-chrome ${drag ? "bg-lift/8" : ""} max-[1100px]:fixed max-[1100px]:bottom-[var(--switcher)] max-[1100px]:right-0 max-[1100px]:top-[var(--titlebar)] max-[1100px]:z-40 max-[1100px]:h-auto max-[1100px]:shadow-[-12px_0_32px_rgba(0,0,0,.5)]`}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-2.5">
        <h2 className="ptitle text-[10.5px] tracking-[.1em] text-dim">TEAM CHAT</h2>
        <span className="font-mono text-[9px] text-mute">#general</span>
        <button onClick={onClose} title="Collapse"
          className="ml-auto grid h-[20px] w-[20px] place-items-center rounded-[2px] text-mute hover:text-lift">
          <IconClose />
        </button>
      </header>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {msgs.length === 0 && (
          <p className="py-10 text-center font-mono text-[10px] tracking-[.14em] text-mute">
            NOTHING YET — SAY HELLO
          </p>
        )}
        {msgs.map((m, i) => {
          const day = new Date(m.createdAt).toDateString();
          const divider = i === 0 || day !== new Date(msgs[i - 1].createdAt).toDateString();
          return (
            <div key={m.id}>
              {divider && (
                <div className="my-2 flex items-center gap-2">
                  <span className="h-px flex-1 bg-line" />
                  <span className="font-mono text-[9px] tracking-wider text-mute">
                    {new Date(m.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <div className="group mb-2.5">
                <div className="flex items-baseline gap-2">
                  <span className={`text-[12px] font-semibold ${m.userId === me ? "text-lift" : "text-bone"}`}>
                    {m.author}
                  </span>
                  <span className="font-mono text-[9px] text-mute">{timeAgo(m.createdAt)}</span>
                </div>
                {m.text && (
                  <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-bone/90">
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
              <div className="h-[3px] w-full bg-panel3">
                <div className="h-full bg-lift transition-[width]" style={{ width: `${uploadPct}%` }} />
              </div>
            </div>
          )}
          {err && <p className="font-mono text-[10px] text-lift">{err}</p>}
        </div>
      )}

      <div className="relative shrink-0 border-t border-line bg-panel p-2">
        {menu && matches.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-[3px] border border-line bg-panel2 shadow-xl">
            {matches.map((mm, i) => (
              <button key={mm.id}
                onMouseDown={(e) => { e.preventDefault(); pick(mm); }}
                className={`block w-full px-2.5 py-1.5 text-left text-[12px] ${i === sel ? "bg-panel3 text-lift" : "text-dim"}`}>
                @{mm.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <button onClick={() => fileRef.current?.click()} disabled={uploadPct != null}
            title="Attach a file (up to 2 GB, byte-identical)"
            className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[3px] border border-line text-mute hover:border-lift hover:text-lift disabled:opacity-40">
            <IconPlus />
          </button>
          <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])} />
          <textarea
            ref={taRef} value={text} rows={1}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (menu && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[sel]); return; }
                if (e.key === "Escape") { setMenu(null); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Message the team — @ to mention"
            className="max-h-[96px] min-h-[30px] w-full resize-none rounded-[3px] border border-line bg-desk px-2.5 py-1.5 text-[12.5px] leading-relaxed text-bone placeholder:text-mute/60 focus:outline-none"
          />
          <button onClick={() => send()} disabled={sending || (!text.trim())}
            className="ptitle h-[30px] shrink-0 rounded-[3px] bg-red px-2.5 text-[10px] tracking-[.08em] text-white hover:bg-lift disabled:bg-panel3 disabled:text-mute">
            SEND
          </button>
        </div>
      </div>
    </aside>
  );
}

function AttachmentTile({ a }: { a: Attachment }) {
  if (a.kind === "image") {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="mt-1 block w-fit max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={a.url} alt={a.name} title={`${a.name} · ${fmtBytes(a.bytes)}`}
          className="max-h-[160px] max-w-full rounded-[3px] border border-line object-contain" />
      </a>
    );
  }
  if (a.kind === "video") {
    return (
      <video src={`${a.url}#t=0.1`} controls preload="metadata"
        className="mt-1 max-h-[180px] w-full rounded-[3px] border border-line bg-black" />
    );
  }
  return (
    <a href={a.url} download={a.name}
      title={`sha256 ${a.sha256.slice(0, 16)}… — stored byte-identical`}
      className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-[3px] border border-line bg-panel2 px-2.5 py-1.5 hover:border-lift">
      <span className="font-mono text-[13px] text-lift">▼</span>
      <span className="min-w-0">
        <span className="block truncate text-[11.5px] text-bone">{a.name}</span>
        <span className="font-mono text-[9px] text-mute">{fmtBytes(a.bytes)} · original bytes</span>
      </span>
    </a>
  );
}
