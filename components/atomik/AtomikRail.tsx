"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useAtomikRail } from "@/lib/atomikRail";
import { useProject } from "@/lib/projectContext";
import type { Step } from "@/lib/atomik";
import Ring from "./Ring";
import { MessageLoader } from "./Loader";
import { useAtomik } from "./AtomikProvider";
import { Rail, Chip, Button, Mono, RAIL_WIDTHS } from "@/components/ui";

/**
 * The Atomik rail (design/particl-v2/README.md §5; board 10a), value for
 * value.
 *
 * Compact — 300. Header 52: the ring at 18 in its live state, `Atomik`
 * (600 14px), `Expand ⇤` (30px, .14 border, radius 8, 500 12px, the arrow
 * in mono muted), `×` (30×30). Body: the context chip (mono pill, .14), and
 * ONE card — `--card`, a 1px edge at .3, radius 12, 14px padding, 10px
 * apart: a mono eyebrow, a 600 16/1.25 title, a 400 13.5/1.45 line in
 * `--ink-body`, the one filled button (44px, radius 10, `Continue · 24 CR`)
 * and the pair beneath it (36px, radius 9: `Change engine` / `Stop`).
 * Footer: `Ask Atomik…` (44px, `--card`, .12, radius 10) and `↑` (44×44).
 *
 * Expanded — 420. The header adds `PRODUCTION AGENT` and swaps Expand for
 * `Compact ⇥`. A chip strip (`12px 16px 0`) with the context chip and its
 * `×`; the body scrolls (`14px 16px 12px`, 12 apart): the conversation —
 * `WHO` in mono over a bubble, radius 12, `10px 12px`, 400 13.5/1.45, 340
 * wide at most; yours ink-filled on the right, Atomik's `--card` with a .1
 * edge on the left — then the plan: an eyebrow, and a `--card` card with a
 * .12 edge whose rows are 46px on a `22px 1fr auto` grid — number · stage
 * `· scope` · engine · cost — the first row on .04, and a 30px
 * `CHECKPOINT · YOU ARE HERE` row with an 8px dot in a 2px accent ring
 * where the run stands. Pinned beneath (`10px 16px 8px`): one mono line,
 * `95 CR TOTAL · 77 UNDER CAP · PLANNING 3 CR`, the figures in ink, then
 * the filled button (46px, radius 12, `Continue · keyframes · 24 CR`).
 * The composer below it (`8px 16px 16px`): the field at 46, radius 12,
 * 400 14px; `↑` at 46×46.
 *
 * Nothing of this renders while the rail is closed (§5).
 */
export default function AtomikRail() {
  const rail = useAtomikRail();
  if (!rail.open) return null;
  return rail.state === "expanded" ? <Expanded /> : <Compact />;
}

function Head({ wide }: { wide: boolean }) {
  const { ring } = useAtomik();
  const rail = useAtomikRail();
  const btn = "flex h-[30px] items-center gap-[6px] rounded-ctl border border-border-mid bg-transparent px-[9px] text-[12px] font-medium leading-none text-ink";
  return (
    <>
      {"steps" in ring ? <Ring steps={ring.steps} size={18} /> : <Ring mode={ring.mode} size={18} />}
      <span className="text-[14px] font-semibold leading-none text-ink">Atomik</span>
      {wide && <Mono>Production agent</Mono>}
      <button type="button" onClick={wide ? rail.compact : rail.expand} className={`ml-auto ${btn}`}>
        {wide ? "Compact" : "Expand"}<span className="ui-mono tracking-normal text-ink-muted">{wide ? "⇥" : "⇤"}</span>
      </button>
      <button type="button" onClick={rail.close} aria-label="Close Atomik"
        className="flex h-[30px] w-[30px] items-center justify-center rounded-ctl border border-border-mid bg-transparent text-[14px] font-normal leading-none text-ink">×</button>
    </>
  );
}

/** `30S HERO · RUN 02 · 3 OF 8` — the production and the conversation, in mono. */
function ContextChip({ dismiss }: { dismiss?: () => void }) {
  const { chat, plan } = useAtomik();
  const { current: production } = useProject();
  if (!production && !chat) return null;
  const done = plan.filter((s) => s.status === "done").length;
  const parts = [production?.code || production?.name, chat?.title, plan.length ? `${done} of ${plan.length}` : null].filter(Boolean);
  return (
    <Chip variant="mono" className="self-start">
      {parts.join(" · ")}
      {dismiss && chat && (
        <button type="button" onClick={dismiss} aria-label="Clear the conversation" className="text-[12px] leading-none text-ink-muted">×</button>
      )}
    </Chip>
  );
}

