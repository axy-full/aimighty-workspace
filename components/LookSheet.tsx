"use client";

/**
 * One Look, opened: its cover, what it sets, its style block, its
 * references, and what to do with it.
 */
import { CATEGORIES, specToPhrase, type ShotSpec } from "@/lib/studio";
import LazyMedia from "./LazyMedia";
import { IconClose, IconSparkle } from "./Icons";

export type LookCover = { url: string; kind: "image" | "video"; genId?: string } | null;
export type LookItem = {
  id: string; slug: string | null; projectId: string | null;
  name: string; category: string; blurb: string;
  spec: ShotSpec; prose: string; refs: string[];
  coverGenId: string | null; coverUploadId: string | null;
  swatch: [string, string]; builtin: boolean;
  createdBy: string; createdAt: number; updatedAt: number;
  cover: LookCover;
};

export default function LookSheet({ look, onClose, onUse, onEdit, onDuplicate, onDelete }: {
  look: LookItem;
  onClose: () => void; onUse: () => void;
  onEdit?: () => void; onDuplicate: () => void; onDelete?: () => void;
}) {
  const chips = CATEGORIES.flatMap((c) => {
    const o = c.options.find((x) => x.value === look.spec[c.key]);
    return o ? [{ key: c.key, cat: c.label, label: o.label }] : [];
  });
  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={look.name}>
        <div className="look-hero" style={{ background: `linear-gradient(135deg, ${look.swatch[0]}, ${look.swatch[1]})` }}>
          {look.cover && <LazyMedia url={look.cover.url} kind={look.cover.kind} hoverPlay alt={look.name} className="!absolute inset-0" />}
          <button type="button" onClick={onClose} className="look-hero-close" title="Close"><IconClose /></button>
        </div>
        <div className="sheet-body">
          <p className="text-[11px] font-medium uppercase tracking-[.16em] text-mute" style={{ fontFamily: "var(--font-kode)" }}>
            {look.category}{look.builtin ? " · ships with Particl" : look.projectId ? " · this project" : " · whole workspace"}
          </p>
          <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.02em]" style={{ fontFamily: "var(--font-display)" }}>{look.name}</h2>
          {look.blurb && <p className="mt-1 text-[15px] text-dim">{look.blurb}</p>}

          {look.prose && (
            <>
              <p className="mt-5 text-[12px] font-medium uppercase tracking-wide text-mute">Style block</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-bone">{look.prose}</p>
            </>
          )}

          {chips.length > 0 && (
            <>
              <p className="mt-5 text-[12px] font-medium uppercase tracking-wide text-mute">Sets</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <span key={c.key} className="chip !py-1 !text-[12.5px]" title={c.cat}>
                    <span className="text-mute">{c.cat} ·</span> {c.label}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[13px] text-dim">Reads as: {specToPhrase(look.spec)}.</p>
            </>
          )}

          {look.refs.length > 0 && (
            <>
              <p className="mt-5 text-[12px] font-medium uppercase tracking-wide text-mute">References <span className="normal-case tracking-normal">· attached to every render in this look</span></p>
              <div className="mt-2 flex flex-wrap gap-2">
                {look.refs.map((id) => (
                  <span key={id} className="ref-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/uploads/${id}`} alt="" className="h-full w-full object-cover" />
                  </span>
                ))}
              </div>
            </>
          )}

          {!look.prose && chips.length === 0 && look.refs.length === 0 && (
            <p className="mt-5 text-[14px] text-mute">This look is empty. Edit it to add chips, a style block or references.</p>
          )}
        </div>
        <footer className="sheet-foot">
          <button type="button" onClick={onUse} className="btn-render inline-flex h-[36px] items-center gap-2 px-5 text-[14px]">
            <IconSparkle className="!h-4 !w-4" /> Use in Generate
          </button>
          <span className="ml-auto flex gap-2">
            {onEdit && <button type="button" onClick={onEdit} className="chip">Edit</button>}
            <button type="button" onClick={onDuplicate} className="chip">{look.builtin ? "Make it mine" : "Duplicate"}</button>
            {onDelete && <button type="button" onClick={onDelete} className="chip !text-lift">Delete</button>}
          </span>
        </footer>
      </div>
    </div>
  );
}
