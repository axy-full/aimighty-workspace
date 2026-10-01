"use client";

import { useId, useState, type FormEvent } from "react";
import { useAtomik } from "../AtomikProvider";
import { Mono } from "@/components/ui";
import { ARCHIVED_NOTE, THREAD_LIMITS, THREAD_STATE_LABEL, lastActivity, startedBy, type Thread } from "@/lib/atomikThreadsText";
import styles from "./threads.module.css";

/**
 * A production's Atomik threads (lib/atomikThreads.ts), wherever Atomik is:
 * the desktop rail and the phone sheet (a `Threads` row that opens the list),
 * and the Suites Agent page (the list, always open).
 *
 * Each row is one thread: its number in the project, its title (its first ask
 * until it is named), who started it, where it stands and when it last moved.
 * Picking one shows it; New thread starts one with the next ask. The thread
 * on screen can be renamed or archived. Archived threads are listed apart,
 * with who archived them, and Restore brings one back as it was. Any member
 * may do any of it, and none of it spends: archiving hides, it never deletes.
 */
export default function ThreadSwitcher({ placement }: { placement: "rail" | "sheet" | "page" }) {
  const a = useAtomik();
  const t = a.threads;
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const listId = useId();
  if (!a.hosted) return null;
  const shown = placement === "page" || open;
  const count = t.list?.length ?? null;
  const number = t.active?.number ?? null;
  const title = t.active?.title ?? a.chat?.title ?? null;
  const act = async (work: Promise<string | null>) => {
    setProblem(null);
    const said = await work;
    if (said) setProblem(said);
    return !said;
  };

  return (
    <div className={styles.threads} data-placement={placement} data-testid="atomik-threads">
      {placement === "page" ? (
        <div className={styles.bar}>
          <span className={styles.heading}>Threads{count !== null ? <Mono className={styles.count}>{count}</Mono> : null}</span>
          <button type="button" className={styles.button} onClick={() => { setProblem(null); t.start(); }} disabled={!t.activeId} data-testid="atomik-thread-new">New thread</button>
        </div>
      ) : (
        <div className={styles.bar}>
          <button type="button" className={`${styles.button} ${styles.toggle}`} aria-expanded={open} aria-controls={listId} data-testid="atomik-threads-toggle"
            onClick={() => { if (!open) t.refresh(); setOpen(!open); setProblem(null); }}>
            <Mono tone="ink">{t.activeId ? (number ? `Thread ${number}` : "Thread") : "New thread"}</Mono>
            {t.activeId && title ? <span className={styles.toggleTitle}>{title}</span> : null}
            <Mono className={styles.count}>{count === null ? "" : `${count} ${count === 1 ? "thread" : "threads"}`}</Mono>
          </button>
          <button type="button" className={styles.button} onClick={() => { setProblem(null); setOpen(false); t.start(); }} disabled={!t.activeId} data-testid="atomik-thread-new">New</button>
        </div>
      )}
      {t.archived ? (
        <div className={styles.note} role="status" data-testid="atomik-thread-archived">
          <span>{ARCHIVED_NOTE}</span>
          {t.activeId ? <button type="button" className={styles.button} disabled={t.busy} onClick={() => void act(t.restore(t.activeId!))}>Restore</button> : null}
        </div>
      ) : null}
      {problem ? <p className={styles.problem} role="alert">{problem}</p> : null}
      {shown ? <ThreadList id={listId} onPicked={() => { if (placement !== "page") setOpen(false); }} act={act} /> : null}
    </div>
  );
}

