/**
 * Atomik's read-only view of the connected account (slice A1).
 *
 * The planner may see what the connected account holds — recommended models,
 * motion presets, voices, trained characters, reference elements, recent
 * generations and uploads, the credit balance and plan — before it proposes
 * anything. Every read here is FREE and read-only: the tool names and
 * argument shapes are fixed below (never chosen by a caller or the model),
 * each is checked against our connection's advertised surface first, and a
 * read the connection does not offer is simply reported as unavailable.
 *
 * Replies are provider data, never instructions. They are reduced to short
 * bounded lines with links and control characters removed before the planner
 * sees them; purchase or checkout links in particular are never passed on.
 *
 * Pure (no network, no database) so it is unit-testable on fixtures.
 */
import { displayName } from "./catalogue";

export type PlannerReadName =
  | "recommend"
  | "presets"
  | "voices"
  | "characters"
  | "elements"
  | "generations"
  | "medias"
  | "balance"
  | "plan";
export type PlannerRead = { name: PlannerReadName; tool: string; args: Record<string, unknown> };

export const PLANNER_GOAL_LIMIT = 300;
/** The fixed reads, in the order they are made. `recommend` carries the
 * person's request (bounded) as its goal; nothing else varies. */
export function plannerReads(goal: string): PlannerRead[] {
  const query = goal.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, PLANNER_GOAL_LIMIT);
  return [
    ...(query ? [{ name: "recommend" as const, tool: "models_explore", args: { action: "recommend", query, limit: 5 } }] : []),
    { name: "presets", tool: "presets_show", args: {} },
    { name: "voices", tool: "list_voices", args: { size: 20 } },
    { name: "characters", tool: "show_characters", args: { action: "list", status: "ready", size: 20 } },
    { name: "elements", tool: "show_reference_elements", args: { action: "list", size: 27 } },
    { name: "generations", tool: "show_generations", args: { size: 12 } },
    { name: "medias", tool: "show_medias", args: { type: "image", size: 12 } },
    { name: "balance", tool: "balance", args: {} },
    { name: "plan", tool: "show_plans_and_credits", args: { intent: "general" } },
  ];
}
/** Every tool the reads may use; nothing outside this list is ever called here. */
export const PLANNER_READ_TOOLS = Object.freeze([
  "models_explore",
  "presets_show",
  "list_voices",
  "show_characters",
  "show_reference_elements",
  "show_generations",
  "show_medias",
  "balance",
  "show_plans_and_credits",
]);

