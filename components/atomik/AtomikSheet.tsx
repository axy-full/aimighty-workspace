"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { useAtomikRail, setAtomikRail } from "@/lib/atomikRail";
import Ring from "@/components/atomik/Ring";
import { ChatComposer } from "./ChatComposer";
import { Mono, Sheet } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import type { Step } from "@/lib/atomik";

/**
 * Atomik on a phone (design/particl-v2-mobile/README.md; board M3, live):
 * the rail as a sheet. Compact is 58% of the screen — the header (the ring
 * at 18, `Atomik`, the run's context line, `Expand ↑`, ×), one checkpoint
 * card, and the ask field pinned under it. Expanded is 92%: the
 * conversation and the plan card (48px rows, `CHECKPOINT · YOU ARE HERE`)
 * above the same checkpoint card. `Compact ↓` returns; × closes. The same
 * store drives it as the desktop rail (§5): the header button, ⌘J, and a
 * checkpoint or question arriving all open it, compact first.
 *
 * The checkpoint card (M3): `--card`, a .3 rule, radius 14, 16px, 10 apart —
 * `CHECKPOINT · STOPPED`, the 20/1.2 headline (`Boards done · 12 cr
 * spent.`), one sentence at 14/1.45, `Continue · 24 CR` (52px, radius 14),
 * `Change engine` / `Stop here` (44px, radius 12, .16), and `19 OF 253 CR ·
 * PLANNING 3 CR`. A question shows its options as 44px buttons; with
 * nothing to decide the card says so.
 */
