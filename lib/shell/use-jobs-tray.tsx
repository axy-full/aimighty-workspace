"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { poll, type Poller } from "@/lib/poll";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { parseTrayReply, trayOrder, traySummary, withComposerSlot, type TrayJob, type TrayReply, type TraySummary } from "@/lib/jobsTray";
import { onJobAnnounced } from "./jobs-bus";

/**
 * The header's jobs, read from GET /api/jobs?view=tray at lib/poll's pace and
 * the server's own (often while something runs, once a minute otherwise, not
 * at all while the tab is hidden), and at once when a job starts anywhere in
 * the app or the tray opens. The composer's just-pressed Generate shows from
 * its own slot until the read has the row. One provider per shell, so the
 * header pill, the tray and the phone Home count the same jobs.
 */
export type RowProblem = { message: string; topUp: boolean };
export type JobsTrayState = {
  status: "loading" | "ready" | "error";
  jobs: TrayJob[];
  summary: TraySummary | null;
  /** The last read failed: the rows shown are from the read before it (or there are none yet). */
  error: string | null;
  /** The connected account's jobs could not be read this time. */
  partial: boolean;
  /** Reading stopped for good (signed out, or another workspace in another tab): nothing here asks again. */
  stopped: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  refresh: () => void;
  /** Start a held take now, if the balance covers it (POST /api/jobs/:id/release). */
  release: (id: string) => Promise<boolean>;
  releasing: ReadonlySet<string>;
  problems: Readonly<Record<string, RowProblem>>;
  now: number;
};

const READ_FAILED = "Jobs could not be read. Trying again shortly.";
/* Said plainly, with no Reload: this tab may hold work the changed account cannot save. */
const READ_STOPPED = "Jobs stopped: this tab's account or workspace changed.";
const seenKey = (scope: string) => `particl:jobs-seen:${scope}`;
function readSeen(scope: string | null, now: number): number {
  if (!scope) return now;
  try {
    const raw = Number(localStorage.getItem(seenKey(scope)));
    if (Number.isFinite(raw) && raw > 0) return raw;
    /* First visit: only what finishes from here on is news. */
    localStorage.setItem(seenKey(scope), String(now));
  } catch { /* a private window: this visit starts the clock */ }
  return now;
}

const Ctx = createContext<JobsTrayState | null>(null);

export function useJobsTray(): JobsTrayState | null {
  return useContext(Ctx);
}

export function JobsTrayProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const scope = session.signedIn ? session.requestScope ?? null : null;
  const scoped = useScopedFetch();
  const { state: ws, toast } = useWorkspace();
  const [read, setRead] = useState<{ status: "loading" | "ready" | "error"; jobs: TrayJob[]; error: string | null; partial: boolean; stopped: boolean }>({ status: "loading", jobs: [], error: null, partial: false, stopped: false });
  const [open, setOpenState] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [seenAt, setSeenAt] = useState(() => (typeof window === "undefined" ? 0 : readSeen(scope, Date.now())));
  const [releasing, setReleasing] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<Record<string, RowProblem>>({});
  const poller = useRef<Poller | null>(null);
  /* A read is out, and something asked for a fresh one meanwhile (a job started after it was sent). */
  const reading = useRef(false);
  const again = useRef(false);
  /* Read now; if a read is already out, read once more the moment it is back, so a job started during it is not left for the next turn. */
  const readNow = useCallback(() => {
    if (reading.current) { again.current = true; return; }
    poller.current?.now();
  }, []);

  useEffect(() => {
    if (!scope) return;
    const next = poll<TrayReply>({
      read: async (signal) => {
        reading.current = true;
        try {
          const response = await scoped("/api/jobs?view=tray", { cache: "no-store", signal });
          const json = await response.json().catch(() => null) as unknown;
          const reply = response.ok ? parseTrayReply(json) : null;
          if (!reply) throw Object.assign(new Error(READ_FAILED), { status: response.status });
          return reply;
        } finally {
          reading.current = false;
          /* After lib/poll has taken this reply in: its next turn is replaced by this read. */
          if (again.current) { again.current = false; setTimeout(() => poller.current?.now(), 0); }
        }
      },
      done: () => false,
      hint: (reply) => reply.pollAfterSeconds,
      onValue: (reply) => { setRead({ status: "ready", jobs: reply.jobs, error: null, partial: Boolean(reply.partial), stopped: false }); setNow(Date.now()); },
      onError: (error) => {
        const status = (error as { status?: number }).status;
        /* Signed out, or this tab is not the signed-in workspace any more: asking again cannot help. */
        if (status === 401 || status === 403 || status === 409) { setRead((r) => ({ ...r, status: r.status === "ready" ? "ready" : "error", error: READ_STOPPED, stopped: true })); return "stop"; }
        setRead((r) => ({ ...r, status: r.status === "ready" ? "ready" : "error", error: READ_FAILED }));
      },
      immediate: true,
    });
    poller.current = next;
    return () => { next.stop(); if (poller.current === next) poller.current = null; };
  }, [scope, scoped]);

  const refresh = readNow;
  /* A job started anywhere in the app, or the composer's own slot moving: read now, not on the next turn. */
  useEffect(() => onJobAnnounced(readNow), [readNow]);
  const slotId = ws.gen?.id ?? null;
  useEffect(() => { if (slotId && !slotId.startsWith("pending:")) readNow(); }, [slotId, readNow]);
  /* Ages move while the tray is open. */
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    /* A refused Release is said on its row while the tray is open; reopened, the row offers Release again. */
    if (!value) { setProblems({}); return; }
    const at = Date.now();
    setNow(at);
    /* Opening the tray is seeing what finished. */
    setSeenAt(at);
    try { if (scope) localStorage.setItem(seenKey(scope), String(at)); } catch { /* the pill clears for this visit only */ }
    readNow();
  }, [scope, readNow]);

  const release = useCallback(async (id: string) => {
    setReleasing((s) => new Set(s).add(id));
    setProblems((p) => Object.fromEntries(Object.entries(p).filter(([key]) => key !== id)));
    try {
      const response = await scoped(`/api/jobs/${encodeURIComponent(id)}/release`, { method: "POST" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setProblems((p) => ({ ...p, [id]: { message: json?.error ?? "This take could not be released.", topUp: response.status === 402 } }));
        return false;
      }
      toast("Released. It renders now.");
      readNow();
      return true;
    } catch {
      setProblems((p) => ({ ...p, [id]: { message: "The connection dropped. Try Release again.", topUp: false } }));
      return false;
    } finally {
      setReleasing((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  }, [scoped, toast, readNow]);

  const jobs = useMemo(() => trayOrder(withComposerSlot(read.jobs, ws.gen, now)), [read.jobs, ws.gen, now]);
  const summary = useMemo(() => traySummary(jobs, seenAt), [jobs, seenAt]);
  const value = useMemo<JobsTrayState>(() => ({
    status: read.status, jobs, summary, error: read.error, partial: read.partial, stopped: read.stopped, open, setOpen, refresh, release, releasing, problems, now,
  }), [read.status, jobs, summary, read.error, read.partial, read.stopped, open, setOpen, refresh, release, releasing, problems, now]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