export type PlannerReadResult = { name: PlannerReadName; value?: unknown; unavailable?: true };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Short, single-line, link-free text. */
export function plannerText(value: unknown, max = 80): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return displayName(String(value))
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/[\p{Cc}<>`]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const idOf = (item: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && ID.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return null;
};
/** The first array found under a known key (one level deep), bounded. */
function itemsOf(value: unknown, keys: string[], limit: number): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(record).slice(0, limit);
  if (!record(value)) return [];
  for (const key of keys) {
    const found = value[key];
    if (Array.isArray(found)) return found.filter(record).slice(0, limit);
    if (record(found)) {
      for (const inner of keys) if (Array.isArray(found[inner])) return (found[inner] as unknown[]).filter(record).slice(0, limit);
    }
  }
  return [];
}
const LIST_KEYS = ["items", "data", "results", "presets", "voices", "characters", "souls", "elements", "generations", "medias", "models", "jobs"];
function numberAt(value: unknown, keys: string[]): number | null {
  if (!record(value)) return null;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "number" && Number.isFinite(found)) return found;
    if (typeof found === "string" && /^\d+(\.\d+)?$/.test(found)) return Number(found);
    if (record(found)) {
      const inner = numberAt(found, keys);
      if (inner !== null) return inner;
    }
  }
  return null;
}
function textAt(value: unknown, keys: string[]): string {
  if (!record(value)) return "";
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string") return plannerText(found, 40);
    if (record(found)) {
      const name = plannerText(found.name ?? found.title ?? found.plan, 40);
      if (name) return name;
    }
  }
  return "";
}

export type PlannerContext = {
  /** Lines for the planner's preamble, already bounded and link-free. */
  lines: string[];
  /** Model ids the account recommended for this request (checked against the catalogue by the caller). */
  recommended: string[];
  /** Motion preset ids from presets_show, for image-to-video preset steps. */
  presets: { id: string; name: string }[];
  balance: number | null;
  unavailable: PlannerReadName[];
};

/** Reduces the raw read results to what the planner may see. */
export function summarizePlannerReads(results: PlannerReadResult[]): PlannerContext {
  const lines: string[] = [];
  const context: PlannerContext = { lines, recommended: [], presets: [], balance: null, unavailable: [] };
  for (const result of results) {
    if (result.unavailable) {
      context.unavailable.push(result.name);
      continue;
    }
    const value = result.value;
    if (result.name === "recommend") {
      const models = itemsOf(value, LIST_KEYS, 5)
        .map((item) => ({ id: idOf(item, ["id", "model_id", "model"]), name: plannerText(item.name, 40) }))
        .filter((item): item is { id: string; name: string } => !!item.id);
      context.recommended = models.map((model) => model.id);
      if (models.length) lines.push(`Recommended for this request: ${models.map((m) => `connected:${m.id}${m.name ? ` (${m.name})` : ""}`).join(", ")}`);
    } else if (result.name === "presets") {
      const presets = itemsOf(value, LIST_KEYS, 40)
        .map((item) => ({ id: idOf(item, ["id", "preset_id"]), name: plannerText(item.name ?? item.title, 40) }))
        .filter((item): item is { id: string; name: string } => !!item.id);
      context.presets = presets;
      if (presets.length) lines.push(`Motion presets: ${presets.map((p) => `${p.id}${p.name ? ` “${p.name}”` : ""}`).join("; ")}`);
    } else if (result.name === "voices") {
      const voices = itemsOf(value, LIST_KEYS, 20)
        .map((item) => ({ id: idOf(item, ["voice_id", "id"]), name: plannerText(item.name, 30), type: item.voice_type === "element" ? "element" : "preset" }))
        .filter((item) => item.id);
      if (voices.length) lines.push(`Voices: ${voices.map((v) => `${v.id} (${v.type}${v.name ? `, ${v.name}` : ""})`).join("; ")}`);
    } else if (result.name === "characters") {
      const souls = itemsOf(value, LIST_KEYS, 20)
        .map((item) => ({ id: idOf(item, ["soul_id", "id"]), name: plannerText(item.name, 30) }))
        .filter((item) => item.id);
      if (souls.length) lines.push(`Trained characters: ${souls.map((s) => `${s.name || "unnamed"} (${s.id})`).join("; ")}`);
    } else if (result.name === "elements") {
      const elements = itemsOf(value, LIST_KEYS, 27)
        .map((item) => ({ id: idOf(item, ["element_id", "id"]), name: plannerText(item.name, 32), category: plannerText(item.category, 16) }))
        .filter((item) => item.id);
      if (elements.length) lines.push(`Reference elements: ${elements.map((e) => `${e.name || "unnamed"}${e.category ? ` [${e.category}]` : ""} (${e.id})`).join("; ")}`);
    } else if (result.name === "generations") {
      const recent = itemsOf(value, LIST_KEYS, 12)
        .map((item) => [plannerText(item.type, 8), plannerText(item.model, 30), plannerText(item.status, 12)].filter(Boolean).join(" "))
        .filter(Boolean);
      if (recent.length) lines.push(`Recent generations: ${recent.join("; ")}`);
    } else if (result.name === "medias") {
      const count = itemsOf(value, LIST_KEYS, 12).length;
      if (count) lines.push(`Uploaded images on the account: ${count}${count === 12 ? "+" : ""}`);
    } else if (result.name === "balance") {
      context.balance = numberAt(value, ["credits", "balance", "available_credits", "total"]);
      const plan = textAt(value, ["plan", "subscription", "plan_name"]);
      if (context.balance !== null || plan)
        lines.push(`Connected credits: ${context.balance === null ? "unknown" : context.balance.toLocaleString("en-US")}${plan ? ` · plan ${plan}` : ""}`);
    } else if (result.name === "plan") {
      // Only the current plan's name; offers, prices and checkout links are dropped.
      const plan = textAt(value, ["current_plan", "plan", "subscription", "plan_name"]);
      if (plan) lines.push(`Current plan: ${plan}`);
    }
  }
  return { ...context, lines: lines.map((line) => line.slice(0, 900)).slice(0, 12) };
}
