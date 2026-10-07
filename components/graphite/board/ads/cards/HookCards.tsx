"use client";
import { useEffect, useState } from "react";
import { Price } from "@/components/graphite/Price";
import { upTo } from "@/lib/shell/price-words";
import { OWN_LIMITS, hooksRequest } from "@/lib/shell/business-own";
import { briefOf } from "../../../business/own-kit";
import { useBoard } from "../../BoardContext";
import type { CardProps } from "../../cards/types";
import type { FormatsData, HooksData } from "../ads-model";
import { useAdsActions } from "../use-ads-actions";
import { Actions, Btn, Meta, Note, Title } from "./common";

/* Frame 2 of the Ads board: the Hooks card and the Format briefs card (the group "Hooks and formats"). */

const SHOWN = 5;

/**
 * The free estimate for the Campaign agent writing `count` more lines: the same quote the run dialog asks for
 * (`quoteOnly`: nothing is reserved or sent). Null until it is known; never a guess.
 */
function useHooksEstimate(count: number, enabled: boolean): number | null {
  const { scope, project, rig } = useBoard();
  const [answer, setAnswer] = useState<{ key: string; credits: number } | null>(null);
  const request = `[moleculr] ${hooksRequest(briefOf(project), count)}`;
  const key = JSON.stringify([project.id, request]);
  useEffect(() => {
    if (!enabled || count < 1) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!(await rig.save())) return;
          const response = await fetch("/api/workbench/atomik", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, signal: abort.signal,
            body: JSON.stringify({ suite: "moleculr", projectId: project.id, request, role: "marketing", model: "auto", effort: "auto", depth: "Considered", refs: [], requestId: crypto.randomUUID(), quoteOnly: true }),
          });
          const data = await response.json().catch(() => null) as { estimateCredits?: number } | null;
          if (response.ok && typeof data?.estimateCredits === "number" && !abort.signal.aborted) setAnswer({ key, credits: data.estimateCredits });
        } catch { /* no price on the button; the dialog quotes again */ }
      })();
    }, 700);
    return () => { clearTimeout(timer); abort.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, count, key, scope]);
  return answer?.key === key ? answer.credits : null;
}

export function HooksCard({ data }: CardProps<HooksData>) {
  const act = useAdsActions();
  const credits = useHooksEstimate(data.room, data.agentReady && data.agentConfigured && !data.writing);
  const price = upTo(credits);
  const more = data.lines.length - SHOWN;
  return (
    <article className="bd-card ab-card" data-testid="ads-hooks">
      <span className="ab-body ab-body--fill">
        <Title>Hooks · {data.lines.length} opening {data.lines.length === 1 ? "line" : "lines"}</Title>
        <Meta>Written against the brief</Meta>
        <ol className="ab-hooks nowheel">
          {data.lines.slice(0, SHOWN).map((line) => (
            <li key={line} className="ab-hook">
              <span className="ab-hook-line">{line}</span>
              <Btn aria-pressed={data.picked.includes(line)} onClick={() => act.pick(line)} aria-label={`Pick “${line}” for the next brief sent to Make`} className="ab-hook-pick">pick</Btn>
            </li>
          ))}
          {!data.lines.length ? <li className="ab-hook"><span className="ab-hook-line ab-quiet">No hooks yet. Write them, or have the agent write them.</span></li> : null}
          {more > 0 ? <li className="ab-hook"><span className="ab-hook-line">and {more} more</span></li> : null}
        </ol>
        {data.proposed.length ? (
          <span className="ab-proposed" data-testid="ads-hooks-proposed">
            <Meta>{data.proposed.length} {data.proposed.length === 1 ? "line" : "lines"} proposed by the agent</Meta>
            <Btn primary onClick={() => act.addHooks(data.proposed)} data-testid="ads-hooks-add">Add {data.proposed.length} {data.proposed.length === 1 ? "hook" : "hooks"}</Btn>
          </span>
        ) : null}
        {data.agentError ? <Note tone="bad" role="alert">{data.agentError}</Note> : null}
        <Actions>
          {data.room > 0 ? (
            <Btn primary={!data.proposed.length} disabled={data.writing || (data.agentReady && !data.agentConfigured)} onClick={() => act.openDialog("hooks")} data-testid="ads-hooks-write"
              title={data.agentReady && !data.agentConfigured ? "No priced thinking model is set up for this workspace." : undefined}>
              {data.writing ? "Writing…" : <>Write {data.room} more{price ? <> · <Price value={price} /></> : null}</>}
            </Btn>
          ) : <Meta>Twelve is the most a campaign keeps ({OWN_LIMITS.hooks}).</Meta>}
          <Btn onClick={() => act.edit("hooks")} data-testid="ads-hooks-edit">Edit</Btn>
        </Actions>
      </span>
    </article>
  );
}

export function FormatsCard({ data }: CardProps<FormatsData>) {
  const act = useAdsActions();
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const count = data.formats.reduce((n, f) => n + f.briefs.length, 0);
  return (
    <article className="bd-card ab-card" data-testid="ads-formats">
      <span className="ab-body ab-body--fill">
        <Title>Format briefs · {data.formats.length} formats · {count} briefs</Title>
        <Meta>Made in Make, one tap</Meta>
        <ul className="ab-formats nowheel">
          {data.formats.map((f) => (
            <li key={f.id}>
              <button type="button" className="ab-format nodrag nopan" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)} data-testid={`ads-format-${f.id}`}>
                <span>{f.label}</span><span className="ab-mono">{f.briefs.length} briefs</span>
              </button>
              {open === f.id ? (
                <ul className="ab-briefs">
                  {f.briefs.map((b) => (
                    <li key={b.id} className="ab-brief">
                      <span className="ab-brief-name">{b.name}<span className="ab-mono"> · {b.kind === "video" ? "video" : "image"} · {b.aspect}</span></span>
                      <Btn primary={data.chosen === b.id} onClick={() => setProblem(act.makeInMake(b.id))} data-testid={`ads-make-${b.id}`}>Make in Make</Btn>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        {problem ? <Note tone="bad" role="alert">{problem}</Note> : null}
        <Actions><Btn onClick={() => act.edit("formats")} data-testid="ads-formats-edit">Edit</Btn></Actions>
      </span>
    </article>
  );
}