export default function AtomikSheet() {
  const a = useAtomik();
  const rail = useAtomikRail();
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number; step: Step } | null>(null);
  const seen = useRef<string | null>(null);
  const cur = a.current;
  useEffect(() => {
    const key = cur.kind === "checkpoint" ? `c:${cur.step.id}` : cur.kind === "question" ? `q:${cur.message.id}` : null;
    if (key && seen.current !== key) { seen.current = key; setAtomikRail("compact"); }
  }, [cur]);
  const close = () => setAtomikRail("closed");
  const expanded = rail.state === "expanded";
  const step: Step | null = cur.kind === "checkpoint" ? cur.step : cur.kind === "plan" ? (cur.steps.find((s) => s.status === "proposed") ?? null) : null;
  const done = cur.kind === "checkpoint" ? cur.done : cur.kind === "done" ? cur.steps : a.plan.filter((s) => s.status === "done");
  const spent = cur.kind === "checkpoint" || cur.kind === "done" ? cur.spentCredits : 0;
  const total = a.plan.length;
  const context = total ? `${done.length} of ${total}` : a.chat?.title ?? null;
  const eyebrow = step ? "Checkpoint · stopped" : cur.kind === "question" ? "Question" : cur.kind === "planning" ? "Planning" : cur.kind === "done" ? "Done" : "Nothing needs you";
  const secondary = "tap44 flex h-[44px] flex-1 items-center justify-center rounded-card border border-[rgba(245,246,248,.16)] text-[13.5px] font-medium leading-none";
  const action = "tap44 flex h-[34px] items-center rounded-ctl border border-border-mid px-[10px] text-[12.5px] font-medium leading-none text-ink";

  return (
    <Sheet open={rail.open} onClose={close} label="Atomik" size={expanded ? "expanded" : "compact"}
      title={<span className="flex items-center gap-[8px]">{"steps" in a.ring && a.ring.steps ? <Ring steps={a.ring.steps} size={18} /> : <Ring mode={"mode" in a.ring && a.ring.mode ? a.ring.mode : "idle"} size={18} />}Atomik</span>} context={context}
      actions={expanded ? <button type="button" onClick={rail.compact} className={action}>Compact ↓</button> : <button type="button" onClick={rail.expand} className={action}>Expand ↑</button>}
      footer={<ChatComposer />} footerPad="8px 16px 26px">
      {expanded && (
        <>
          {a.messages.map((m) => (
            <div key={m.id} className={`flex flex-col gap-[5px] ${m.role === "user" ? "items-end" : "items-start"}`}>
              <Mono>{m.role === "user" ? "You" : "Atomik"}</Mono>
              <span className={`max-w-[300px] rounded-card px-[12px] py-[10px] text-[13.5px] leading-[1.45] ${m.role === "user" ? "bg-selected text-ink" : "border border-border-mid bg-card text-ink-body"}`} style={{ textWrap: "pretty" }}>{m.text}</span>
            </div>
          ))}
          {a.plan.length > 0 && (
            <div className="overflow-hidden rounded-card border border-border-mid bg-card" role="list" aria-label="Plan">
              {a.plan.map((s, i) => {
                const at = step?.id === s.id;
                return (
                  <div key={s.id} role="listitem">
                    <div className={`grid h-[48px] grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-[10px] border-b border-hairline px-[12px] ${at ? "bg-selected" : ""}`}>
                      <span className="ui-mono tracking-normal text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                      <span className="flex min-w-0 flex-col gap-[4px]"><span className="truncate text-[13px] font-medium leading-[1.2] text-ink">{s.title}</span><Mono className="truncate">{a.engineLabel(s.model)}</Mono></span>
                      <Mono cost tone="ink">{a.fmt(a.credits(s))}</Mono>
                    </div>
                    {at && <div className="flex h-[30px] items-center gap-[8px] border-b border-hairline px-[12px] ui-mono text-ink"><span className="box-border block h-[8px] w-[8px] rounded-full border-2 border-accent" />Checkpoint · you are here</div>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      <div className="flex flex-col gap-[10px] rounded-mobile border border-[rgba(245,246,248,.3)] bg-card p-[16px]" aria-label="Checkpoint" role="group">
        <Mono>{eyebrow}</Mono>
        <span className="text-[20px] font-semibold leading-[1.2] text-ink" data-headline="">
          {step ? `${done.length ? `${done[done.length - 1].title} done` : "Ready"} · ${a.fmt(spent)} spent.`
            : cur.kind === "question" ? cur.ask.question
            : cur.kind === "planning" ? "Planning."
            : cur.kind === "done" ? `Done · ${a.fmt(spent)} spent.`
            : "Nothing needs you."}
        </span>
        <span className="text-[14px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>
          {step ? `Next: ${step.title.toLowerCase()} on ${a.engineLabel(step.model)}.`
            : cur.kind === "question" ? "Pick a response, then review the planning estimate below."
            : cur.kind === "planning" ? "Atomik is working out what to render."
            : cur.kind === "done" ? `${done.length} ${done.length === 1 ? "take" : "takes"} on the grid; approve them there.`
            : "Ask below, or open a project and Atomik plans it from there."}
        </span>
        {step && (
          <>
            <button type="button" onClick={() => a.approve(step)} disabled={a.busy} data-continue=""
              className="flex h-[52px] w-full items-center justify-between rounded-mobile bg-ink px-[16px] text-[15px] font-semibold leading-none text-ground disabled:opacity-60">
              Continue<span className="ui-mono ui-mono-cost text-on-primary-cost">{a.fmt(a.credits(step))}</span>
            </button>
            <span className="flex gap-[8px]">
              <button type="button" className={`${secondary} text-ink`} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setEngineMenu({ x: r.left, y: Math.max(16, r.top - 266), step }); }}>Change engine</button>
              <button type="button" className={`${secondary} text-ink-body`} onClick={() => a.stop(step)} disabled={a.busy}>Stop here</button>
            </span>
            <Mono className="text-center">{a.fmt(spent)} of {a.fmt(a.totals.total)}{a.totals.planning ? ` · planning ${a.fmt(a.totals.planning)}` : ""}</Mono>
          </>
        )}
        {cur.kind === "question" && (
          <span className="flex flex-col gap-[8px]">
            {cur.ask.options.map((o) => <button key={o} type="button" onClick={() => a.setDraftText(o)} disabled={a.busy} className={`${secondary} text-ink`}>{o}</button>)}
          </span>
        )}
      </div>
      {engineMenu && <Menu x={engineMenu.x} y={engineMenu.y} title="Engine" items={a.engines.filter((e) => e.kind === engineMenu.step.kind).map((e): MenuItem => ({ kind: "item", label: e.label, onSelect: () => a.changeEngine(engineMenu.step, e.id) }))} onClose={() => setEngineMenu(null)} />}
    </Sheet>
  );
}

/** The header's Atomik button on a phone (M1–M3): a 44px pill, the ring at 14, `Atomik`, the state word beside it. */
export function AtomikPhoneButton() {
  const { ring, word } = useAtomik();
  const rail = useAtomikRail();
  return (
    <button type="button" onClick={rail.toggle} aria-label="Ask Atomik" aria-expanded={rail.open}
      className={`flex h-[44px] items-center gap-[6px] rounded-pill border px-[12px] text-[12.5px] font-medium leading-none text-ink ${rail.open ? "border-[rgba(245,246,248,.35)] bg-selected" : "border-border-mid"}`}>
      {"steps" in ring && ring.steps ? <Ring steps={ring.steps} size={14} /> : <Ring mode={"mode" in ring && ring.mode ? ring.mode : "idle"} size={14} />}
      Atomik{word && <Mono cost>{word}</Mono>}
    </button>
  );
}
