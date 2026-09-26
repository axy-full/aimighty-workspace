import { shellSuite, type ShellSuiteId } from "./ia";

/**
 * When part of the Suites shell throws (components/Boundary.tsx around each
 * panel, app/suites/error.tsx around the whole shell, app/not-found.tsx for a
 * link to nothing): the reference a person can quote, whether the cure is a
 * reload rather than a retry, how much of the message is worth showing, the
 * text "Copy details" puts on the clipboard, and the links back in. Pure, so
 * tests/unit/shellFault.spec.ts holds it.
 */

export type FaultError = { name?: string; message?: string; digest?: string } | null | undefined;

/**
 * What a boundary caught, as an Error. React hands a boundary whatever was
 * thrown, and not every throw is an Error (a string, a plain object from a
 * library, `undefined`); the card, the ref and Copy details all need one.
 * Its message may be empty — then the card shows the ref alone.
 */
export function asError(thrown: unknown): Error & { digest?: string } {
  if (thrown instanceof Error) return thrown;
  const record = thrown !== null && typeof thrown === "object" ? (thrown as Record<string, unknown>) : null;
  const message = typeof thrown === "string" ? thrown : typeof record?.message === "string" ? record.message : "";
  const error: Error & { digest?: string } = new Error(message);
  if (typeof record?.name === "string" && record.name) error.name = record.name;
  if (typeof record?.digest === "string") error.digest = record.digest;
  return error;
}

/**
 * Try again presses, counted for one resetKey: a panel that moves on to
 * another page, project or take starts again from none. Kept outside the
 * boundary, because a render that fails again remounts the whole fallback.
 */
export type Tries = { key: unknown; count: number };

export function attemptsFor(tries: Tries, key: unknown): number {
  return Object.is(tries.key, key) ? tries.count : 0;
}

export function countTry(tries: Tries, key: unknown): Tries {
  return { key, count: attemptsFor(tries, key) + 1 };
}

/**
 * A short reference that matches the console line (and, for a server error,
 * the server log): Next's digest when there is one, else a stable hash of the
 * error's name and message — the same failure gets the same ref every time.
 */
export function faultRef(error: FaultError): string {
  const digest = error?.digest?.trim();
  if (digest) return digest.slice(0, 32);
  const text = `${error?.name ?? "Error"}:${error?.message ?? ""}`;
  /* FNV-1a, 32-bit: small, stable and good enough to tell two failures apart. */
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `P-${(hash >>> 0).toString(36).toUpperCase().padStart(7, "0")}`;
}

/* A deploy replaced the code this tab was built from: the next chunk it asks for is gone, and retrying asks again. */
const STALE_BUILD = /ChunkLoadError|Loading (CSS )?chunk [\w./-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** True when the failure is a newer deploy, not a bug: only a reload fixes it. */
export function isStaleBuild(error: FaultError): boolean {
  return STALE_BUILD.test(`${error?.name ?? ""} ${error?.message ?? ""}`);
}

/* Production strips a server error's message and says so at length; the digest is the useful part. */
const SERVER_OMITTED = /omitted in production builds|An error occurred in the Server Components render/i;

/** The message on one line, capped — or null when there is nothing a person could use. */
export function faultMessage(error: FaultError, max = 160): string | null {
  const text = (error?.message ?? "").replace(/\s+/g, " ").trim();
  if (!text || SERVER_OMITTED.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The first button: Try again, unless the build is stale or trying has already
 * failed twice in a row — then Reload, which fetches a clean document.
 */
export function faultPrimary(error: FaultError, attempts = 0): "retry" | "reload" {
  return isStaleBuild(error) || attempts >= 2 ? "reload" : "retry";
}

/** What "Copy details" writes: enough to find the failure, nothing about the person. */
export function faultReport(input: { what: string; error: FaultError; where?: string | null; at?: number }): string {
  const message = faultMessage(input.error, 400);
  return [
    `Particl · ${input.what} stopped`,
    `ref ${faultRef(input.error)}`,
    message ? `message ${message}` : null,
    input.where ? `where ${input.where}` : null,
    `when ${new Date(input.at ?? Date.now()).toISOString()}`,
  ].filter(Boolean).join("\n");
}

/* ── The ways back in ───────────────────────────────────────────────────── */

export const STUDIO_HREF = "/suites";
export const TAKES_HREF = "/suites?page=takes&sp=takes";
/** `?find=1` opens ⌘K search as the shell lands (lib/shell/state.tsx), so a page outside the shell can offer it. */
export const FIND_PARAM = "find";
export const FIND_HREF = `/suites?${FIND_PARAM}=1`;
/** A visitor (no session) on a dead link: the public site's front page, where proxy.ts serves the site. */
export const HOME_HREF = "/";

export type SegmentId = ShellSuiteId | "gen" | "crew";

/** Each header segment as a plain link, for the pages drawn outside the live shell. */
export function segmentHref(id: SegmentId): string {
  if (id === "studio") return STUDIO_HREF;
  if (id === "gen" || id === "crew") return `${STUDIO_HREF}?view=${id}`;
  return `${STUDIO_HREF}?suite=${shellSuite(id).legacy}`;
}

/** True when the URL asks the shell to open search as it lands. */
export function findRequested(search: string): boolean {
  return new URLSearchParams(search).get(FIND_PARAM) === "1";
}

/** The same URL without the one-shot `find` param, so a reload does not reopen search. */
export function withoutFind(search: string): string {
  const query = new URLSearchParams(search);
  query.delete(FIND_PARAM);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/* ── Crash probes (development only) ────────────────────────────────────── */

/**
 * The global the browser specs arm: `window.__particlCrash = ["library"]`. An
 * entry may also name the error to throw — `{ name: "library", message: "…",
 * errorName: "ChunkLoadError" }` — for the long-message and stale-build cards.
 */
export const CRASH_PROBE = "__particlCrash";

type Armed = { message: string; errorName?: string };

function armedProbe(name: string, scope: unknown): Armed | null {
  if (process.env.NODE_ENV === "production") return null;
  const armed = (scope as Record<string, unknown> | null | undefined)?.[CRASH_PROBE];
  if (!Array.isArray(armed)) return null;
  for (const entry of armed as unknown[]) {
    if (entry === name) return { message: `Crash probe: ${name}` };
    const probe = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (probe?.name !== name) continue;
    return {
      message: typeof probe.message === "string" ? probe.message : `Crash probe: ${name}`,
      errorName: typeof probe.errorName === "string" ? probe.errorName : undefined,
    };
  }
  return null;
}

/**
 * Whether a named boundary should throw on its next render. Development and
 * test builds only: in production `process.env.NODE_ENV` is inlined and the
 * rest of the lookup is dead code, so no URL, cookie or storage key can ever
 * arm it on the live site.
 */
export function probeArmed(name: string, scope: unknown = globalThis): boolean {
  return armedProbe(name, scope) !== null;
}

/** Throw during render when the probe is armed — the failure a boundary exists for. */
export function throwIfArmed(name: string, scope: unknown = globalThis): void {
  const armed = armedProbe(name, scope);
  if (!armed) return;
  const error = new Error(armed.message);
  if (armed.errorName) error.name = armed.errorName;
  throw error;
}
