"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { poll, type Poller } from "@/lib/poll";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { requestAccountRefresh } from "@/lib/workspace/data";
import { parseTrayReply, seenKey, settled, trayOrder, traySummary, withComposerSlot, type TrayJob, type TrayReply, type TraySummary } from "@/lib/jobsTray";
import { onJobAnnounced } from "./jobs-bus";
import { isCreditAmount, toDeci } from "../creditTerms";

/**
 * The header's jobs, read from GET /api/jobs?view=tray by one lib/poll poller
 * (#377's rules: the server's pollAfterSeconds as a floor — 10 s while
 * something runs, a minute otherwise — jittered, one read at a time, a failed
 * read backing off, nothing while the tab is hidden), and soon after a job
 * starts or ends anywhere in the app or the tray opens. The composer's
 * just-pressed Generate shows from its own slot until the read has the row.
 * One provider per shell, so the header pill, the tray and the phone Home
 * count the same jobs.
 *
 * What finished is news until the person has seen it in the tray: the rows
 * seen are kept by id and stage in this browser, so no clock is compared,
 * a take that finishes while the tray is open is seen then, and one seen as
 * failed that later succeeds is news again.
 */
/** Why a row's action did not do what it said; `credits` is a new figure the route named, which the next Release approves. */
export type RowProblem = { message: string; topUp: boolean; credits?: number };
export type JobsTrayState = {
  status: "loading" | "ready" | "error";
  jobs: TrayJob[];
  summary: TraySummary | null;
  /** The last read failed: the rows shown are from the read before it (or there are none yet). */
  error: string | null;
  /** The connected account's jobs could not be read this time. */
  partial: boolean;
  /** Reading stopped for good (another account or workspace in this tab): nothing here asks again. */
  stopped: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Try again: read now. */
  refresh: () => void;
  /** Start a held take at the figure on its button, if the balance covers it (POST /api/jobs/:id/release `{ credits }`). */
  release: (job: Pick<TrayJob, "id" | "name" | "releaseCredits">) => Promise<boolean>;
  releasing: ReadonlySet<string>;
  problems: Readonly<Record<string, RowProblem>>;
  now: number;
};

const READ_FAILED = "Jobs could not be read. Trying again shortly.";
/* Said plainly, with no Reload: this tab may hold work the changed account cannot save. */
const READ_STOPPED = "Jobs stopped: this tab's account or workspace changed.";
const SIGNED_OUT = "You are signed out. Sign in again to see your jobs.";
/* No answer the route wrote (a lost reply, a gateway's page): it may have started. Asking again is safe. */
const UNCONFIRMED = "The release was not confirmed. Press Release again to check — it is never charged twice.";
/** A burst of signals (a job announced and the composer's slot moving, together) is one read. */
const SOON_MS = 150;
/** Enough seen rows for every row the tray can hold, many times over. */
const SEEN_MAX = 300;
/*
 * The rows this person has seen, per workspace scope: this browser's own
 * record (localStorage), held here so every read of it is the same object
 * until it changes. Null until there is a record — a first visit, which the
 * first read then seeds.
 */
