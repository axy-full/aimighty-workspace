"use client";

import type { ShotSpec } from "./studio";

/**
 * Carrying the Setup people already have out of their browser.
 *
 * The workspace's and the production's Setup used to live in localStorage
 * (`aw_setup_all`, `aw_setup_<projectId>`). They are server-side now, and a
 * deploy that simply started reading the server would show every existing
 * user an empty Setup and quietly discard the one they had been using.
 *
 * So the first time a scope is opened after the change, and ONLY when the
 * server has nothing for it, whatever is in this browser is sent up once.
 *
 * The "only when the server has nothing" test is what makes this safe to run
 * on every load. The move is also recorded per scope, because that test alone
 * is not enough: someone who deliberately CLEARS their workspace Setup would
 * otherwise have the old local copy resurrected on their next visit.
 *
 * The old keys are left where they are. They cost nothing, and if this is
 * ever rolled back the Setup is still sitting there.
 */

const MOVED = "aw_setup_moved:";

function read(key: string): ShotSpec | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as ShotSpec;
    return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 ? v : null;
  } catch { return null; }
}

/** Private mode reports everything as already moved: never try, never fail. */
function moved(scope: string): boolean {
  try { return window.localStorage.getItem(MOVED + scope) === "1"; } catch { return true; }
}

function markMoved(scope: string) {
  try { window.localStorage.setItem(MOVED + scope, "1"); } catch { /* it simply retries next time */ }
}

/**
 * Send this browser's Setup up for any scope the server has none for.
 * Resolves true if anything moved, so the caller can re-read.
 */
export async function liftLocalSetup(bin: string): Promise<boolean> {
  /* ONLY A PRODUCTION'S SETUP IS CARRIED UP, and that restriction is the
     whole safety argument.
     `aw_setup_<projectId>` names exactly one production, a production
     belongs to exactly one workspace, and the server answers 404 for a
     production that is not in the database this session is scoped to — so
     the value can only ever land where it came from.
     `aw_setup_all` had none of that. It was one browser-global key with no
     workspace and no user in it, written whenever the switcher said "All
     productions". Lifting it meant PUTting whatever was in this browser
     into whichever workspace happened to be open — so a person in two
     workspaces would push the first one's defaults into the second, and on
     a shared studio machine one person's leftovers became the next team's
     workspace Setup, which every member then renders against. It is not
     attributable, so it is not migrated. Anyone still holding one sets it
     again in Studio; that is one click against a silent cross-workspace
     write. */
  if (!bin || bin === "all" || bin === "unfiled" || moved(bin)) return false;
  const jobs = [{ scope: bin, flag: bin, key: `aw_setup_${bin}` }];

  /* Wait for the page to stop shouting before asking for anything.
     Mount is by far the busiest moment this app has — enough requests in
     flight that the browser refuses new ones outright with
     ERR_INSUFFICIENT_RESOURCES — and a lift fired into that reliably lost.
     Nothing here is urgent: this is a one-off carry of data that has been
     sitting in localStorage for weeks, and it does not need to beat the
     first paint. Idle if the browser will tell us, a plain wait if not. */
  await new Promise<void>((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 4000 });
    else setTimeout(resolve, 2500);
  });

  /* "Has the server got one already?" is asked HERE, of the server, for this
     exact production — not taken from a prop.
     The caller's copy comes from a hook that does not clear its data when the
     url changes, so switching production left the previous production's
     answer in hand for a moment. Reading `{}` off it meant "P2 has nothing"
     when it was really "P1 had nothing", and the lift then wrote this
     browser's stale copy over a Setup a colleague had deliberately saved. */
  let existing: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`/api/setup?projectId=${encodeURIComponent(bin)}`);
    if (!res.ok) return false;                       // ask again next load
    existing = (await res.json())?.production ?? {};
  } catch { return false; }
  if (!existing || Object.keys(existing).length) {
    // The production already has one. Nothing to carry, and never overwrite.
    markMoved(bin);
    return false;
  }

  let any = false;
  for (const job of jobs) {
    const spec = read(job.key);
    // Nothing here to move is still an answer: don't look again.
    if (!spec) { markMoved(job.flag); continue; }
    /* Retried, because this one request decides whether somebody keeps the
       Setup they had. It goes out during mount, which is the busiest moment
       this app has — enough in-flight requests that the browser starts
       refusing new ones outright (ERR_INSUFFICIENT_RESOURCES), and a lift
       that lost that race would leave the Setup stranded until the next
       load. Not marking on failure means the next load tries again anyway;
       this just makes the first one likely to be the last. */
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try {
        const res = await fetch("/api/setup", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: job.scope, spec }),
        });
        // A production that no longer exists is not a failure to retry.
        if (res.status === 404) { markMoved(job.flag); break; }
        ok = res.ok;
      } catch { /* dropped: try again in a moment */ }
    }
    if (!ok) continue;                  // still nothing: the next load retries
    markMoved(job.flag);
    any = true;
  }
  return any;
}
