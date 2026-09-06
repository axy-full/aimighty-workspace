"use client";

import { useEffect, useRef, useState } from "react";
import { usePrice } from "@/lib/price";
import { appConfirm } from "@/components/dialog";
import type { Step, Engine } from "@/lib/atomik";

/**
 * The gate.
 *
 * Everything in Atomik exists to arrive here: the agent has decided what to
 * render, and this is where a person decides whether to pay for it. So the
 * card shows the whole prompt rather than a summary, the exact engine, and
 * the price ON the button — not beside it, not in a tooltip, on the thing
 * your finger is going to.
 *
 * The parameters are editable, and that is the important part. A gate that
 * only takes yes or no makes a wrong guess about aspect ratio into a
 * rejection and a re-plan; here you change the chip, the price re-computes
 * against the real rate card, and you approve the thing you actually
 * wanted. It is where you change your mind, not merely where you consent.
 *
 * Three ways out, all of them cheap: approve it, say something else instead
 * (which sends the agent back to work with your correction), or stop.
 */

type Props = {
  step: Step;
  engines: Engine[];
  busy: boolean;
  onApprove: (step: Step) => void;
  onReject: (step: Step, instead: string) => void;
  onEdit: (patch: { prompt?: string; params?: Record<string, unknown> }) => Promise<void>;
  onAlwaysAllow: () => void;
};

export default function ApprovalCard({
  step, engines, busy, onApprove, onReject, onEdit, onAlwaysAllow,
}: Props) {
  const price = usePrice();
  const [instead, setInstead] = useState("");
  const [expanded, setExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const engine = engines.find((e) => e.id === step.model);
  const seconds = Number(step.params.seconds) || undefined;
  const ratio = typeof step.params.ratio === "string" ? step.params.ratio : undefined;
  const resolution = typeof step.params.resolution === "string" ? step.params.resolution : undefined;

  /* Escape stops. It is the safe answer, so it gets the reflex key — the
     same reasoning that puts focus on Cancel in a destructive dialog.
     
     It listens on the document because the card rarely holds focus, and it
     therefore has to stand down whenever something is stacked ON the card:
     a confirm dialog, an open parameter menu, or a field being typed in.
     Bound in the capture phase and swallowing the key, it was rejecting the
     proposal every time Escape was aimed at any of those. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      if (document.querySelector('[role="dialog"], .approve-menu, .atomik-models, .mode-pop')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.stopPropagation();
      onReject(step, "");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [step, busy, onReject]);

  const verb = step.kind === "audio" ? "audio" : step.kind === "image" ? "image" : "video";

  return (
    <div ref={cardRef} className="approve" role="group" aria-label={`Approve ${verb} generation`}>
      <p className="approve-head">
        <KindIcon kind={step.kind} />
        <span>Approve {verb} generation</span>
        {step.title && <span className="approve-title">{step.title}</span>}
      </p>

      <p className={`approve-prompt ${expanded ? "is-open" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Show less" : "Show the whole prompt"}>
        {step.prompt}
      </p>

      <div className="approve-chips">
        <span className="approve-engine">{engine?.label ?? step.model}</span>

        {engine && engine.ratios.length > 1 && (
          <Chip label="Aspect" value={ratio ?? engine.ratios[0]} options={engine.ratios}
            disabled={busy} onPick={(v) => onEdit({ params: { ratio: v } })} />
        )}
        {engine && engine.resolutions.length > 1 && (
          <Chip label="Resolution" value={resolution ?? engine.resolutions[0]}
            options={engine.resolutions} disabled={busy}
            onPick={(v) => onEdit({ params: { resolution: v } })} />
        )}
        {engine && engine.durations.length > 1 && (
          <Chip label="Length" value={`${seconds ?? engine.durations[0]}s`}
            options={engine.durations.map((d) => `${d}s`)} disabled={busy}
            onPick={(v) => onEdit({ params: { seconds: Number(v.replace("s", "")) } })} />
        )}
      </div>

      <div className="approve-foot">
        <input
          value={instead}
          onChange={(e) => setInstead(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && instead.trim() && !busy) {
              e.preventDefault(); onReject(step, instead.trim());
            }
          }}
          placeholder="Type something else…"
          className="approve-instead"
          disabled={busy}
        />

        <button type="button" className="approve-always" disabled={busy}
          onClick={async () => {
            const ok = await appConfirm(
              "Stop asking in this chat?",
              "Every generation after this one runs as soon as the agent decides on it, and spends without checking. " +
              "You can turn asking back on from the composer at any time.",
              { confirmLabel: "Stop asking" },
            );
            if (ok) onAlwaysAllow();
          }}>
          Always allow
        </button>

        <button type="button" className="approve-stop" disabled={busy}
          onClick={() => onReject(step, instead.trim())}>
          Stop <kbd>esc</kbd>
        </button>

        <button type="button" className="approve-go" disabled={busy}
          onClick={() => onApprove(step)}>
          {busy ? "Starting…" : (
            <>
              Approve
              <span className="approve-price">
                {step.estCostUsd == null ? "priced at render" : price(step.estCostUsd, step.model)}
              </span>
              <kbd>↵</kbd>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/** One editable parameter. Picking re-prices the step, so the number on the
 *  Approve button always matches what this card would charge. */
function Chip({ label, value, options, disabled, onPick }: {
  label: string; value: string; options: string[];
  disabled: boolean; onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button type="button" disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`approve-chip ${open ? "is-open" : ""}`} title={label}>
        {value}
      </button>
      {open && (
        <div className="approve-menu pop-surface">
          <p className="approve-menu-head">{label}</p>
          {options.map((o) => (
            <button key={o} type="button"
              onClick={() => { setOpen(false); if (o !== value) onPick(o); }}
              className={`approve-menu-item ${o === value ? "is-on" : ""}`}>
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: Step["kind"] }) {
  const d = kind === "image"
    ? "M2 4h12v9H2zM2 11l3.5-3 3 2.5L11 8l3 3"
    : kind === "audio"
      ? "M3 6v4M6 3.5v9M9 5v6M12 7v2"
      : "M2 4h9v9H2zM11 7l3-2v6l-3-2";
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 text-mute">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
