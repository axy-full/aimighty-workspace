"use client";

/**
 * R3 — the project canvas.
 *
 * A board the team lays a project out on: renders, reference stills, notes and
 * sequence headings, arranged the way a wall of index cards would be. It is
 * deliberately not a drawing tool — the value is seeing a sequence in order,
 * next to the references it came from, with everyone looking at the same
 * arrangement.
 *
 * Layout writes are one indexed UPDATE per drag release, and the board polls
 * for other people's moves, which is enough for a room of six. Cards being
 * dragged locally are never overwritten by an incoming poll.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { appConfirm, appPrompt } from "@/components/dialog";
import { Empty } from "@/components/ParticlMark";

export type CanvasItem = {
  id: string; kind: "generation" | "upload" | "note" | "heading";
  refId: string | null; text: string;
  x: number; y: number; w: number; h: number; z: number; colour: string;
  authorName: string | null; updatedAt: number;
  gen: { status: string; url: string | null; kind: "video" | "image";
         prompt: string; version: number; shot: string | null } | null;
  upload: { url: string; mime: string } | null;
};

type Props = {
  projectId: string;
  items: CanvasItem[];
  onChanged: () => void;
  /** Load a render back into the composer — "use this asset for the next one". */
  onUse?: (genId: string, prompt: string) => void;
};

