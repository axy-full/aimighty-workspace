"use client";

import { useMemo, useState } from "react";
import type { Board, BoardNode } from "@/lib/boards";
import type { ElementFull } from "@/lib/elements";
import type { RateTable } from "@/lib/rateTable";
import { estimateVideo } from "@/lib/rateTable";
import { estimateTokens, costUsd } from "@/lib/models";
import { Mono } from "@/components/ui";
import Sheet from "@/components/ui/Sheet";
import Loader, { LOADER_SIZES } from "@/components/atomik/Loader";
import LazyMedia from "@/components/LazyMedia";
import { KIND_TAG, KIND_WORD } from "@/components/rig/nodes";
import Pressable from "@/components/ui/Pressable";

/**
 * The Rig on a phone (design/particl-v2-mobile/README.md, board M5):
 * read-and-run. The board built on a desktop is one stack down one wire —
 * the assets in this board as a strip node, the shot node with its 44px
 * slot rows, the image node with its four variants and `Again ×4 · 8 CR`,
 * the video node with its take and `Filed · SH04 v4 · 19 CR` — 358 wide,
 * on the dotted ground, a 1.5px wire at .3 between (the first in ink) and
 * an 8px dot on each edge. Tap a slot and its inspector opens as a sheet:
 * the slot's name and sentence, its three version cards (`BOUND`), and —
 * when a different version is picked — `BEFORE YOU CHANGE THIS`: how many
 * shots use the bound one, approved and draft on a split bar, three priced
 * subsets, and the pinned apply button (`Apply v3 to approved · 57 CR`;
 * outlined `Bound to v2 · PICK ANOTHER VERSION` until a subset is picked).
 * No wire dragging, no adding, no moving: building is a desktop's.
 *
 * Applying rebinds the slot's port to the picked version on the board
 * (free; downstream goes stale, nothing re-runs on its own) and renders a
 * new take for each shot in the subset through the ordinary generate
 * route — the same take the Shots grid's Render makes — priced from the
 * board's video engine before the press.
 */
type ShotLike = { id: string; code: string; title: string; description: string; cast: string[]; planned: number | null; setup: Record<string, string | null>; state?: string; takes: number };
type Slot = { nodeId: string; slotId: string };
type Subset = "approved" | "draft" | "all";

