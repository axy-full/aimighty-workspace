"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { estimateVideo } from "@/lib/rateTable";
import { estimateTokens, costUsd } from "@/lib/models";
import type { Shot } from "@/lib/shots";
import type { ProductionRow } from "@/lib/productions";
import { Segmented, Button, Chip, Mono, MediaCard, Placeholder } from "@/components/ui";
import type { DotState } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { ToastHost, useToast } from "@/components/ui/Toast";
import { PageLoader } from "@/components/atomik/Loader";
import LazyMedia from "@/components/LazyMedia";
import ProductionHeader from "@/components/production/ProductionHeader";
import { useAtomikRail } from "@/lib/atomikRail";

/**
 * The Shots grid (design/particl-v2/README.md §7; the grid of board 10a,
 * the interactions of 4b), value for value.
 *
 * Toolbar 52px, `0 24px`, 14 apart: `Grid | Filmstrip`, the mono stats,
 * and — while a card is being dragged — `MOVE TO` and a pill per other
 * production (36px, `0 12px`; dashed .35 while dragging, ink with a .12
 * fill under the card); from the right `+ Shot` and the one filled primary,
 * `Render SH08–09 · 38 CR`, priced from the engine before it can be
 * pressed. The grid: five columns 12 apart (four beside the compact rail,
 * three beside the expanded one — §5), each shot a media card: `SH04` and
 * its position, the state, `V2 ↓` in the accent bottom-right on a master,
 * `NO TAKE YET` / `TYPE ONLY` in an empty well; the description clamped to
 * two lines, the cast `@Name` pills, `size · move · lens`; the split footer
 * `PLAN 4S · 19 CR` / `RENDERS 2 TAKES · 38 CR`.
 *
 * Right-click: the 228px menu — Copy ⌘C, Paste after ⌘V (until something
 * is copied), Rename ↵, Open in Rig ⌘R, Move to production ▸ (`TAKES GO
 * TOO`), Delete ⌫, and the footnote. Paste copies planning only: a new id,
 * no takes, 0 cr. Delete offers Undo in the toast, and the row is only
 * really deleted once the toast has gone. Drag a card onto another to
 * reorder (the insertion edge is a 3px ink inset on the target); drop it on
 * a production pill to move it, takes and spend going with it. Double-click
 * the description to rename inline — Enter commits, Esc cancels. Every
 * action narrates in the toast.
 */
type ShotRow = Shot & { takes: number; ok: number; failed: number; spend: number; credits?: number; state: "approved" | "picked" | "rendering" | "draft" | "none"; master: { id: string; version: number | null; url: string | null } | null; poster?: string | null };
type View = "grid" | "filmstrip";
/** A shot with no planned length is quoted as five seconds, everywhere on this page. */
const PLANNED = 5;

export default function ShotsPage() {
  return <ToastHost><Shots /></ToastHost>;
}