const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export default function Canvas({ projectId, items, onChanged, onUse }: Props) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  /** Where a board pan started. STATE, not a ref — see the pan effect below. */
  const [panFrom, setPanFrom] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  /** Local overrides while a card is under the pointer — a poll must not yank it. */
  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => items.map((it) => (local[it.id] ? { ...it, ...local[it.id] } : it)),
    [items, local]
  );

  const save = useCallback(async (id: string, patch: Partial<CanvasItem>) => {
    await fetch(`/api/canvas/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    onChanged();
  }, [onChanged]);

  /* ── Dragging a card ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left - pan.x) / scale - drag.dx;
      const y = (e.clientY - rect.top - pan.y) / scale - drag.dy;
      setLocal((l) => ({ ...l, [drag.id]: { x: snap(x), y: snap(y) } }));
    };
    const up = () => {
      const pos = local[drag.id];
      if (pos) save(drag.id, pos);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // Same reason as the pan effect: a cancelled pointer sends no pointerup,
    // and a drag that never releases keeps following the cursor.
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag, pan, scale, local, save]);

  /* ── Panning the board ─────────────────────────────────────────────
   * This used to arm a REF and rely on an effect with no dependency array to
   * notice. It never did on a fresh board: the only state call in the handler
   * was setSelected(null), which is a no-op when nothing is selected, so React
   * bailed out, no render happened, and the effect never ran to attach the
   * listeners. Measured: dragging the surface moved the board 0px until some
   * unrelated render — selecting a card, a poll — happened to attach them.
   * That matters more than it sounds: the board has no scrollbar and no native
   * pan, so on a phone dragging IS the only way to reach a card outside the
   * viewport.
   *
   * Panning is state now, exactly like the card drag above, so the effect has
   * real dependencies and attaches the moment a pan begins.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!panFrom) return;
    const move = (e: PointerEvent) => {
      setPan({ x: panFrom.px + (e.clientX - panFrom.x), y: panFrom.py + (e.clientY - panFrom.y) });
    };
    const end = () => setPanFrom(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    // A native drag or an iOS long-press callout ends the pointer stream with
    // pointercancel and never sends pointerup. Without this the gesture never
    // releases and the board follows the bare cursor.
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [panFrom]);

  function onSurfaceDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return;
    setSelected(null);
    setPanFrom({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
  }

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale((s) => Math.min(2, Math.max(0.25, s - e.deltaY * 0.002)));
  }

  async function addNote(kind: "note" | "heading") {
    const text = await appPrompt(kind === "note" ? "Note" : "Section heading", "");
    if (!text) return;
    // Cascade, or every note lands on the identical cell and buries the last
    // one — the render cards already do this in the page's add().
    const n = items.filter((i) => i.kind === "note" || i.kind === "heading").length;
    await fetch("/api/canvas", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, kind, text,
        x: snap(-pan.x / scale + 80 + (n % 6) * 40),
        y: snap(-pan.y / scale + 80 + (n % 6) * 32),
      }),
    });
    onChanged();
  }

  async function remove(id: string) {
    if (!(await appConfirm("Take this off the board?",
      "The render itself stays in the library.", { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/canvas/${id}`, { method: "DELETE" });
    setSelected(null);
    onChanged();
  }

  /** Lay the board out in shot order — the one arrangement everyone agrees on. */
  async function tidy() {
    const cards = [...shown].filter((i) => i.kind === "generation");
    cards.sort((a, b) => {
      const sa = a.gen?.shot ?? "zzz", sb = b.gen?.shot ?? "zzz";
      if (sa !== sb) return sa.localeCompare(sb);
      return (a.gen?.version ?? 0) - (b.gen?.version ?? 0);
    });
    let row = -1, col = 0, lastShot: string | null = null;
    for (const c of cards) {
      const shot = c.gen?.shot ?? null;
      if (shot !== lastShot) { row++; col = 0; lastShot = shot; }
      await save(c.id, { x: 40 + col * 300, y: 40 + row * 250 });
      col++;
    }
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-panel2">
      {/* Board controls */}
      <div className="pop-surface absolute left-3 right-3 top-3 z-20 flex items-center gap-1
                      overflow-x-auto px-2 py-1.5 sm:right-auto sm:left-4 sm:top-4
                      [&>*]:shrink-0">
        <button onClick={() => addNote("note")} className="chip">+ Note</button>
        <button onClick={() => addNote("heading")} className="chip">+ Section</button>
        <button onClick={tidy} className="chip">Tidy by shot</button>
        <span className="mx-1 h-4 w-px bg-hair" />
        <button onClick={() => setScale((s) => Math.max(0.25, s - 0.15))} className="chip">−</button>
        <span className="w-[46px] text-center text-[12px] tabular-nums text-dim">
          {Math.round(scale * 100)}%
        </span>
        <button onClick={() => setScale((s) => Math.min(2, s + 0.15))} className="chip">+</button>
        <button onClick={() => { setScale(1); setPan({ x: 40, y: 40 }); }} className="chip">Reset</button>
      </div>

      <div
        ref={surface}
        onPointerDown={onSurfaceDown}
        onWheel={onWheel}
        className="h-full w-full touch-none cursor-grab active:cursor-grabbing"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, var(--color-hair) 1px, transparent 0)",
          backgroundSize: `${GRID * scale}px ${GRID * scale}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        <div className="relative h-0 w-0"
             style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                      transformOrigin: "0 0" }}>
          {shown.map((it) => (
            <Card key={it.id} item={it}
              selected={selected === it.id}
              onSelect={() => setSelected(it.id)}
              onDragStart={(dx, dy) => setDrag({ id: it.id, dx, dy })}
              onRemove={() => remove(it.id)}
              onUse={onUse}
              onEdit={async () => {
                const text = await appPrompt("Edit", it.text);
                if (text != null) await save(it.id, { text });
              }} />
          ))}
        </div>
      </div>

      {!items.length && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Empty title="An empty wall"
            line="Add renders from the rail, drop in a section heading, and lay the sequence out the way you'd pin cards to a board." />
        </div>
      )}
    </div>
  );
}

function Card({ item, selected, onSelect, onDragStart, onRemove, onEdit, onUse }: {
  item: CanvasItem; selected: boolean; onSelect: () => void;
  onDragStart: (dx: number, dy: number) => void;
  onRemove: () => void; onEdit: () => void;
  onUse?: (genId: string, prompt: string) => void;
}) {
  const start = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = rect.width / item.w || 1;
    onDragStart((e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
  };

  const common = "absolute select-none touch-none [-webkit-touch-callout:none]";
  const ring = selected ? "outline outline-2 outline-blue" : "";

  if (item.kind === "heading") {
    return (
      <div className={`${common} ${ring} cursor-move`} onPointerDown={start}
        onDoubleClick={onEdit}
        style={{ left: item.x, top: item.y, width: item.w }}>
        <p className="text-[20px] font-semibold tracking-[-0.02em] text-black">{item.text}</p>
        {selected && <button onClick={onRemove}
          className="mt-1 text-[12px] text-lift">Remove</button>}
      </div>
    );
  }

  if (item.kind === "note") {
    return (
      <div className={`${common} ${ring} cursor-move rounded-[var(--r)] bg-[#FFF8C5] p-3 shadow-[var(--shadow-card)]`}
        onPointerDown={start} onDoubleClick={onEdit}
        style={{ left: item.x, top: item.y, width: item.w, minHeight: item.h }}>
        <p className="whitespace-pre-wrap text-[14px] leading-snug text-black">{item.text}</p>
        {item.authorName && <p className="mt-2 text-[11px] text-mute">{item.authorName}</p>}
        {selected && <button onClick={onRemove}
          className="mt-1 text-[12px] text-lift">Remove</button>}
      </div>
    );
  }

  const url = item.gen?.url ?? item.upload?.url ?? null;
  const isImage = item.gen ? item.gen.kind === "image" : (item.upload?.mime ?? "").startsWith("image/");

  return (
    <div className={`${common} ${ring} cursor-move overflow-hidden rounded-[var(--r)] bg-panel shadow-[var(--shadow-card)]`}
      onPointerDown={start}
      style={{ left: item.x, top: item.y, width: item.w }}>
      <div className="relative aspect-video w-full bg-thumb">
        {url ? (
          <LazyMedia url={url} kind={isImage ? "image" : "video"}
            className="h-full w-full object-cover" alt={item.gen?.prompt ?? "Reference"} />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-mute">
            {item.gen?.status === "failed" ? "failed" : "rendering…"}
          </div>
        )}
      </div>
      <div className="px-3 py-2">
        <p className="flex items-center gap-2 text-[12px] text-dim">
          {item.gen?.shot && <span className="font-medium text-black">{item.gen.shot}</span>}
          {item.gen && <span className="text-mute">v{item.gen.version}</span>}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-mute">
          {item.gen?.prompt ?? "Reference"}
        </p>
        {selected && (
          <div className="mt-2 flex gap-3">
            {onUse && item.gen && item.refId && (
              <button onClick={() => onUse(item.refId!, item.gen!.prompt)}
                className="text-[12px] text-blue">Use</button>
            )}
            <button onClick={onRemove} className="text-[12px] text-lift">Remove</button>
          </div>
        )}
      </div>
    </div>
  );
}
