"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { Step } from "@/lib/atomik";
import type {
  EngineChoice, EngineProblem, ParameterDraft, SavableRun, SkillDraft, SkillRunPreview, SkillScope, SkillStatus, SkillTemplate, SkillVersionView, SkillView,
} from "@/lib/atomikSkillsText";

/**
 * The browser's side of Atomik skills (app/api/atomik/skills): list and read
 * them, save a run as one, edit (a new version), archive and restore, and
 * run one — a free preview first, then its steps filed in an Atomik chat as
 * proposals that each wait for a quote and a Continue. Every request carries
 * the workspace scope the page was drawn for; none of them spends.
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Said on the window when skills changed somewhere else (the composer, the Skills page): an open list reads again. */
export const SKILLS_CHANGED = "particl:atomik-skills";
/**
 * Said when a skill run filed its plan in a chat: the Atomik conversation
 * shows that chat (components/atomik/skills/useSkillRunOpens.ts), where each
 * step waits for its quote and a person's Continue.
 */
export const ATOMIK_OPEN_CHAT = "particl:atomik-open-chat";
export type OpenChat = { chatId: string; projectId: string | null };
export function openAtomikChat(detail: OpenChat) {
  window.dispatchEvent(new CustomEvent<OpenChat>(ATOMIK_OPEN_CHAT, { detail }));
}

/** A refusal the person can act on: the words, and the engines that need their choice. */
export class SkillRequestError extends Error {
  constructor(message: string, readonly status: number, readonly problems: EngineProblem[] = []) { super(message); this.name = "SkillRequestError"; }
}

export type SaveInput = { chatId: string; stepIds: string[]; parameters: ParameterDraft[]; name: string; slug: string; description: string; scope: SkillScope };
export type EditInput = { expectedVersion: number; name?: string; slug?: string; description?: string; scope?: SkillScope; note?: string; template?: SkillTemplate };
export type RunInput = { values: Record<string, string>; engines: Record<string, string>; chatId?: string | null; projectId?: string | null };
export type PlannedRun = { chatId: string; messageId: string; steps: Step[] };

export function skillsApi(fetcher: Fetcher, changed?: () => void) {
  async function call<T>(url: string, method: string, body?: unknown, fallback = "That could not be done. Try again."): Promise<T> {
    const response = await fetcher(url, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const reply = (await response.json().catch(() => null)) as (T & { error?: string; problems?: EngineProblem[] }) | null;
    if (!response.ok || !reply) throw new SkillRequestError(reply?.error || fallback, response.status, reply?.problems ?? []);
    return reply;
  }
  const mutated = <T,>(p: Promise<T>) => p.then((value) => { changed?.(); return value; });
  const one = (id: string) => `/api/atomik/skills/${encodeURIComponent(id)}`;
  return {
    list: (status: SkillStatus, query = "") =>
      call<{ skills: SkillView[] }>(`/api/atomik/skills?${new URLSearchParams({ ...(status === "archived" ? { status } : {}), ...(query ? { q: query } : {}) })}`, "GET", undefined, "Skills could not be loaded. Try again.").then((r) => (Array.isArray(r.skills) ? r.skills : [])),
    runs: (projectId: string | null) =>
      call<{ runs: SavableRun[] }>(`/api/atomik/skills?${new URLSearchParams({ runs: "1", ...(projectId ? { projectId } : {}) })}`, "GET", undefined, "Runs could not be loaded. Try again.").then((r) => (Array.isArray(r.runs) ? r.runs : [])),
    draft: (chatId: string) => call<{ draft: SkillDraft }>("/api/atomik/skills", "POST", { action: "draft", chatId }, "That run could not be read. Try again.").then((r) => r.draft),
    save: (input: SaveInput) => mutated(call<{ skill: SkillView }>("/api/atomik/skills", "POST", { action: "save", ...input }, "That skill could not be saved. Try again.").then((r) => r.skill)),
    get: (id: string) => call<{ skill: SkillView; versions: SkillVersionView[]; engines: EngineChoice[] }>(one(id), "GET", undefined, "This skill could not be loaded. Try again."),
    version: (id: string, version: number) => call<{ version: SkillVersionView }>(`${one(id)}?version=${version}`, "GET", undefined, "That version could not be loaded. Try again.").then((r) => r.version),
    edit: (id: string, input: EditInput) => mutated(call<{ skill: SkillView }>(one(id), "PATCH", { action: "edit", ...input }, "That edit could not be saved. Try again.").then((r) => r.skill)),
    archive: (id: string) => mutated(call<{ skill: SkillView }>(one(id), "PATCH", { action: "archive" }, "That skill could not be archived. Try again.").then((r) => r.skill)),
    restore: (id: string) => mutated(call<{ skill: SkillView }>(one(id), "PATCH", { action: "restore" }, "That skill could not be restored. Try again.").then((r) => r.skill)),
    preview: (id: string, input: RunInput) => call<{ preview: SkillRunPreview }>(`${one(id)}/run`, "POST", { ...input, dryRun: true }, "The skill could not be previewed. Try again.").then((r) => r.preview),
    run: (id: string, input: RunInput) => call<{ run: PlannedRun }>(`${one(id)}/run`, "POST", input, "The skill could not be planned. Try again.").then((r) => r.run),
  };
}
export type SkillsApi = ReturnType<typeof skillsApi>;

/** The requests alone, bound to the scope a surface was drawn for; a change tells every open list. */
export function useSkillsApi(scope: string | null | undefined): SkillsApi {
  const scoped = useScopedFetch(scope ?? null);
  return useMemo(() => skillsApi(scoped, () => window.dispatchEvent(new Event(SKILLS_CHANGED))), [scoped]);
}

export type SkillsLoad = { status: "loading" | "ready" | "error"; skills: SkillView[]; error: string | null };

/** The skills this person may see, active or archived, read on arrival, after every change, and when asked. */
export function useSkills(scope: string | null | undefined, status: SkillStatus, enabled = true) {
  const api = useSkillsApi(scope);
  const key = JSON.stringify([scope ?? null, status, enabled]);
  const [load, setLoad] = useState<{ key: string; value: SkillsLoad } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!scope || !enabled) return;
    const mine = ++sequence.current;
    setLoad((previous) => ({ key, value: previous?.key === key ? { ...previous.value, status: previous.value.status === "error" ? "loading" : previous.value.status } : { status: "loading", skills: [], error: null } }));
    try {
      const skills = await api.list(status);
      if (mine === sequence.current) setLoad({ key, value: { status: "ready", skills, error: null } });
    } catch (error) {
      if (mine !== sequence.current) return;
      const message = error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Skills could not be loaded. Try again.";
      setLoad((previous) => ({ key, value: { status: "error", skills: previous?.key === key ? previous.value.skills : [], error: message } }));
    }
  }, [scope, enabled, status, key, api]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    const again = () => void refresh();
    window.addEventListener(SKILLS_CHANGED, again);
    return () => { clearTimeout(timer); window.removeEventListener(SKILLS_CHANGED, again); };
  }, [refresh]);
  const value: SkillsLoad = load?.key === key ? load.value : { status: enabled ? "loading" : "ready", skills: [], error: null };
  return { ...value, refresh, api };
}

/** A problem said the way the page reads it. */
export const failed = (error: unknown, fallback: string) => (error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : fallback);
