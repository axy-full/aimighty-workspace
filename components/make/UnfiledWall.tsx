"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { shortLabel } from "@/lib/models";
import { timeAgo } from "@/lib/format";
import type { Generation } from "@/lib/jobs";
import type { ProductionRow } from "@/lib/productions";
import type { Shot } from "@/lib/shots";
import { Mono, Waveform } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { contextItems, ContextMenuHost, useCardPress } from "@/components/ui/ContextMenu";
import { setClip, useClipboard } from "@/lib/clipboard";
import { scheduleDelete, cancelDelete } from "@/lib/undoDelete";
import { useDragSource } from "@/lib/useDnd";
import { appPrompt } from "@/components/dialog";
import { useToast } from "@/components/ui/Toast";
import Loader, { LOADER_SIZES, PageLoader } from "@/components/atomik/Loader";
import LazyMedia from "@/components/LazyMedia";

/**
 * The unfiled wall (design/particl-v2/README.md §10; board 8a), and the
 * Library's Unfiled lens (§11): every take with no project, grouped by
 * day. A group: its day at 600 14 with `5 takes · 71 cr` at 400 12.5 and a
 * .07 rule; four columns 12 apart. A card: `--card`, .08, radius 12; the
 * 16:9 well with `VIDEO · 5S · 1080P` in a scrim chip at 8/8 and the cost
 * in another at the bottom right (audio draws its bars across the well);
 * the prompt at 400 13.5/1.35 clamped to two lines; `MODEL · BY · WHEN` in
 * mono; `File to shot` (34px, .16, radius 8) and `Again`.
 *
 * `File to shot` gives the take a shot and a version — the one thing an
 * unfiled take is missing (§1). `Again` renders it again, at the same
 * settings, and says what it costs on the toast before anything runs.
 *
 * CR1 §10: right-click (long-press on a phone) opens the one context menu
 * — Cut · Copy · Paste · Duplicate (= Again) · Rename · Move to ▸ (file
 * to a shot) · Share ▸ · Download · Open in Rig · Delete with Undo. A cut
 * or copied take pastes into the composer's well or onto a shot. CR1 §11:
 * a card drags, with a mouse or a held finger, onto the composer's well.
 *
 * Below 768 (design/particl-v2-mobile, board M4, `phone`): the day in mono,
 * two columns 8 apart, the card at radius 10 with its chips at 7/7 (the
 * cost top-right), the prompt at 400 12.5/1.35, `model · by · when` in
 * mono, and the split footer — `File to shot` / `Again` at 40px.
 */
type Kind = "video" | "image" | "audio" | "all";
type Filing = { id: string; x: number; y: number; project: { id: string; name: string } | null };