/** The one card: what is happening and the one button that moves it. */
function CurrentCard({ placement }: { placement: "card" | "rail" }) {
  const a = useAtomik();
  const { current: production } = useProject();
  const c = a.current;
  const [picking, setPicking] = useState(false);
  const box = "flex flex-col gap-[10px] rounded-card border border-[rgba(245,246,248,.3)] bg-card p-[14px]";
  const title = "text-[16px] font-semibold leading-[1.25] text-ink";
  const body = "text-[13.5px] leading-[1.45] text-ink-body";

  if (c.kind === "planning") {
    return (
      <div className={box}>
        <MessageLoader after={0} title="Planning">Planning · {a.fmt(a.totals.planning)}</MessageLoader>
      </div>
    );
  }
  if (c.kind === "checkpoint") {
    const step = c.step;
    const cost = a.credits(step);
    const lastDone = c.done[c.done.length - 1];
    const sameKind = a.engines.filter((e) => e.kind === step.kind);
    return (
      <div className={box}>
        <Mono>Checkpoint · stopped</Mono>
        <span className={title}>{lastDone ? `${lastDone.title} done` : "Ready"} · {a.fmt(c.spentCredits)} spent.</span>
        <span className={body}>Next: {step.title} on {a.engineLabel(step.model)}. {firstSentence(step.prompt)}</span>
        {picking ? (
          <span className="flex flex-col gap-[6px]">
            {sameKind.map((e) => (
              <Button key={e.id} placement="card" muted={e.id !== step.model} onClick={() => { setPicking(false); a.changeEngine(step, e.id); }}>{e.label}</Button>
            ))}
            <Button placement="card" muted onClick={() => setPicking(false)}>Keep {a.engineLabel(step.model)}</Button>
          </span>
        ) : (
          <>
            <Button variant="primary" placement={placement} cost={cost} busy={a.busy} busyLabel="Starting…" onClick={() => a.approve(step)}>
              {placement === "rail" ? `Continue · ${step.title}` : "Continue"}
            </Button>
            <span className="flex gap-[6px]">
              <Button placement="card" className="flex-1" onClick={() => setPicking(true)}>Change engine</Button>
              <Button placement="card" className="flex-1" muted onClick={() => a.stop(step)}>Stop</Button>
            </span>
          </>
        )}
      </div>
    );
  }
  if (c.kind === "question") {
    return (
      <div className={box}>
        <Mono>Question</Mono>
        <span className={title}>{c.ask.question}</span>
        {c.message.text && <span className={body}>{c.message.text}</span>}
        <span className="flex flex-col gap-[6px]">
          {c.ask.options.map((o) => <Button key={o} placement="card" onClick={() => a.send(o)}>{o}</Button>)}
        </span>
      </div>
    );
  }
  if (c.kind === "done") {
    const needYou = c.failed.length;
    return (
      <div className={box}>
        <Mono>Done</Mono>
        <span className={title}>{c.steps.length} steps · {a.fmt(c.spentCredits)}.</span>
        <span className={body}>{needYou ? `${needYou} did not run.` : "Every step ran and filed to the production."}</span>
        {production && (
          <Link href={production.productionId ? `/productions/${production.productionId}/${production.id}/shots` : "/productions"} className="flex h-[36px] items-center justify-center rounded-[9px] border border-border-mid text-[12.5px] font-medium leading-none text-ink">
            Open Approve{needYou ? ` · ${needYou} need you` : ""}
          </Link>
        )}
      </div>
    );
  }
  if (c.kind === "plan") {
    const running = c.steps.filter((s) => s.status === "running").length;
    return (
      <div className={box}>
        <Mono>{running ? "Running" : "Plan"}</Mono>
        <span className={title}>{c.steps.length} steps · {a.fmt(a.totals.total)}.</span>
        <span className={body}>{running ? `${running} rendering now.` : "Priced. Nothing is charged until you run a step."}</span>
      </div>
    );
  }
  return (
    <div className={box}>
      <Mono>Atomik</Mono>
      <span className={title}>{production ? `What next on ${production.name}?` : "Ask Atomik"}</span>
      <span className={body}>Plans are priced before anything runs, and every step that spends stops for you.</span>
    </div>
  );
}

function Composer({ tall }: { tall: boolean }) {
  const a = useAtomik();
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text; setText(""); a.send(t); };
  const h = tall ? "h-[46px] rounded-card" : "h-[44px] rounded-tile";
  return (
    <form onSubmit={submit} className="flex flex-1 gap-[8px]">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Atomik…" aria-label="Ask Atomik" disabled={a.busy}
        className={`min-w-0 flex-1 border border-[rgba(245,246,248,.12)] bg-card px-[12px] font-normal leading-none text-ink placeholder:text-ink-muted ${h} ${tall ? "text-[14px]" : "text-[13.5px]"}`} />
      <button type="submit" aria-label="Send" disabled={a.busy || !text.trim()}
        className={`flex flex-none items-center justify-center border border-border-mid font-medium leading-none text-ink ${tall ? "h-[46px] w-[46px] rounded-card text-[16px]" : "h-[44px] w-[44px] rounded-tile text-[15px]"}`}>↑</button>
    </form>
  );
}