export default function PhoneBoard({ board, fmt, priceOf, running, selected, onSelect, onRun, onNodeMenu, slot, onSlot, shots, elements, engineOf, rates, projectId, onRebind, toast }: {
  board: Board; fmt: (n: number) => string; priceOf: (n: BoardNode) => number; running: Set<string>;
  selected: string | null; onSelect: (id: string | null) => void; onRun: (n: BoardNode) => void;
  /** CR1 §10: a long-press on a node opens the one context menu as a sheet. */
  onNodeMenu?: (nodeId: string, x: number, y: number) => void;
  slot: Slot | null; onSlot: (s: Slot | null) => void;
  shots: ShotLike[]; elements: ElementFull[]; engineOf: (n: BoardNode) => string; rates: RateTable; projectId: string | null;
  onRebind: (assetNodeId: string, portId: string, versionId: string, version: string) => void; toast: (m: string) => void;
}) {
  const assets = board.nodes.filter((n) => n.kind === "asset");
  const rest = [...board.nodes.filter((n) => n.kind !== "asset")].sort((p, q) => rank(p.kind) - rank(q.kind) || p.x - q.x || p.y - q.y);
  const stack: ("assets" | BoardNode)[] = [...(assets.length ? ["assets" as const] : []), ...rest];
  const inputOf = (n: BoardNode, slotId: string) => { const w = board.wires.find((x) => x.to.nodeId === n.id && x.to.slotId === slotId); return w ? { wire: w, src: board.nodes.find((x) => x.id === w.from.nodeId) ?? null } : null; };
  const tag = (kind: BoardNode["kind"]) => <span className="ui-mono rounded-badge border border-border-mid px-[4px] py-[3px] !tracking-[.06em] text-ink-body">{KIND_TAG[kind]}</span>;
  const dot = (where: "top" | "bottom") => <span aria-hidden="true" className={`absolute left-1/2 z-[3] block h-[8px] w-[8px] -translate-x-1/2 rounded-full bg-ink ${where === "top" ? "-top-[5px]" : "-bottom-[5px]"}`} />;
  const wired = assets.reduce((a, n) => a + n.ports.filter((p) => board.wires.some((w) => w.from.nodeId === n.id && (w.from.portId === p.id || w.from.portId === "out"))).length, 0);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto" style={{ backgroundImage: "radial-gradient(rgba(245,246,248,.07) 1px, transparent 1px)", backgroundSize: "24px 24px" }} aria-label="Board" role="region">
        <div className="flex flex-col gap-[60px] p-[16px]" data-phone-board="">
          {stack.map((item, i) => {
            const last = i === stack.length - 1;
            const wire = i > 0 && <span aria-hidden="true" className={`absolute left-1/2 -top-[60px] block h-[60px] -translate-x-1/2 ${i === 1 ? "w-[2px] bg-ink" : "w-[1.5px] bg-[rgba(245,246,248,.3)]"}`} />;
            const box = "relative rounded-card border border-[rgba(245,246,248,.1)] bg-card";
            if (item === "assets") return (
              <div key="assets" className={box} aria-label="Assets in this board">
                <div className="flex h-[32px] items-center gap-[6px] px-[10px]">{tag("asset")}<span className="text-[13px] font-semibold leading-none text-ink">Assets in this board</span><Mono className="ml-auto">{wired} wired</Mono></div>
                <div className="flex gap-[6px] overflow-x-auto px-[10px] pb-[10px]" style={{ scrollSnapType: "x mandatory" }}>
                  {assets.flatMap((n) => n.ports.map((p) => (
                    <span key={`${n.id}:${p.id}`} className="flex w-[96px] flex-none flex-col gap-[5px]" style={{ scrollSnapAlign: "start" }}>
                      <span className="relative block h-[56px] rounded-[7px] border border-border bg-[#1A1D24] ui-placeholder">
                        <span className="ui-chip-scrim absolute left-[5px] top-[5px] rounded-badge px-[5px] py-[3px]"><span className="ui-mono ui-mono-cost text-ink">{p.label}</span></span>
                      </span>
                      <span className="truncate text-[12px] font-medium leading-[1.2] text-ink">{n.label} <span className="text-ink-muted">{p.version ?? ""}</span></span>
                    </span>
                  )))}
                  {!assets.some((n) => n.ports.length) && <span className="py-[8px] text-[12.5px] leading-[1.4] text-ink-body">{assets.map((n) => n.label).join(" · ")}</span>}
                </div>
                {!last && dot("bottom")}
              </div>
            );
            const n = item;
            if (n.kind === "shot") {
              const takes = Number(n.settings.takes ?? 0);
              return (
                <Pressable key={n.id} onMenu={(x, y) => onNodeMenu?.(n.id, x, y)} className={box} aria-label={`Shot ${n.label}`}>
                  {wire}{i > 0 && dot("top")}
                  <div className="flex h-[36px] items-center gap-[8px] px-[10px]">{tag("shot")}<Mono tone="ink">{n.label}</Mono><span className="min-w-0 truncate text-[13px] font-semibold leading-[1.2] text-ink">{String(n.settings.title ?? "")}</span></div>
                  <div className="flex flex-col px-[10px] pb-[4px]">
                    {n.inputs.map((s) => {
                      const found = inputOf(n, s.id);
                      const src = found?.src ?? null;
                      const on = slot?.nodeId === n.id && slot.slotId === s.id;
                      const port = src?.kind === "asset" ? src.ports.find((p) => p.id === found!.wire.from.portId) ?? null : null;
                      return (
                        <button key={s.id} type="button" onClick={() => onSlot({ nodeId: n.id, slotId: s.id })} aria-label={`${s.label} slot`}
                          className={`flex h-[44px] items-center gap-[10px] rounded-ctl px-[6px] text-left ${on ? "bg-[rgba(245,246,248,.06)] ui-node-selected" : ""}`}>
                          <span className="relative h-[30px] w-[48px] flex-none overflow-hidden rounded-[5px] border border-border ui-placeholder" />
                          <span className={`ui-mono ${src ? "text-ink" : "text-ink-muted"}`}>{s.label}</span>
                          <span className="ml-auto ui-mono tracking-normal text-ink-body">{src ? (src.kind === "asset" ? (port?.version ?? "current") : src.kind === "prompt" ? "1 line" : src.label) : "—"}</span>
                          {found?.wire.kind === "override" && <span className="rounded-badge bg-ink px-[5px] py-[4px] ui-mono tracking-normal text-ground">OVR</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-[2px] flex h-[34px] items-center justify-between border-t border-border px-[10px]">
                    <Mono>{takes} {takes === 1 ? "take" : "takes"} · {fmt(Number(n.settings.spent ?? 0))}</Mono>
                    <Mono tone="ink">{n.output?.filedTo ? `v${n.output.filedTo.version} new` : ""}</Mono>
                  </div>
                  {!last && dot("bottom")}
                </Pressable>
              );
            }
            if (n.kind === "prompt" || n.kind === "note") return (
              <div key={n.id} className={box} aria-label={`${KIND_WORD[n.kind]} node`}>
                {wire}{i > 0 && dot("top")}
                <div className="flex h-[32px] items-center gap-[6px] px-[10px]">{tag(n.kind)}<span className="text-[13px] font-semibold leading-none text-ink">{KIND_WORD[n.kind]}</span></div>
                <div className="mx-[10px] mb-[10px] rounded-ctl border border-[rgba(245,246,248,.1)] bg-ground px-[10px] py-[8px] text-[13px] leading-[1.45] text-ink">{n.text || <span className="text-ink-muted">Empty</span>}</div>
                {!last && dot("bottom")}
              </div>
            );
            /* image · video · edit · upscale · audio · voice · compare */
            const done = Boolean(n.output?.genId);
            const busy = running.has(n.id);
            const on = selected === n.id;
            const secs = Number(n.settings.seconds ?? 5);
            const filedTo = n.output?.filedTo ? board.nodes.find((x) => x.ref?.shotId === n.output?.filedTo?.shotId)?.label ?? "shot" : null;
            return (
              <Pressable key={n.id} onMenu={(x, y) => onNodeMenu?.(n.id, x, y)} className={`${box} ${on ? "border-ink ui-node-selected" : ""}`} aria-label={`${KIND_WORD[n.kind]} ${n.label}`} onClick={() => onSelect(n.id)}>
                {wire}{i > 0 && dot("top")}
                <div className="flex h-[32px] items-center gap-[6px] px-[10px]">{tag(n.kind)}<span className="truncate text-[13px] font-semibold leading-none text-ink">{n.label}</span>{done && <span aria-hidden="true" className="ml-auto block h-[8px] w-[8px] rounded-full bg-accent" />}</div>
                {n.kind === "image" ? (
                  <div className="mx-[10px] grid grid-cols-4 gap-[5px]">
                    {[0, 1, 2, 3].map((k) => {
                      const v = n.output?.variants?.[k] ?? (k === 0 && n.output?.url ? { genId: n.output.genId ?? "", url: n.output.url, chosen: true } : null);
                      return (
                        <span key={k} className={`relative box-border aspect-square overflow-hidden rounded-[6px] border ui-placeholder ${v?.chosen ? "border-2 border-ink" : "border-[rgba(245,246,248,.08)]"}`}>
                          {v?.url && <LazyMedia url={v.url} kind="image" className="absolute inset-0 h-full w-full object-cover" />}
                          {busy && k === 0 && <span className="absolute inset-0 flex items-center justify-center"><Loader size={LOADER_SIZES.message} /></span>}
                          {v?.chosen && <span className="absolute bottom-[4px] left-[4px] rounded-[3px] bg-ink px-[4px] py-[3px] ui-mono tracking-normal text-ground">Out</span>}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <div className={`relative mx-[10px] box-border flex aspect-video items-center justify-center overflow-hidden rounded-ctl border ${done || busy ? "border-border ui-placeholder" : "border-dashed border-[rgba(245,246,248,.2)] bg-ground"}`}>
                    {busy ? <Loader size={LOADER_SIZES.well} /> : done ? (
                      <>
                        {n.output?.url && <LazyMedia url={n.output.url} kind={n.output.kind === "image" ? "image" : "video"} className="absolute inset-0 h-full w-full object-cover" />}
                        <span className="relative flex h-[44px] w-[44px] items-center justify-center rounded-full bg-ink text-[14px] font-semibold leading-none text-ground">▶</span>
                        <span className="ui-chip-scrim absolute bottom-[8px] left-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono ui-mono-cost text-accent">Done{n.kind === "video" ? ` · 0:${String(secs).padStart(2, "0")}` : ""} · {String(n.settings.resolution ?? "1080p")}</span></span>
                      </>
                    ) : <Mono>{n.state === "stale" ? "Stale · upstream changed" : "Not run"}</Mono>}
                  </div>
                )}
                <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(n.id); onRun(n); }} disabled={busy}
                  className={`mx-[10px] mb-[10px] mt-[8px] box-border flex h-[44px] w-[calc(100%-20px)] items-center justify-between rounded-tile border border-[rgba(245,246,248,.16)] px-[12px] text-[13px] font-medium leading-none ${filedTo ? "text-ink-body" : "text-ink"}`}>
                  <span className="truncate">{done ? (filedTo ? `Filed · ${filedTo} v${n.output!.filedTo!.version}` : n.kind === "image" ? `Again ×${Number(n.settings.count ?? 1)}` : "Again") : "Generate"}</span>
                  <Mono cost>{fmt(done ? n.credits : priceOf(n))}</Mono>
                </button>
                {!last && dot("bottom")}
              </Pressable>
            );
          })}
          {!stack.length && <span className="text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>An empty board. Build it on a desktop; run and file it from here.</span>}
        </div>
      </div>
      {slot && <SlotSheet board={board} slot={slot} onClose={() => onSlot(null)} fmt={fmt} shots={shots} elements={elements} engineOf={engineOf} rates={rates} projectId={projectId} onRebind={onRebind} toast={toast} />}
    </>
  );
}

const rank = (k: BoardNode["kind"]) => (k === "shot" ? 1 : k === "image" ? 2 : k === "video" ? 3 : k === "prompt" || k === "note" ? 5 : 4);

/* ── the slot's inspector (M5), as a sheet ──────────────────────────── */
function SlotSheet({ board, slot, onClose, fmt, shots, elements, engineOf, rates, projectId, onRebind, toast }: {
  board: Board; slot: Slot; onClose: () => void; fmt: (n: number) => string; shots: ShotLike[]; elements: ElementFull[];
  engineOf: (n: BoardNode) => string; rates: RateTable; projectId: string | null;
  onRebind: (assetNodeId: string, portId: string, versionId: string, version: string) => void; toast: (m: string) => void;
}) {
  const node = board.nodes.find((n) => n.id === slot.nodeId) ?? null;
  const input = node?.inputs.find((i) => i.id === slot.slotId) ?? null;
  const wire = board.wires.find((w) => w.to.nodeId === slot.nodeId && w.to.slotId === slot.slotId) ?? null;
  const src = wire ? board.nodes.find((n) => n.id === wire.from.nodeId) ?? null : null;
  const element = src?.ref?.elementId ? elements.find((e) => e.id === src.ref!.elementId) ?? null : null;
  const port = src && wire ? src.ports.find((p) => p.id === wire.from.portId) ?? null : null;
  const attribute = element && port ? element.attributes.find((a) => a.id === (port.attributeId ?? port.id)) ?? element.attributes[0] ?? null : element?.attributes[0] ?? null;
  const versions = useMemo(() => (attribute?.versions ?? []).filter((v) => v.status !== "failed"), [attribute]);
  const boundId = port?.versionId ?? attribute?.currentId ?? versions[versions.length - 1]?.id ?? null;
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [subset, setSubset] = useState<Subset | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = pickedId ?? boundId;
  const changing = picked != null && picked !== boundId;
  const vNum = (id: string | null) => { const i = versions.findIndex((v) => v.id === id); return i >= 0 ? `v${i + 1}` : "v—"; };

  /* The shots this asset touches, and what re-rendering each would cost at the board's video engine. */
  const videoNode = board.nodes.find((n) => n.kind === "video") ?? null;
  const engine = videoNode ? engineOf(videoNode) : "";
  const uses = useMemo(() => element ? shots.filter((s) => s.cast.some((c) => c.replace(/^@/, "").toLowerCase() === element.name.toLowerCase())) : [], [shots, element]);
  const approved = uses.filter((s) => s.state === "approved");
  const draft = uses.filter((s) => s.state !== "approved");
  const quote = (s: ShotLike) => { const secs = s.planned ?? 5; return engine ? (estimateVideo(rates, engine, "1080p", secs, estimateTokens("1080p", "16:9", secs), costUsd) ?? 0) : 0; };
  const cost = (list: ShotLike[]) => list.reduce((a, s) => a + quote(s), 0);
  const subsets: { id: Subset; label: string; note: string; list: ShotLike[] }[] = [
    { id: "approved", label: `Apply to approved · ${approved.length}`, note: "Re-renders the approved takes with the new version.", list: approved },
    { id: "draft", label: `Apply to draft · ${draft.length}`, note: "Only the shots nobody has approved yet.", list: draft },
    { id: "all", label: `Apply to all · ${uses.length}`, note: "Every shot that cites this asset.", list: uses },
  ];
  const chosen = subsets.find((s) => s.id === subset) ?? null;

  const apply = async () => {
    if (!src || !port || !picked || !chosen || busy) return;
    setBusy(true);
    try {
      onRebind(src.id, port.id, picked, vNum(picked));
      let n = 0;
      for (const s of chosen.list) {
        const prompt = [s.description || s.title, Object.values(s.setup ?? {}).filter(Boolean).join(" · ")].filter(Boolean).join(". ");
        if (!prompt || !engine) continue;
        const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, model: engine, projectId, shotId: s.id, ratio: "16:9", resolution: "1080p", duration: s.planned ?? 5 }) });
        if (r.ok) n++; else { const j = await r.json().catch(() => ({})); toast(j.error ?? `${s.code} didn't start.`); break; }
      }
      toast(`${element?.name ?? "Asset"} → ${vNum(picked)} · ${n} ${n === 1 ? "take" : "takes"} rendering · ${fmt(cost(chosen.list))}`);
      onClose();
    } finally { setBusy(false); }
  };

  const title = src ? src.label : input?.label ?? "Slot";
  const blurb = !src ? "Nothing is wired here. Wire it on a desktop; run and file from here."
    : src.kind === "asset" ? `Bound to ${vNum(boundId)} on this board. Pick another version to see what it touches before anything re-renders.`
    : src.kind === "prompt" ? "A prompt node feeds this slot. Edit its words on a desktop." : `${src.label} feeds this slot.`;
  const canApply = changing && chosen != null && chosen.list.length > 0 && Boolean(engine);

  return (
    <Sheet open onClose={onClose} label={`${input?.label ?? "Slot"} · ${node?.label ?? ""}`} size="auto" max="78%" bodyClassName="!pt-0" footerPad="8px 16px 26px"
      header={
        <div className="flex flex-none flex-col gap-[6px] px-[16px] pb-[10px] pt-[12px]">
          <Mono>Slot · {node?.label ?? ""} · {input?.label ?? ""}</Mono>
          <span className="text-[20px] font-semibold leading-[1.15] text-ink">{title}</span>
          <span className="text-[13.5px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>{blurb}</span>
        </div>
      }
      footer={
        <button type="button" disabled={!canApply || busy} onClick={apply} data-apply=""
          className={`flex h-[52px] w-full items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${canApply ? "bg-ink text-ground" : "border border-[rgba(245,246,248,.2)] bg-transparent text-ink-body"}`}>
          <span className="truncate">{busy ? "Applying…" : canApply ? `Apply ${vNum(picked)} to ${chosen!.id}` : `Bound to ${vNum(boundId)}`}</span>
          <span className={`ui-mono ui-mono-cost !text-[12px] ${canApply ? "text-on-primary-cost" : "text-ink-muted"}`}>{canApply ? fmt(cost(chosen!.list)) : changing ? "Pick a subset" : "Pick another version"}</span>
        </button>
      }>
      {versions.length > 0 ? (
        <div className="grid grid-cols-3 gap-[8px]" role="listbox" aria-label="Versions">
          {versions.map((v, i) => {
            const on = v.id === picked;
            return (
              <button key={v.id} type="button" role="option" aria-selected={on} onClick={() => { setPickedId(v.id); setSubset(null); }}
                className={`overflow-hidden rounded-tile border bg-card text-left ${on ? "border-[rgba(245,246,248,.5)] ui-node-selected" : "border-[rgba(245,246,248,.12)]"}`}>
                <span className="relative block aspect-[4/3] ui-placeholder">
                  {v.uploadId && <LazyMedia url={`/api/uploads/${encodeURIComponent(v.uploadId)}`} kind="image" className="absolute inset-0 h-full w-full object-cover" />}
                  {v.id === boundId && <span className="absolute left-[5px] top-[5px] rounded-[3px] bg-ink px-[4px] py-[3px] ui-mono tracking-normal text-ground">Bound</span>}
                </span>
                <span className="flex flex-col gap-[3px] px-[9px] py-[8px]">
                  <span className="text-[13px] font-semibold leading-none text-ink">v{i + 1}</span>
                  <span className="text-[12px] leading-[1.25] text-ink-body">{v.id === boundId ? "bound" : i === versions.length - 1 ? "newest" : new Date(v.createdAt).toLocaleDateString([], { day: "numeric", month: "short" })}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : <span className="text-[13px] leading-[1.45] text-ink-body">{src?.kind === "asset" ? "No versions yet on this attribute." : "Nothing to pick here."}</span>}
      {changing && (
        <div className="flex flex-col gap-[10px] rounded-card border border-border-mid bg-card p-[14px]" role="group" aria-label="Before you change this">
          <Mono>Before you change this</Mono>
          <span className="text-[15px] font-semibold leading-[1.25] text-ink">{uses.length} {uses.length === 1 ? "shot uses" : "shots use"} {vNum(boundId)}</span>
          <span className="text-[13px] leading-[1.4] text-ink-body">{approved.length} approved · {draft.length} draft. Nothing has re-rendered yet.</span>
          <span className="flex h-[8px] gap-[2px] overflow-hidden rounded-[3px]">
            <span className="bg-accent" style={{ flex: Math.max(approved.length, uses.length ? 0 : 1) }} /><span className="bg-[rgba(245,246,248,.22)]" style={{ flex: Math.max(draft.length, uses.length ? 0 : 1) }} />
          </span>
          {subsets.map((o) => {
            const on = subset === o.id;
            return (
              <button key={o.id} type="button" role="radio" aria-checked={on} disabled={!o.list.length} onClick={() => setSubset(o.id)}
                className={`flex min-h-[48px] items-center gap-[10px] rounded-tile border px-[11px] py-[9px] text-left disabled:opacity-60 ${on ? "border-[rgba(245,246,248,.5)] bg-[rgba(245,246,248,.06)]" : "border-[rgba(245,246,248,.12)]"}`}>
                <span className={`box-border h-[18px] w-[18px] flex-none rounded-full border-[1.5px] ${on ? "border-ink bg-ink" : "border-[rgba(245,246,248,.3)]"}`} />
                <span className="flex min-w-0 flex-col gap-[3px]"><span className="text-[13.5px] font-medium leading-[1.2] text-ink">{o.label}</span><span className="text-[12px] leading-[1.3] text-ink-body">{o.note}</span></span>
                <Mono cost tone="ink" className="ml-auto flex-none">{fmt(cost(o.list))}</Mono>
              </button>
            );
          })}
          {!engine && <Mono>Wire a video node on a desktop to price this</Mono>}
        </div>
      )}
    </Sheet>
  );
}