function ThreadList({ id, onPicked, act }: { id: string; onPicked: () => void; act: (work: Promise<string | null>) => Promise<boolean> }) {
  const a = useAtomik();
  const t = a.threads;
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const archivedOpen = t.archivedList.open;
  const save = async (event: FormEvent, thread: Thread) => {
    event.preventDefault();
    if (!renaming) return;
    if (await act(t.rename(thread.id, renaming.text))) setRenaming(null);
  };

  return (
    <div id={id} className={styles.panel}>
      {t.error ? (
        <div className={styles.note} role="alert" data-testid="atomik-threads-error">
          <span>{t.error}</span>
          <button type="button" className={styles.button} onClick={t.refresh}>Try again</button>
        </div>
      ) : t.list === null || t.loading ? (
        <p className={styles.quiet} role="status">Reading threads…</p>
      ) : !t.list.length ? (
        <p className={styles.quiet} data-testid="atomik-threads-empty">No threads yet. Ask Atomik to start one.</p>
      ) : (
        <ul className={styles.list} aria-label="Threads">
          {t.list.map((thread) => {
            const here = thread.id === t.activeId;
            const saved = t.saved.includes(thread.id);
            return (
              <li key={thread.id} className={styles.row} data-testid="atomik-thread" data-thread-id={thread.id} data-state={thread.state}>
                {renaming?.id === thread.id ? (
                  <form className={styles.rename} onSubmit={(event) => void save(event, thread)}>
                    <input className={styles.field} aria-label="Thread name" value={renaming.text} maxLength={THREAD_LIMITS.title} autoFocus
                      onChange={(event) => setRenaming({ id: thread.id, text: event.target.value })} />
                    <span className={styles.actions}>
                      <button type="submit" className={styles.button} disabled={t.busy || !renaming.text.trim()}>Save</button>
                      <button type="button" className={styles.button} onClick={() => setRenaming(null)}>Cancel</button>
                    </span>
                  </form>
                ) : (
                  <button type="button" className={styles.pick} aria-current={here ? "true" : undefined} onClick={() => { t.select(thread.id); onPicked(); }}>
                    <span className={styles.line}>
                      <Mono tone="ink">#{thread.number}</Mono>
                      <span className={styles.title}>{thread.title}</span>
                    </span>
                    <span className={styles.meta} data-testid="atomik-thread-meta">
                      Started by {startedBy(thread)} · {THREAD_STATE_LABEL[thread.state]} · {lastActivity(thread.lastActivityAt)}{saved ? " · a turn to recover" : ""}
                    </span>
                  </button>
                )}
                {here && renaming?.id !== thread.id ? (
                  <span className={styles.actions}>
                    <button type="button" className={styles.button} disabled={t.busy} onClick={() => setRenaming({ id: thread.id, text: thread.title })}>Rename</button>
                    <button type="button" className={styles.button} disabled={t.busy} onClick={() => void act(t.archive(thread.id))}>Archive</button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.bar}>
        <button type="button" className={styles.button} aria-pressed={archivedOpen} onClick={() => t.archivedList.show(!archivedOpen)} data-testid="atomik-threads-archived">
          {archivedOpen ? "Hide archived" : "Archived"}
        </button>
      </div>
      {archivedOpen ? <Archived act={act} /> : null}
    </div>
  );
}

function Archived({ act }: { act: (work: Promise<string | null>) => Promise<boolean> }) {
  const a = useAtomik();
  const t = a.threads;
  const shelf = t.archivedList;
  if (shelf.error) {
    return (
      <div className={styles.note} role="alert">
        <span>{shelf.error}</span>
        <button type="button" className={styles.button} onClick={shelf.refresh}>Try again</button>
      </div>
    );
  }
  if (!shelf.list) return <p className={styles.quiet} role="status">Reading archived threads…</p>;
  if (!shelf.list.length) return <p className={styles.quiet}>Nothing archived.</p>;
  return (
    <ul className={styles.list} aria-label="Archived threads">
      {shelf.list.map((thread) => (
        <li key={thread.id} className={styles.row} data-testid="atomik-archived-thread" data-thread-id={thread.id}>
          <span className={styles.line}>
            <Mono tone="ink">#{thread.number}</Mono>
            <span className={styles.title}>{thread.title}</span>
          </span>
          <span className={styles.meta}>
            Archived by {thread.archivedByYou ? "you" : thread.archivedByName ?? "a teammate"}{thread.archivedAt ? ` · ${lastActivity(thread.archivedAt)}` : ""}
          </span>
          <span className={styles.actions}>
            <button type="button" className={styles.button} disabled={t.busy} onClick={() => void act(t.restore(thread.id))}>Restore</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
