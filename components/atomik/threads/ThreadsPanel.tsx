"use client";

import { useEffect, useId } from "react";
import { ProjectProvider, useProject } from "@/lib/projectContext";
import { AtomikProvider, useAtomik } from "../AtomikProvider";
import { ChatComposer } from "../ChatComposer";
import { Mono } from "@/components/ui";
import { keyStepInputsLine } from "@/lib/atomikKeySteps";
import ThreadSwitcher from "./ThreadSwitcher";
import styles from "./threads.module.css";

/**
 * Atomik's threads on the Suites Agent page (Atomik › Agent): the same
 * conversations the legacy shell's rail and phone sheet show
 * (components/atomik/AtomikProvider.tsx), for this project's production.
 *
 * The list switches between them, starts one, renames and archives; the
 * thread on screen shows its conversation, its plan with each step's price,
 * and its checkpoint: Continue approves that one step at the price shown,
 * quoted live by the route that will run it, and nothing else runs. The ask
 * below is quoted before it is sent, as everywhere in Atomik.
 */
export default function ThreadsPanel({ productionId }: { productionId: string }) {
  return (
    <ProjectProvider>
      <AtomikProvider>
        <Threads productionId={productionId} />
      </AtomikProvider>
    </ProjectProvider>
  );
}

function Threads({ productionId }: { productionId: string }) {
  const { selection, setSelection, current, projects } = useProject();
  const headingId = useId();
  /* The threads are the production's: this tab's project choice follows the page, as Skills' runs do. */
  useEffect(() => { if (selection !== productionId) setSelection(productionId); }, [selection, setSelection, productionId]);
  const ready = current?.id === productionId;
  const missing = !ready && projects.length > 0 && !projects.some((p) => p.id === productionId);
  return (
    <section className={styles.page} aria-labelledby={headingId} data-testid="atomik-threads-panel">
      <div className={styles.pageHead}>
        <h2 className={styles.pageTitle} id={headingId}>Atomik threads</h2>
        <p className={styles.quiet}>Several conversations on this project, each with its own plan. Memory and the project&apos;s settings are shared; every paid step still waits for its own price and your Continue.</p>
      </div>
      {ready ? (
        <>
          <ThreadSwitcher placement="page" />
          <ThreadView />
        </>
      ) : missing ? (
        <p className={styles.quiet} role="status">This project&apos;s production is not in your list, so its threads cannot be opened here.</p>
      ) : (
        <p className={styles.quiet} role="status">Opening this project&apos;s threads…</p>
      )}
    </section>
  );
}

const STATUS: Record<string, string> = { proposed: "waiting", running: "running", done: "done", failed: "did not run", rejected: "stopped" };

function ThreadView() {
  const a = useAtomik();
  const c = a.current;
  const t = a.threads;
  const checkpoint = c.kind === "checkpoint" ? c.step : null;
  const inputs = checkpoint ? keyStepInputsLine(checkpoint) : null;
  const number = t.active?.number;
  return (
    <div className={styles.view} data-testid="atomik-thread-view" data-thread-id={t.activeId ?? ""}>
      <Mono tone="ink">{t.activeId ? `${number ? `Thread ${number}` : "Thread"} · ${t.active?.title ?? a.chat?.title ?? ""}` : "New thread"}</Mono>
      {a.messages.length ? (
        <ol className={styles.messages} aria-label="Conversation">
          {a.messages.map((m) => (
            <li key={m.id} className={styles.message} data-role={m.role}>
              <Mono>{m.role === "user" ? "You" : "Atomik"}</Mono>
              <span className={styles.messageText}>{m.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.quiet}>{t.activeId ? "Nothing has been asked in this thread yet." : "Ask Atomik below; your first ask starts the thread and names it until you rename it."}</p>
      )}
      {c.kind === "planning" ? <p className={styles.quiet} role="status">Atomik is planning in this thread…</p> : null}
      {a.plan.length ? (
        <div className={styles.planBox}>
          <Mono>
            Plan · {a.plan.length} {a.plan.length === 1 ? "step" : "steps"} · {a.fmt(a.totals.total)} total
            {a.totals.unpriced ? ` + ${a.totals.unpriced} at checkpoint` : ""} · planning {a.fmt(a.totals.planning)}
          </Mono>
          <ol className={styles.plan} aria-label="Plan">
            {a.plan.map((s, i) => (
              <li key={s.id} className={styles.step} data-testid="atomik-thread-step" data-status={s.status} data-checkpoint={checkpoint?.id === s.id ? "" : undefined}>
                <Mono>{String(i + 1).padStart(2, "0")}</Mono>
                <span className={styles.stepBody}>
                  <span className={styles.stepTitle}>{s.title}</span>
                  <Mono>{a.engineLabel(s.model)} · {checkpoint?.id === s.id ? "checkpoint" : STATUS[s.status] ?? s.status}</Mono>
                </span>
                <Mono cost tone="ink" className={styles.price}>{a.priceLabel(s)}</Mono>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {checkpoint ? (
        <div className={styles.checkpoint} role="group" aria-label="Checkpoint" data-testid="atomik-thread-checkpoint">
          <Mono>Checkpoint · stopped</Mono>
          <span className={styles.checkpointLine}>Next: {checkpoint.title} on {a.engineLabel(checkpoint.model)}. Continue approves this step at the price shown; nothing else runs.{inputs ? ` ${inputs}` : ""}</span>
          <span className={styles.actions}>
            <button type="button" className={styles.primary} disabled={a.busy || !a.approvable(checkpoint)} onClick={() => void a.approve(checkpoint)} data-testid="atomik-thread-continue">
              {a.busy ? "Starting…" : `Continue · ${a.priceLabel(checkpoint)}`}
            </button>
            <button type="button" className={styles.button} disabled={a.busy} onClick={() => void a.stop(checkpoint)}>Stop here</button>
          </span>
          {a.stepQuoteError ? <p className={styles.problem} role="alert">{a.stepQuoteError}</p> : null}
        </div>
      ) : null}
      {c.kind === "question" ? (
        <div className={styles.checkpoint} role="group" aria-label="Question">
          <Mono>Question</Mono>
          <span className={styles.checkpointLine}>{c.ask.question}</span>
          <span className={styles.actions}>
            {c.ask.options.map((o) => <button key={o} type="button" className={styles.button} disabled={a.busy || !!a.recoveryText} onClick={() => a.setDraftText(o)}>{o}</button>)}
          </span>
        </div>
      ) : null}
      {c.kind === "done" ? (
        <p className={styles.quiet} role="status">{c.failed.length ? `${c.failed.length} did not run; the rest are in the project.` : "Every step ran and filed to the project."}</p>
      ) : null}
      {a.error ? <p className={styles.problem} role="alert">{a.error}</p> : null}
      <div className={styles.composer}><ChatComposer inputHeight={46} /></div>
    </div>
  );
}