function Shots() {
  const { prod, project: projectId } = useParams<{ prod: string; project: string }>();
  const router = useRouter();
  const { signedIn, rates, models } = useSession();
  const money = useMoney();
  const toast = useToast();
  const rail = useAtomikRail();
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 30_000);
  const { data, refresh } = useApi<{ shots: ShotRow[] }>(signedIn ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 15_000);
  const [view, setView] = useState<View>("grid");
  const [order, setOrder] = useState<string[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; sub: boolean } | null>(null);
  const [clip, setClip] = useState<ShotRow | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overProd, setOverProd] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const pendingDelete = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const production = prods?.productions.find((p) => p.id === prod) ?? null;
  const project = production?.projects.find((j) => j.id === projectId) ?? null;
  usePageTitle(project ? `${project.name} · Shots` : "Shots");

  const shots = useMemo(() => {
    const base = (data?.shots ?? []).filter((s) => !hidden.has(s.id));
    if (!order) return base;
    const byId = new Map(base.map((s) => [s.id, s]));
    const ordered = order.map((id) => byId.get(id)).filter((s): s is ShotRow => !!s);
    for (const s of base) if (!order.includes(s.id)) ordered.push(s);
    return ordered;
  }, [data, order, hidden]);

  const model = models?.video ?? "";
  const quote = useCallback((s: ShotRow) => {
    const secs = s.planned ?? PLANNED;
    const est = estimateVideo(rates, model, "1080p", secs, estimateTokens("1080p", "16:9", secs), costUsd);
    return est ?? 0;
  }, [rates, model]);
  const fmt = (n: number) => money.price(n);

  const toRender = shots.filter((s) => s.kind !== "type" && (selected.size ? selected.has(s.id) : s.state === "none"));
  const renderCost = toRender.reduce((a, s) => a + quote(s), 0);
  const renderLabel = toRender.length === 0 ? "Render" : toRender.length === 1 ? `Render ${toRender[0].code}` : `Render ${toRender[0].code}–${toRender[toRender.length - 1].code.replace(/^SH/i, "")}`;

  const stats = { shots: shots.length, approved: shots.filter((s) => s.state === "approved").length, secs: shots.reduce((a, s) => a + (s.planned ?? PLANNED), 0), spent: shots.reduce((a, s) => a + (money.inCredits ? (s.credits ?? 0) : s.spend), 0) };
  const others = useMemo(() => (prods?.productions ?? []).filter((p) => p.id !== prod).flatMap((p) => p.projects.map((j) => ({ production: p, project: j }))), [prods, prod]);

  /* ── the actions, each narrated ─────────────────────────────────────── */
  const patch = async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(`/api/shots/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error ?? `That didn't stick (${r.status}).`); }
    return r.ok;
  };
  const copy = (s: ShotRow) => { setClip(s); setMenu(null); toast(`${s.code} copied · planning only, takes stay`); };
  const pasteAfter = async (after: ShotRow | null) => {
    if (!clip) return;
    setMenu(null);
    const codes = shots.map((s) => s.code);
    const n = Math.max(0, ...codes.map((c) => parseInt(c.replace(/\D/g, ""), 10) || 0)) + 1;
    const code = `SH${String(n).padStart(2, "0")}`;
    const r = await fetch("/api/shots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      projectId, code, title: clip.title, description: clip.description, planned: clip.planned, setup: clip.setup, cast: clip.cast, kind: clip.kind }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "Paste failed."); return; }
    const ids = shots.map((s) => s.id);
    const at = after ? ids.indexOf(after.id) + 1 : ids.length;
    ids.splice(at, 0, String(j.id ?? j.shot?.id));
    await fetch("/api/shots/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, ids }) });
    refresh();
    toast(`${code} pasted after ${after?.code ?? "the end"} · planning copied, no takes, 0 cr`);
  };
  const startRename = (s: ShotRow) => { setMenu(null); setRenaming({ id: s.id, value: s.description || s.title }); };
  const commitRename = async () => {
    if (!renaming) return;
    const s = shots.find((x) => x.id === renaming.id);
    const value = renaming.value.trim();
    setRenaming(null);
    if (!s || !value || value === (s.description || s.title)) return;
    if (await patch(s.id, { description: value })) { refresh(); toast(`${s.code} renamed · masters keep the shot ID`); }
  };
  const remove = (s: ShotRow) => {
    setMenu(null);
    setHidden((h) => new Set(h).add(s.id));
    const t = setTimeout(async () => {
      pendingDelete.current.delete(s.id);
      await fetch(`/api/shots/${s.id}`, { method: "DELETE" });
      refresh();
    }, 6000);
    pendingDelete.current.set(s.id, t);
    toast(`${s.code} deleted · ${s.takes ? `${s.takes} takes kept in Library` : "it had no takes"}`, () => {
      const pending = pendingDelete.current.get(s.id);
      if (pending) { clearTimeout(pending); pendingDelete.current.delete(s.id); }
      setHidden((h) => { const n = new Set(h); n.delete(s.id); return n; });
    });
  };
  useEffect(() => { const map = pendingDelete.current; return () => { for (const t of map.values()) clearTimeout(t); }; }, []);
  const moveTo = async (s: ShotRow, target: { production: ProductionRow; project: { id: string; name: string } }) => {
    setMenu(null); setDragId(null); setOverId(null); setOverProd(null);
    setHidden((h) => new Set(h).add(s.id));
    if (await patch(s.id, { projectId: target.project.id })) {
      refresh();
      toast(`${s.code} moved to ${target.production.name} · ${s.takes ? `${s.takes} takes and ${fmt(money.inCredits ? (s.credits ?? 0) : s.spend)} went with it` : "planning only, nothing spent"}`);
    } else setHidden((h) => { const n = new Set(h); n.delete(s.id); return n; });
  };
  const reorder = async (from: string, to: string) => {
    if (!from || from === to) return;
    const ids = shots.map((s) => s.id);
    const fi = ids.indexOf(from), ti = ids.indexOf(to);
    if (fi < 0 || ti < 0) return;
    ids.splice(fi, 1); ids.splice(ti, 0, from);
    setOrder(ids);
    await fetch("/api/shots/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, ids }) });
    refresh();
    const nth = ti + 1;
    toast(`${shots[fi].code} now plays ${nth}${nth === 1 ? "st" : nth === 2 ? "nd" : nth === 3 ? "rd" : "th"} · the filmstrip follows the grid`);
  };
  const addShot = async () => {
    const n = Math.max(0, ...shots.map((s) => parseInt(s.code.replace(/\D/g, ""), 10) || 0)) + 1;
    const code = `SH${String(n).padStart(2, "0")}`;
    const r = await fetch("/api/shots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, code, title: "", planned: PLANNED }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error ?? "That shot didn't get made."); return; }
    refresh();
    toast(`${code} added · nothing spent until it renders`);
  };
  /* The one filled button: a take for each chosen shot, through the
     ordinary generate route — the same take a hand-made one would be. */
  const render = async () => {
    if (!toRender.length || rendering) return;
    setRendering(true);
    let n = 0;
    try {
      for (const s of toRender) {
        const prompt = [s.description || s.title, Object.values(s.setup ?? {}).filter(Boolean).join(" · ")].filter(Boolean).join(". ");
        const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          prompt, model, projectId, shotId: s.id, ratio: "16:9", resolution: "1080p", duration: s.planned ?? PLANNED }) });
        if (r.ok) n++; else { const j = await r.json().catch(() => ({})); toast(j.error ?? `${s.code} didn't start.`); break; }
      }
    } finally {
      setRendering(false); setSelected(new Set()); refresh();
      if (n) toast(`${n} ${n === 1 ? "take" : "takes"} rendering · ${fmt(renderCost)} quoted`);
    }
  };

  /* ── keys: ⌘C / ⌘V / ↵ / ⌘R on the selection, ⌫ deletes ─────────────── */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (renaming || (e.target as HTMLElement)?.tagName === "INPUT") return;
      const one = selected.size === 1 ? shots.find((s) => selected.has(s.id)) ?? null : null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && one) { e.preventDefault(); copy(one); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v" && clip) { e.preventDefault(); pasteAfter(one); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r" && one) { e.preventDefault(); router.push(`/projects/${projectId}/rig`); }
      else if (e.key === "Enter" && one) { e.preventDefault(); startRename(one); }
      else if ((e.key === "Backspace" || e.key === "Delete") && one) { e.preventDefault(); remove(one); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to see this project.</div>;
  if (!prods || !data) return <PageLoader what={`Opening · ${project?.name ?? "shots"}`} />;
  if (!production || !project) return <div className="p-[24px] text-[13px] text-ink-body">No such project. <Link href="/productions" className="text-ink">← Productions</Link></div>;

  const cols = rail.state === "expanded" ? "grid-cols-3" : rail.state === "compact" ? "grid-cols-4" : "grid-cols-5";
  const menuShot = menu ? shots.find((s) => s.id === menu.id) ?? null : null;
  const menuItems: MenuItem[] = menuShot ? [
    { kind: "item", label: "Copy", keys: "⌘C", onSelect: () => copy(menuShot) },
    { kind: "item", label: "Paste after", keys: "⌘V", disabled: !clip, onSelect: () => pasteAfter(menuShot) },
    { kind: "item", label: "Rename", keys: "↵", onSelect: () => startRename(menuShot) },
    { kind: "item", label: "Open in Rig", keys: "⌘R", onSelect: () => router.push(`/projects/${projectId}/rig`) },
    { kind: "divider" },
    { kind: "sub", label: "Move to production", open: menu!.sub, onToggle: () => setMenu((m) => m && { ...m, sub: !m.sub }),
      items: others.map((t) => ({ label: t.production.projects.length > 1 ? `${t.production.name} › ${t.project.name}` : t.production.name, note: "takes go too", onSelect: () => moveTo(menuShot, t) })) },
    { kind: "divider" },
    { kind: "item", label: "Delete", keys: "⌫", onSelect: () => remove(menuShot) },
    { kind: "note", text: "Takes and masters are never deleted with a shot; they stay in Library." },
  ] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink" onClick={() => { if (!menu) setSelected(new Set()); }}>
      <ProductionHeader production={production} project={project} />
      <div className="flex h-[52px] flex-none items-center gap-[14px] px-[24px] max-md:h-auto max-md:flex-wrap max-md:gap-[10px] max-md:px-[16px] max-md:py-[10px]">
        <Segmented label="View" placement="toolbar" value={view} onChange={setView} options={[{ value: "grid", label: "Grid" }, { value: "filmstrip", label: "Filmstrip" }]} />
        <Mono>{stats.shots} shots · {stats.approved} approved · {stats.secs}s planned · {fmt(stats.spent)} spent</Mono>
        {dragId && others.length > 0 && (
          <span className="flex items-center gap-[8px]">
            <Mono>Move to</Mono>
            {others.map((t) => (
              <span key={t.project.id}
                onDragOver={(e) => { e.preventDefault(); if (overProd !== t.project.id) setOverProd(t.project.id); }}
                onDragLeave={() => { if (overProd === t.project.id) setOverProd(null); }}
                onDrop={(e) => { e.preventDefault(); const s = shots.find((x) => x.id === dragId); if (s) moveTo(s, t); }}
                className={`flex h-[36px] items-center rounded-pill px-[12px] text-[13px] font-medium leading-none ${
                  overProd === t.project.id ? "border border-ink bg-selected" : "border border-dashed border-[rgba(245,246,248,.35)]"}`}>
                {t.production.name}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-[8px]">
          <Button placement="header" onClick={addShot}>+ Shot</Button>
          <Button variant="primary" placement="header" outlined={rail.open} cost={renderCost} disabled={!toRender.length} busy={rendering} busyLabel="Rendering…" onClick={render}>
            {renderLabel}
          </Button>
        </span>
      </div>
      {view === "grid" ? (
        <div className="min-h-0 flex-1 overflow-auto px-[24px] pb-[24px] max-md:px-[16px]">
          <div data-owns-menu className={`grid gap-[12px] ${cols} max-md:grid-cols-2`}>
            {shots.map((s, i) => (
              <ShotCard key={s.id} shot={s} position={i + 1} quote={quote} fmt={fmt} inCredits={money.inCredits}
                selected={selected.has(s.id)} dragging={dragId === s.id} over={overId === s.id && !!dragId && dragId !== s.id}
                renaming={renaming?.id === s.id ? renaming.value : null}
                onRenameChange={(v) => setRenaming((r) => r && { ...r, value: v })} onRenameCommit={commitRename} onRenameCancel={() => setRenaming(null)}
                onSelect={(e) => { e.stopPropagation(); setSelected((sel) => { const n = e.metaKey || e.shiftKey ? new Set(sel) : new Set<string>(); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; }); }}
                onContext={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(new Set([s.id])); setMenu({ x: e.clientX, y: e.clientY, id: s.id, sub: false }); }}
                onDoubleClick={() => startRename(s)}
                onDragStart={(e) => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; setDragId(s.id); setMenu(null); }}
                onDragOver={(e) => { e.preventDefault(); if (overId !== s.id) setOverId(s.id); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, s.id); setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); setOverProd(null); }} />
            ))}
          </div>
          {!shots.length && <span className="block py-[24px] text-[13px] leading-[1.5] text-ink-body">No shots yet. `+ Shot` starts one; Atomik can plan the list for you.</span>}
        </div>
      ) : (
        <Filmstrip shots={shots} fmt={fmt} inCredits={money.inCredits} />
      )}
      {menu && menuShot && <Menu x={menu.x} y={menu.y} title={`${menuShot.code} · shot`} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

const STATE: Record<ShotRow["state"], { dot: DotState; word: string }> = {
  approved: { dot: "approved", word: "approved" }, picked: { dot: "picked", word: "picked" },
  rendering: { dot: "running", word: "rendering" }, draft: { dot: "draft", word: "draft" }, none: { dot: "none", word: "no take" },
};

function ShotCard(p: {
  shot: ShotRow; position: number; quote: (s: ShotRow) => number; fmt: (n: number) => string; inCredits: boolean;
  selected: boolean; dragging: boolean; over: boolean; renaming: string | null;
  onRenameChange: (v: string) => void; onRenameCommit: () => void; onRenameCancel: () => void;
  onSelect: (e: MouseEvent) => void; onContext: (e: MouseEvent) => void; onDoubleClick: () => void;
  onDragStart: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; onDragEnd: () => void;
}) {
  const s = p.shot;
  const type = s.kind === "type";
  const st = type ? { dot: "type" as DotState, word: "type only" } : STATE[s.state];
  const spent = p.inCredits ? (s.credits ?? 0) : s.spend;
  const setupLine = ["size", "move", "lens"].map((k) => s.setup?.[k]).filter(Boolean).join(" · ");
  const well = s.master?.url
    ? <LazyMedia url={s.master.url} kind="video" className="absolute inset-0 h-full w-full object-cover" />
    : s.poster ? <LazyMedia url={s.poster} kind="image" className="absolute inset-0 h-full w-full object-cover" /> : null;
  return (
    <div draggable onDragStart={p.onDragStart} onDragOver={p.onDragOver} onDrop={p.onDrop} onDragEnd={p.onDragEnd}
      onClick={p.onSelect} onContextMenu={p.onContext} onDoubleClick={p.onDoubleClick}
      className={`relative ${p.dragging ? "opacity-[.35]" : ""}`} style={p.over ? { boxShadow: "inset 3px 0 0 var(--ink)" } : undefined}>
      <MediaCard id={`${s.code} · ${String(p.position).padStart(2, "0")}`} state={st.dot} stateLabel={st.word}
        well={well ?? (type || s.state === "none" ? null : <Placeholder />)}
        emptyLabel={s.state === "none" ? (type ? "Type only" : "No take yet") : undefined}
        loading={s.state === "rendering"}
        className={p.selected ? "border-ink" : ""}
        title={p.renaming !== null ? (
          <input autoFocus value={p.renaming} onChange={(e) => p.onRenameChange(e.target.value)} onBlur={p.onRenameCommit}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); p.onRenameCommit(); } else if (e.key === "Escape") { e.preventDefault(); p.onRenameCancel(); } }}
            onClick={(e) => e.stopPropagation()} aria-label="Rename the shot"
            className="h-[36px] w-full rounded-ctl border border-ink bg-ground px-[10px] text-[13.5px] leading-none text-ink outline-0" />
        ) : (s.description || s.title || "Untitled")}
        setup={
          <span className="flex flex-col gap-[6px]">
            {s.cast?.length > 0 && <span className="flex min-h-[24px] flex-wrap gap-[4px]">{s.cast.map((c) => <Chip key={c} variant="composer">{c.startsWith("@") ? c : `@${c}`}</Chip>)}</span>}
            {setupLine && <span className="truncate">{setupLine}</span>}
          </span>
        }
        footer={{ plan: `${s.planned ?? PLANNED}s · ${type ? p.fmt(0) : p.fmt(p.quote(s))}`, renders: s.takes ? `${s.takes} ${s.takes === 1 ? "take" : "takes"} · ${p.fmt(spent)}` : type ? "Never renders" : "Nothing yet", rendersMuted: !s.takes }} />
      {s.master && (
        <span className="ui-chip-scrim absolute bottom-[calc(100%/3)] right-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono ui-mono-cost text-accent">V{s.master.version ?? 1} ↓</span></span>
      )}
    </div>
  );
}

