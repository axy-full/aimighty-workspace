"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { useAtomikRail, setAtomikRail } from "@/lib/atomikRail";
import { useProject } from "@/lib/projectContext";
import Ring from "@/components/atomik/Ring";
import { Mono, Sheet } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import type { Step } from "@/lib/atomik";

/**
 * Atomik on a phone (design/particl-v2/README.md §14; board 9c): the
 * checkpoint as a sheet, and nothing else in it.
 *
 * Board 9c, value for value: the sheet (`--card`, a .14 rule on top, radius
 * 24 above, `0 20px 28px` with the grabber at `10px 0 18px`); the ring at
 * 88; the eyebrow `ATOMIK · CHECKPOINT · HANDBAG TVC` 18 down; the 26/1.15
 * headline 10 down (`Boards done.` / `12 cr spent.`); one sentence at
 * 15/1.45 12 down; the `NEXT STEP · 24 cr` row 18 down on .08 rules
 * (`12px 0`; the figure at 600 22, `cr` at 400 14); `Continue · 24 CR`
 * (54px, radius 14, `0 18px`, 600 16) 18 down; `Change engine` / `Stop
 * here` (46px, radius 12, .16) 8 down; and `19 OF 253 CR · PLANNING 3 CR`
 * 14 down. Every target is at least 44pt.
 *
 * The same store drives it as the desktop rail (§5): ⌘J, the header's
 * ring, and a checkpoint arriving all open it. A question shows its
 * options as 46px buttons; with nothing to decide it says so and closes —
 * planning is a desktop's work (SOW rule 7).
 */
export default function AtomikSheet() {
  const a = useAtomik();
  const rail = useAtomikRail();
  const { current } = useProject();
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number; step: Step } | null>(null);
  /* A checkpoint or a question arriving opens the sheet once. */
  const seen = useRef<string | null>(null);
  const cur = a.current;
  useEffect(() => {
    const key = cur.kind === "checkpoint" ? `c:${cur.step.id}` : cur.kind === "question" ? `q:${cur.message.id}` : null;
    if (key && seen.current !== key) { seen.current = key; setAtomikRail("compact"); }
  }, [cur]);
  const close = () => setAtomikRail("closed");
  const title = a.chat?.title ?? current?.name ?? null;
  const step: Step | null = cur.kind === "checkpoint" ? cur.step : cur.kind === "plan" ? (cur.steps.find((s) => s.status === "proposed") ?? null) : null;
  const done = cur.kind === "checkpoint" ? cur.done : cur.kind === "done" ? cur.steps : [];
  const spent = cur.kind === "checkpoint" || cur.kind === "done" ? cur.spentCredits : 0;
  const eyebrow = `Atomik · ${cur.kind === "checkpoint" || (cur.kind === "plan" && step) ? "checkpoint" : cur.kind === "question" ? "question" : cur.kind === "planning" ? "planning" : cur.kind === "done" ? "done" : "idle"}${title ? ` · ${title}` : ""}`;
  const secondary = "tap44 flex h-[46px] flex-1 items-center justify-center rounded-card border border-[rgba(245,246,248,.16)] text-[14px] font-medium leading-none";

  return (
    <Sheet open={rail.open} onClose={close} label="Atomik">
      {"steps" in a.ring && a.ring.steps ? <Ring steps={a.ring.steps} size={88} /> : <Ring mode={"mode" in a.ring && a.ring.mode ? a.ring.mode : "idle"} size={88} />}
      <Mono className="mt-[18px] block">{eyebrow}</Mono>
      <span className="mt-[10px] block text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink" data-headline="">
        {step ? <>{done.length ? `${done[done.length - 1].title} done.` : "Ready."}<br />{a.fmt(spent)} spent.</>
          : cur.kind === "question" ? cur.ask.question
          : cur.kind === "planning" ? "Planning."
          : cur.kind === "done" ? <>Done.<br />{a.fmt(spent)} spent.</>
          : "Nothing needs you."}
      </span>
      <span className="mt-[12px] block text-[15px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>
        {step ? `Next: ${step.title.toLowerCase()} on ${a.engineLabel(step.model)}.`
          : cur.kind === "question" ? "Pick one and Atomik carries on."
          : cur.kind === "planning" ? "Atomik is working out what to render. A checkpoint comes here as a sheet."
          : cur.kind === "done" ? `${done.length} ${done.length === 1 ? "take" : "takes"} on the grid; approve them there.`
          : "Ask Atomik from a desktop to plan a production; a checkpoint comes here as a sheet."}
      </span>
      {step && (
        <>
          <span className="mt-[18px] flex items-baseline justify-between border-y border-border py-[12px]">
            <Mono>Next step</Mono>
            <span className="text-[22px] font-semibold leading-none text-ink">{a.fmt(a.credits(step)).replace(/\s*cr$/i, "")} {/cr$/i.test(a.fmt(a.credits(step))) && <span className="text-[14px] font-normal text-ink-body">cr</span>}</span>
          </span>
          <button type="button" onClick={() => a.approve(step)} disabled={a.busy} data-continue=""
            className="mt-[18px] flex h-[54px] w-full items-center justify-between rounded-mobile bg-ink px-[18px] text-[16px] font-semibold leading-none text-ground disabled:opacity-60">
            Continue<span className="ui-mono ui-mono-cost !text-[12px] text-on-primary-cost">{a.fmt(a.credits(step))}</span>
          </button>
          <span className="mt-[8px] flex gap-[8px]">
            <button type="button" className={`${secondary} text-ink`} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setEngineMenu({ x: r.left, y: r.top - 6 - 260, step }); }}>Change engine</button>
            <button type="button" className={`${secondary} text-ink-body`} onClick={() => a.stop(step)} disabled={a.busy}>Stop here</button>
          </span>
          <Mono className="mt-[14px] block text-center !leading-[1.5]">{a.fmt(spent)} of {a.fmt(a.totals.total)}{a.totals.planning ? ` · planning ${a.fmt(a.totals.planning)}` : ""}</Mono>
        </>
      )}
      {cur.kind === "question" && (
        <span className="mt-[18px] flex flex-col gap-[8px]">
          {cur.ask.options.map((o) => <button key={o} type="button" onClick={() => a.send(o)} disabled={a.busy} className={`${secondary} text-ink`}>{o}</button>)}
        </span>
      )}
      {!step && cur.kind !== "question" && (
        <button type="button" onClick={close} className={`${secondary} mt-[18px] w-full text-ink`}>Close</button>
      )}
      {engineMenu && <Menu x={engineMenu.x} y={Math.max(16, engineMenu.y)} title="Engine" items={a.engines.filter((e) => e.kind === engineMenu.step.kind).map((e): MenuItem => ({ kind: "item", label: e.label, onSelect: () => a.changeEngine(engineMenu.step, e.id) }))} onClose={() => setEngineMenu(null)} />}
    </Sheet>
  );
}

/** The header's ring on a phone: 36px, opens the sheet; the word beside it when Atomik is waiting. */
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