const storeKey = (scope: string) => `particl:jobs-seen:${scope}`;
const seenByScope = new Map<string, ReadonlySet<string> | null>();
const seenListeners = new Set<() => void>();
function seenOf(scope: string | null): ReadonlySet<string> | null {
  if (!scope) return null;
  if (!seenByScope.has(scope)) {
    let keys: ReadonlySet<string> | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(scope)) ?? "null") as unknown;
      if (Array.isArray(raw)) keys = new Set(raw.filter((k): k is string => typeof k === "string"));
    } catch { /* no record, or no storage: a first visit */ }
    seenByScope.set(scope, keys);
  }
  return seenByScope.get(scope) ?? null;
}
function markSeen(scope: string, keys: ReadonlySet<string>) {
  seenByScope.set(scope, keys);
  try { localStorage.setItem(storeKey(scope), JSON.stringify([...keys].slice(-SEEN_MAX))); } catch { /* a private window: seen for this visit only */ }
  for (const listener of [...seenListeners]) listener();
}
/* Another tab saw rows: this one reads the record again. */
function onStorage(event: StorageEvent) {
  const scope = [...seenByScope.keys()].find((key) => storeKey(key) === event.key);
  if (!scope) return;
  seenByScope.delete(scope);
  for (const listener of [...seenListeners]) listener();
}
const subscribeSeen = (listener: () => void) => {
  if (!seenListeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
    if (!seenListeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
};

const Ctx = createContext<JobsTrayState | null>(null);

export function useJobsTray(): JobsTrayState | null {
  return useContext(Ctx);
}

/** The last read, for the scope it was made in: another account's rows are never shown. */
type Read = { scope: string | null; status: "loading" | "ready" | "error"; jobs: TrayJob[]; error: string | null; partial: boolean; stopped: boolean };
const UNREAD: Read = { scope: null, status: "loading", jobs: [], error: null, partial: false, stopped: false };

export function JobsTrayProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const scope = session.signedIn ? session.requestScope ?? null : null;
  const scoped = useScopedFetch();
  const { state: ws, toast } = useWorkspace();
  const [lastRead, setRead] = useState<Read>(UNREAD);
  const read = lastRead.scope === scope ? lastRead : UNREAD;
  const [open, setOpenState] = useState(false);
  /* What had been seen when the tray opened: while it is open, the pill and its head still say what was news. */
  const [seenWhenOpened, setSeenWhenOpened] = useState<ReadonlySet<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seenKeys = useSyncExternalStore(subscribeSeen, () => seenOf(scope), () => null);
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
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readSoon = useCallback(() => {
    if (soon.current) return;
    soon.current = setTimeout(() => { soon.current = null; readNow(); }, SOON_MS);
  }, [readNow]);
  useEffect(() => () => { if (soon.current) clearTimeout(soon.current); }, []);

  useEffect(() => {
    if (!scope) return;
    /* Failed reads keep the rows this scope last read; a first failure has none. */
    const failed = (error: string, stopped: boolean) => setRead((r) => {
      const mine = r.scope === scope ? r : { ...UNREAD, scope };
      return { ...mine, status: mine.status === "ready" ? "ready" : "error", error, stopped };
    });
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
      onValue: (reply) => { setRead({ scope, status: "ready", jobs: reply.jobs, error: null, partial: Boolean(reply.partial), stopped: false }); setNow(Date.now()); },
      onError: (error) => {
        const status = (error as { status?: number }).status;
        /* This tab is not the signed-in workspace any more: asking again cannot help. */
        if (status === 403 || status === 409) { failed(READ_STOPPED, true); return "stop"; }
        /* Signed out: asked again, less often, so signing back in brings the jobs back. */
        failed(status === 401 ? SIGNED_OUT : READ_FAILED, false);
      },
      immediate: true,
    });
    poller.current = next;
    return () => { next.stop(); if (poller.current === next) poller.current = null; };
  }, [scope, scoped]);

  /* A job started or settled anywhere in the app: read soon, not on the next turn. */
  useEffect(() => onJobAnnounced(readSoon), [readSoon]);
  /* The composer's own job: once it has an id, and again the moment it ends, so the pill never says it renders after the page said it landed. */
  const slotId = ws.gen?.id ?? null;
  const slotEnded = ws.gen?.tone === "green" || ws.gen?.tone === "red";
  useEffect(() => { if (slotId && !slotId.startsWith("pending:")) readSoon(); }, [slotId, slotEnded, readSoon]);
  /* Ages move while the tray is open. */
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const jobs = useMemo(() => trayOrder(withComposerSlot(read.jobs, ws.gen, now)), [read.jobs, ws.gen, now]);

  /* A first visit: what has already finished is not news; only what finishes from here on is. */
  useEffect(() => {
    if (scope && read.status === "ready" && !seenKeys) markSeen(scope, new Set(read.jobs.filter(settled).map(seenKey)));
  }, [scope, read.status, read.jobs, seenKeys]);
  /* Open, every finished row is seen — including one that finishes while it is open. */
  useEffect(() => {
    if (!open || !scope || !seenKeys) return;
    const fresh = jobs.filter((job) => settled(job) && !seenKeys.has(seenKey(job)));
    if (fresh.length) markSeen(scope, new Set([...seenKeys, ...fresh.map(seenKey)]));
  }, [open, scope, jobs, seenKeys]);

  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    /* A refused Release is said on its row while the tray is open; reopened, the row offers Release again. */
    if (!value) { setProblems({}); return; }
    setSeenWhenOpened(scope ? seenOf(scope) : null);
    setNow(Date.now());
    readNow();
  }, [scope, readNow]);

  /* One press per row at a time: a double press is the same press. */
  const pressing = useRef(new Set<string>());
  const release = useCallback(async (job: Pick<TrayJob, "id" | "name" | "releaseCredits">) => {
    const { id } = job;
    /* The figure on the button: a new one the route named on the last press, else the one approved when it was held. */
    const credits = problems[id]?.credits ?? job.releaseCredits;
    if (pressing.current.has(id) || !credits) return false;
    pressing.current.add(id);
    setReleasing((s) => new Set(s).add(id));
    setProblems((p) => Object.fromEntries(Object.entries(p).filter(([key]) => key !== id)));
    const say = (problem: RowProblem) => setProblems((p) => ({ ...p, [id]: problem }));
    try {
      const response = await scoped(`/api/jobs/${encodeURIComponent(id)}/release`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credits }),
      });
      const reply = await response.json().catch(() => null) as { released?: boolean; already?: boolean; error?: string; credits?: unknown } | null;
      if (response.ok && reply?.released) {
        toast(reply.already ? `${job.name} was already released.` : `${job.name} released · ${credits.toLocaleString("en-US")} cr. It renders now.`);
        /* A release moves the balance: the header's credits read again now, as after a take card's Release (components/graphite/ReleaseTake.tsx). */
        requestAccountRefresh();
        readNow();
        return true;
      }
      if (!reply?.error || response.status >= 500) { say({ message: UNCONFIRMED, topUp: false }); return false; }
      /* The route's own words: short (Top up), a price that moved (the next press approves the new figure), a cap, or every slot busy. */
      const moved = isCreditAmount(reply.credits) && Number(reply.credits) > 0 && toDeci(reply.credits) !== toDeci(credits) ? Number(reply.credits) : undefined;
      say({ message: reply.error, topUp: response.status === 402, ...(moved ? { credits: moved } : {}) });
      return false;
    } catch {
      /* The reply was lost: the server may have released it. Pressing again asks, and never charges twice. */
      say({ message: UNCONFIRMED, topUp: false });
      return false;
    } finally {
      pressing.current.delete(id);
      setReleasing((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  }, [problems, scoped, toast, readNow]);

  const summary = useMemo(() => traySummary(jobs, open ? seenWhenOpened : seenKeys), [jobs, open, seenWhenOpened, seenKeys]);
  const value = useMemo<JobsTrayState>(() => ({
    status: read.status, jobs, summary, error: read.error, partial: read.partial, stopped: read.stopped, open, setOpen, refresh: readNow, release, releasing, problems, now,
  }), [read.status, jobs, summary, read.error, read.partial, read.stopped, open, setOpen, readNow, release, releasing, problems, now]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