export default function UnfiledWall({ kind, search = "", onTotals, columns = "grid-cols-4", phone = false }: { kind: Kind; search?: string; onTotals?: (t: { takes: number; spent: string }) => void; columns?: string; phone?: boolean }) {
  const { signedIn } = useSession();
  const money = useMoney();
  const toast = useToast();
  const q = search.trim() ? `&q=${encodeURIComponent(search.trim())}` : "";
  const url = signedIn ? `/api/jobs?unfiled=1&limit=200&sync=0${kind === "all" ? "" : `&kind=${kind}`}${q}` : null;
  const { data, refresh, loading } = useApi<{ generations: Generation[] }>(url, 10_000);
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const gens = useMemo(() => data?.generations ?? [], [data]);
  const [filing, setFiling] = useState<Filing | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; sub: "move" | "share" | null } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const clip = useClipboard();
  const router = useRouter();
  const { data: shotsData } = useApi<{ shots: Shot[] }>(filing?.project ? `/api/shots?projectId=${encodeURIComponent(filing.project.id)}` : null, 0);
  const [busy, setBusy] = useState<string | null>(null);

  const days = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const label = (ts: number) => {
      const d = new Date(ts); d.setHours(0, 0, 0, 0);
      const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
      return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    };
    const groups = new Map<string, Generation[]>();
    for (const g of gens) { const k = label(g.createdAt); groups.set(k, [...(groups.get(k) ?? []), g]); }
    return [...groups.entries()].map(([day, items]) => ({ day, items, meta: `${items.length} ${items.length === 1 ? "take" : "takes"} · ${money.sum(items)}` }));
  }, [gens, money]);
  const takes = gens.length, spent = money.sum(gens);
  useEffect(() => { onTotals?.({ takes, spent }); }, [takes, spent, onTotals]);

  const file = async (g: Generation, shot: Shot) => {
    setBusy(g.id); setFiling(null);
    const r = await fetch(`/api/jobs/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shotId: shot.id }) });
    setBusy(null);
    if (!r.ok) { toast("That take wasn't filed."); return; }
    toast(`Filed as ${shot.code} · its next version`); refresh();
  };
  const again = async (g: Generation) => {
    if (busy) return;
    const p = g.params as Record<string, unknown>;
    setBusy(g.id);
    try {
      const body = g.kind === "audio"
        ? { task: p.task ?? "speech", text: g.prompt, projectId: null, shotId: null, title: g.title ?? null, voiceId: p.voiceId, voiceName: p.voiceName, modelId: p.modelId, durationSeconds: p.durationSeconds, lengthMs: p.lengthMs, instrumental: p.instrumental }
        : { prompt: (p.rawPrompt as string | undefined) || g.prompt, model: g.model, ratio: p.ratio, resolution: p.resolution, duration: p.duration, generateAudio: Boolean(p.generateAudio), fps60: Boolean(p.fps60),
            projectId: null, shotId: null, task: (p.task as string | undefined) ?? "generate", sourceGenId: (p.sourceGenId as string | undefined) ?? null, references: Array.isArray(p.references) ? p.references : [], shotSpec: p.shotSpec ?? undefined };
      const r = await fetch(g.kind === "audio" ? "/api/audio" : "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Not started.");
      toast(`Again · ${money.sum([g])} · lands on the wall unfiled`); setTimeout(refresh, 600);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  };

  const chip = (g: Generation) => {
    const p = g.params as Record<string, unknown>;
    if (g.kind === "audio") { const s = Number(p.durationSeconds ?? (Number(p.lengthMs ?? 0) / 1000)) || null; return `Audio${s ? ` · ${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : ""}`; }
    if (g.kind === "image") return `Still${p.resolution ? ` · ${String(p.resolution).toUpperCase()}` : ""}`;
    return `Video${p.duration ? ` · ${p.duration}s` : ""}${p.resolution ? ` · ${String(p.resolution).toUpperCase()}` : ""}`;
  };
  const running = (g: Generation) => g.status === "running" || g.status === "queued" || g.status === "held";
  /* ── CR1 §10: the menu's verbs on a take ─────────────────────────────── */
  const label = (g: Generation) => `${chip(g)} · ${((g.params as { rawPrompt?: string }).rawPrompt || g.title || g.prompt).slice(0, 24)}`;
  const clipOf = (g: Generation, mode: "cut" | "copy") => { setClip({ kind: "media", mode, id: g.id, label: label(g), payload: { kind: g.kind, url: g.storedUrl ?? g.sourceUrl ?? null } }); setMenu(null); toast(mode === "cut" ? `${label(g)} cut · paste it on a shot to file it there` : `${label(g)} copied · paste it into the composer's well or on a shot`); };
  const rename = async (g: Generation) => { setMenu(null); const v = await appPrompt("Rename the take", g.title ?? "", "A name for the wall"); if (v == null) return; const r = await fetch(`/api/jobs/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: v.trim() }) }); if (!r.ok) { toast("That didn't stick."); return; } refresh(); toast(v.trim() ? `Renamed · ${v.trim()}` : "Name cleared"); };
  const shareLink = (g: Generation) => { setMenu(null); navigator.clipboard?.writeText(`${location.origin}/api/media/${encodeURIComponent(g.id)}`).then(() => toast("Link copied · it opens for anyone signed in to this workspace")); };
  const addToReview = async (g: Generation) => {
    setMenu(null);
    if (!g.projectId) { toast("File it to a shot first — a review link belongs to a project."); return; }
    const r = await fetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: g.projectId }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "No review link made."); return; }
    navigator.clipboard?.writeText(j.url).then(() => toast("Review link copied"));
  };
  const download = (g: Generation) => { setMenu(null); window.open(`/api/media/${encodeURIComponent(g.id)}?download=1`, "_blank", "noopener"); };
  const remove = (g: Generation) => {
    setMenu(null);
    setHidden((h) => new Set(h).add(g.id));
    scheduleDelete(g.id, async () => { await fetch(`/api/jobs/${g.id}`, { method: "DELETE" }); refresh(); });
    toast(`${label(g)} deleted`, () => { cancelDelete(g.id); setHidden((h) => { const n = new Set(h); n.delete(g.id); return n; }); });
  };
  const menuGen = menu ? gens.find((g) => g.id === menu.id) ?? null : null;
  const toggleSub = (which: "move" | "share") => setMenu((m) => m && { ...m, sub: m.sub === which ? null : which });
  const menuFor = (g: Generation): MenuItem[] => contextItems({
    cut: () => clipOf(g, "cut"), copy: () => clipOf(g, "copy"), paste: null,
    duplicate: running(g) ? undefined : () => { setMenu(null); again(g); },
    rename: () => rename(g),
    moveTo: { open: menu?.sub === "move", onToggle: () => toggleSub("move"), items: (prods?.productions ?? []).flatMap((pr) => pr.projects.map((j) => ({ label: pr.projects.length > 1 ? `${pr.name} › ${j.name}` : pr.name, note: `${j.shots} shots`, onSelect: () => { setMenu(null); setFiling({ id: g.id, x: menu?.x ?? 0, y: menu?.y ?? 0, project: { id: j.id, name: j.name } }); } }))) },
    share: { open: menu?.sub === "share", onToggle: () => toggleSub("share"), copyLink: () => shareLink(g), addToReview: g.projectId ? () => addToReview(g) : undefined },
    download: g.storedUrl || g.sourceUrl ? () => download(g) : undefined,
    openInRig: g.projectId ? () => { setMenu(null); router.push(`/rig/canvas/new?project=${encodeURIComponent(g.projectId!)}`); } : undefined,
    remove: () => remove(g),
    note: clip?.kind === "media" ? `${clip.label} is on the clipboard · paste it on a shot or in the composer` : undefined,
  });
  const menuItems: MenuItem[] = !filing ? [] : !filing.project
    ? (prods?.productions ?? []).flatMap((pr) => pr.projects.map((j): MenuItem => ({ kind: "item", label: pr.projects.length > 1 ? `${pr.name} › ${j.name}` : pr.name, keys: `${j.shots} SHOTS`, onSelect: () => setFiling((f) => f && { ...f, project: { id: j.id, name: j.name } }) })))
    : (shotsData?.shots ?? []).map((s): MenuItem => ({ kind: "item", label: `${s.code} · ${s.description || s.title || "shot"}`.slice(0, 44), onSelect: () => { const g = gens.find((x) => x.id === filing.id); if (g) file(g, s); } }));

  if (!signedIn) return <span className="max-w-[760px] text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>Sign in and everything you make lands here, unfiled, until you file it to a shot.</span>;
  if (!data) return loading || !url ? <PageLoader what="Opening · the wall" /> : null;

  return (
    <>
      <ContextMenuHost title={menuGen ? label(menuGen) : "Take"} menu={menuGen ? menu : null} items={menuGen ? menuFor(menuGen) : []} onClose={() => setMenu(null)} />
      {days.map((d) => (
        <div key={d.day} className={`flex flex-col ${phone ? "gap-[8px]" : "gap-[10px]"}`}>
          {phone ? <Mono>{d.day} · {d.meta}</Mono> : (
            <div className="flex items-baseline gap-[10px]"><span className="text-[14px] font-semibold leading-none text-ink">{d.day}</span><span className="text-[12.5px] leading-none text-ink-body">{d.meta}</span><span className="h-px flex-1 self-center bg-[rgba(245,246,248,.07)]" /></div>
          )}
          <div className={phone ? "grid grid-cols-2 gap-[8px]" : `grid gap-[12px] ${columns}`} data-wall="">
            {d.items.filter((g) => !hidden.has(g.id)).map((g) => {
              const u = g.storedUrl ?? g.sourceUrl;
              const open = (e: { currentTarget: EventTarget }) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFiling({ id: g.id, x: r.left, y: r.bottom + 6, project: null }); };
              const onMenu = (x: number, y: number) => setMenu({ x, y, id: g.id, sub: null });
              if (phone) return (
                <TakeCard key={g.id} g={g} label={label(g)} onMenu={onMenu} className="flex flex-col overflow-hidden rounded-tile border border-border bg-card" ariaLabel={`${chip(g)} take`}>
                  <span className="relative block aspect-video border-b border-hairline ui-placeholder">
                    {g.kind === "audio" ? <Waveform className="absolute left-[10px] right-[10px] top-1/2 h-[20px] -translate-y-1/2" /> : u && !running(g) ? <LazyMedia url={u} kind={g.kind === "image" ? "image" : "video"} className="absolute inset-0 h-full w-full object-cover" /> : null}
                    {running(g) && <span className="absolute inset-0 flex items-center justify-center"><Loader size={LOADER_SIZES.well} /></span>}
                    <span className="ui-chip-scrim absolute left-[7px] top-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{chip(g)}</span></span>
                    <span className="ui-chip-scrim absolute right-[7px] top-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono tracking-normal text-ink">{money.sum([g])}</span></span>
                  </span>
                  <span className="flex flex-1 flex-col gap-[6px] px-[10px] pb-[10px] pt-[9px]">
                    <span className="line-clamp-2 text-[12.5px] leading-[1.35] text-ink">{(g.params as { rawPrompt?: string }).rawPrompt || g.title || g.prompt}</span>
                    <Mono cost className="truncate">{shortLabel(g.model)} · {g.authorName ?? "—"} · {timeAgo(g.createdAt)}</Mono>
                  </span>
                  <span className="grid grid-cols-[1fr_1fr] border-t border-border">
                    <button type="button" disabled={busy === g.id || running(g)} onClick={open} className="flex h-[40px] items-center justify-center border-r border-border text-[12.5px] font-medium leading-none text-ink disabled:opacity-60">File to shot</button>
                    <button type="button" disabled={busy === g.id} onClick={() => again(g)} className="flex h-[40px] items-center justify-center text-[12.5px] font-medium leading-none text-ink-body disabled:opacity-60">Again</button>
                  </span>
                </TakeCard>
              );
              return (
                <TakeCard key={g.id} g={g} label={label(g)} onMenu={onMenu} className="flex flex-col overflow-hidden rounded-card border border-border bg-card" ariaLabel={`${chip(g)} take`}>
                  <span className="relative block aspect-video border-b border-hairline ui-placeholder">
                    {g.kind === "audio" ? <Waveform className="absolute left-[12px] right-[12px] top-1/2 h-[26px] -translate-y-1/2" /> : u && !running(g) ? <LazyMedia url={u} kind={g.kind === "image" ? "image" : "video"} className="absolute inset-0 h-full w-full object-cover" hoverPlay /> : null}
                    {running(g) && <span className="absolute inset-0 flex items-center justify-center"><Loader size={LOADER_SIZES.well} /></span>}
                    <span className="ui-chip-scrim absolute left-[8px] top-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{chip(g)}</span></span>
                    <span className="ui-chip-scrim absolute bottom-[8px] right-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono ui-mono-cost text-ink">{money.sum([g])}</span></span>
                  </span>
                  <span className="flex flex-col gap-[8px] px-[12px] pb-[12px] pt-[10px]">
                    <span className="line-clamp-2 min-h-[36px] text-[13.5px] leading-[1.35] text-ink">{(g.params as { rawPrompt?: string }).rawPrompt || g.title || g.prompt}</span>
                    <span className="flex items-center justify-between gap-[8px]"><Mono cost className="truncate">{shortLabel(g.model)} · {g.authorName ?? "—"} · {timeAgo(g.createdAt)}</Mono></span>
                    <span className="flex gap-[6px]">
                      <button type="button" disabled={busy === g.id || running(g)} onClick={open}
                        className="tap44 flex h-[34px] flex-1 items-center justify-center rounded-ctl border border-[rgba(245,246,248,.16)] text-[12.5px] font-medium leading-none text-ink disabled:opacity-60">File to shot</button>
                      <button type="button" disabled={busy === g.id} onClick={() => again(g)} className="tap44 flex h-[34px] items-center justify-center rounded-ctl border border-[rgba(245,246,248,.16)] px-[10px] text-[12.5px] font-medium leading-none text-ink-body disabled:opacity-60">Again</button>
                    </span>
                  </span>
                </TakeCard>
              );
            })}
          </div>
        </div>
      ))}
      <span className="max-w-[760px] text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>
        {gens.length ? "Unfiled takes have no shot ID, no version and no place in a production until you file them. Nothing here is lost — the Library keeps it." : "Nothing unfiled yet. Whatever you render here lands on this wall with no shot ID and no version until you file it."} New here? Open a <Link href="/productions" className="text-ink">production</Link> to see a finished one.
      </span>
      {filing && <Menu x={filing.x} y={filing.y} title={filing.project ? `File to · ${filing.project.name}` : "File to · which project?"} items={menuItems.length ? menuItems : [{ kind: "note", text: filing.project ? "No shots in this project yet." : "No productions yet." }]} onClose={() => setFiling(null)} />}
    </>
  );
}

/** One take's card: the article with its right-click, its long-press (the same menu as a sheet) and its drag handle for the composer's well. */
function TakeCard({ g, label, onMenu, className, ariaLabel, children }: { g: Generation; label: string; onMenu: (x: number, y: number) => void; className: string; ariaLabel: string; children: ReactNode }) {
  const press = useCardPress(g, (_t, x, y) => onMenu(x, y));
  const drag = useDragSource(g.storedUrl || g.sourceUrl ? { kind: "media", id: g.id, label, url: g.storedUrl ?? g.sourceUrl ?? null, data: { kind: g.kind } } : null);
  return (
    <article className={className} aria-label={ariaLabel} data-take={g.id}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
      onPointerDown={(e) => { press.onPointerDown(e); drag.onPointerDown(e); }}
      onPointerMove={(e) => { press.onPointerMove(e); drag.onPointerMove(e); }}
      onPointerUp={(e) => { press.onPointerUp(e); drag.onPointerUp(e); }}
      onPointerCancel={(e) => { press.onPointerCancel(); drag.onPointerCancel(e); }}
      onClickCapture={drag.onClickCapture} style={{ touchAction: "pan-y" }}>
      {children}
    </article>
  );
}