function Compact() {
  const a = useAtomik();
  return (
    <Rail width={RAIL_WIDTHS.compact} label="Atomik" header={<Head wide={false} />} footer={<Composer tall={false} />}>
      <ContextChip />
      <CurrentCard placement="card" />
      {a.error && <span className="text-[12.5px] leading-[1.45] text-ink-body">{a.error}</span>}
    </Rail>
  );
}

function Expanded() {
  const a = useAtomik();
  const c = a.current;
  const checkpoint = c.kind === "checkpoint" ? c.step : null;
  const footer = (
    <>
      <Mono className="whitespace-nowrap">
        <span className="text-ink">{a.fmt(a.totals.total)}</span> total
        {a.totals.underCap !== null && <> · {a.fmt(a.totals.underCap)} under cap</>}
        {" · "}planning <span className="text-ink">{a.fmt(a.totals.planning)}</span>
      </Mono>
      {checkpoint && (
        <Button variant="primary" placement="rail" cost={a.credits(checkpoint)} busy={a.busy} busyLabel="Starting…" onClick={() => a.approve(checkpoint)}>
          Continue · {checkpoint.title}
        </Button>
      )}
      <div className="flex gap-[8px] pt-[8px]"><Composer tall /></div>
    </>
  );
  return (
    <Rail width={RAIL_WIDTHS.expanded} label="Atomik" header={<Head wide />} footer={footer}>
      <ContextChip dismiss={a.clear} />
      {a.messages.map((m) => (
        <div key={m.id} className={`flex flex-col gap-[6px] ${m.role === "user" ? "items-end" : "items-start"}`}>
          <Mono>{m.role === "user" ? "You" : "Atomik"}</Mono>
          <span className={`max-w-[340px] rounded-card px-[12px] py-[10px] text-[13.5px] leading-[1.45] ${
            m.role === "user" ? "bg-ink text-ground" : "border border-[rgba(245,246,248,.1)] bg-card text-ink"}`} style={{ textWrap: "pretty" }}>
            {m.text}
          </span>
        </div>
      ))}
      {c.kind === "planning" && <CurrentCard placement="rail" />}
      {c.kind === "question" && <CurrentCard placement="rail" />}
      {a.plan.length > 0 && <PlanCard steps={a.plan} checkpoint={checkpoint} />}
      {a.error && <span className="text-[12.5px] leading-[1.45] text-ink-body">{a.error}</span>}
    </Rail>
  );
}

function PlanCard({ steps, checkpoint }: { steps: Step[]; checkpoint: Step | null }) {
  const a = useAtomik();
  const paid = steps.filter((s) => a.credits(s) > 0).length;
  return (
    <div className="flex flex-col gap-[6px]">
      <Mono>Atomik · {a.chat?.title ?? "plan"} · {paid} paid {paid === 1 ? "step" : "steps"}</Mono>
      <div className="overflow-hidden rounded-card border border-[rgba(245,246,248,.12)] bg-card">
        {steps.map((s, i) => (
          <Row key={s.id} n={i + 1} first={i === 0} step={s} checkpoint={checkpoint?.id === s.id} />
        ))}
      </div>
    </div>
  );
}

function Row({ n, first, step, checkpoint }: { n: number; first: boolean; step: Step; checkpoint: boolean }) {
  const a = useAtomik();
  const scope = [step.kind, step.params.seconds ? `${step.params.seconds}s` : null, step.params.resolution].filter(Boolean).join(" · ");
  return (
    <>
      <div className={`grid h-[46px] grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-[10px] border-b border-hairline px-[12px] ${first ? "bg-[rgba(245,246,248,.04)]" : ""}`}>
        <Mono cost>{String(n).padStart(2, "0")}</Mono>
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="truncate text-[13px] font-medium leading-[1.2] text-ink">{step.title} <span className="font-normal text-ink-body">· {scope}</span></span>
          <Mono>{a.engineLabel(step.model)}</Mono>
        </span>
        <Mono cost tone="ink">{a.fmt(a.credits(step))}</Mono>
      </div>
      {checkpoint && (
        <div className="flex h-[30px] items-center gap-[8px] whitespace-nowrap border-b border-hairline px-[12px]">
          <span aria-hidden="true" className="block h-[8px] w-[8px] flex-none rounded-full border-2 border-accent" />
          <Mono tone="ink">Checkpoint · you are here</Mono>
        </div>
      )}
    </>
  );
}

function firstSentence(text: string): ReactNode {
  const m = text.trim().match(/^[^.!?]{1,140}[.!?]?/);
  return m ? m[0] : "";
}