/**
 * Filmstrip (§7): the approved takes play in order; beneath them a strip
 * where each shot's width is its planned seconds — approved with the
 * accent underline, picked filled `--selected`, open dashed — and the
 * sequence list.
 */
function Filmstrip({ shots, fmt, inCredits }: { shots: ShotRow[]; fmt: (n: number) => string; inCredits: boolean }) {
  const approved = shots.filter((s) => s.state === "approved" && s.master?.url);
  const [i, setI] = useState(0);
  const cur = approved[Math.min(i, Math.max(0, approved.length - 1))] ?? null;
  const total = shots.reduce((a, s) => a + (s.planned ?? PLANNED), 0) || 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[24px] pb-[24px] max-md:px-[16px]">
      <div className="relative aspect-video w-full overflow-hidden rounded-card border border-border bg-card">
        {cur?.master?.url ? (
          <video key={cur.id} src={cur.master.url} autoPlay muted playsInline controls className="h-full w-full object-contain"
            onEnded={() => setI((n) => (n + 1 < approved.length ? n + 1 : 0))} />
        ) : <span className="absolute inset-0 flex items-center justify-center"><Mono>No approved takes yet</Mono></span>}
        {cur && <span className="ui-chip-scrim absolute left-[8px] top-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{cur.code} · V{cur.master?.version ?? 1}</span></span>}
      </div>
      <div className="flex h-[44px] gap-[3px]">
        {shots.map((s) => {
          const w = `${((s.planned ?? PLANNED) / total) * 100}%`;
          const look = s.state === "approved" ? "border-b-2 border-b-accent ui-placeholder" : s.state === "picked" ? "bg-selected" : "border border-dashed border-[rgba(245,246,248,.2)]";
          return (
            <button key={s.id} type="button" style={{ width: w }} onClick={() => { const k = approved.findIndex((a) => a.id === s.id); if (k >= 0) setI(k); }}
              className={`flex min-w-0 items-end justify-start overflow-hidden rounded-badge px-[6px] pb-[4px] ${look}`} title={s.code}>
              <span className="ui-mono text-ink">{s.code}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col rounded-card border border-border bg-card">
        {shots.map((s, n) => (
          <div key={s.id} className="grid h-[46px] grid-cols-[22px_minmax(0,1fr)_auto_auto] items-center gap-[10px] border-b border-hairline px-[12px] last:border-b-0">
            <Mono cost>{String(n + 1).padStart(2, "0")}</Mono>
            <span className="truncate text-[13px] font-medium leading-[1.2] text-ink">{s.code} <span className="font-normal text-ink-body">· {s.description || s.title || "Untitled"}</span></span>
            <Mono>{s.planned ?? PLANNED}s</Mono>
            <Mono cost tone="ink">{s.takes ? fmt(inCredits ? (s.credits ?? 0) : s.spend) : "—"}</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}
