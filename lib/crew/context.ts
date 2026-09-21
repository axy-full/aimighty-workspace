import type { Project } from "../workbench/studio";
import { CONTEXT_LABELS, type CrewContext } from "./room";

/**
 * What the room reads (CREW_ADDENDUM.md › ROLE_CARD): only the sections the
 * session's context flags enable, from the project as it is saved right now.
 * Pure, bounded, and honest about an empty section — an agent told "Script:
 * (none written yet)" will not invent one.
 */
const SECTION_MAX = 2400;
const clip = (text: string, max = SECTION_MAX) => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);
const oneLine = (text: string | undefined | null) => String(text ?? "").replace(/\s+/g, " ").trim();

export function projectContext(project: Project, context: CrewContext): string {
  const out = [`Project: ${project.name}${oneLine(project.description) ? ` — ${oneLine(project.description)}` : ""}. ${project.aspect}, ${project.fps} fps.`];
  if (context.brief) {
    const parts = [oneLine(project.brief), oneLine(project.audience) && `Audience: ${oneLine(project.audience)}`, oneLine(project.deliverables) && `Deliver: ${oneLine(project.deliverables)}`, oneLine(project.direction) && `Direction: ${oneLine(project.direction)}`].filter(Boolean);
    out.push(`Brief: ${parts.length ? clip(parts.join(" ")) : "(none written yet)"}`);
  }
  if (context.script) out.push(`Script: ${oneLine(project.script) ? clip(String(project.script).replace(/\n{3,}/g, "\n\n").trim()) : "(none written yet)"}`);
  const scenes = project.nodes.filter((n) => n.type === "scene");
  if (context.boards) out.push(`Boards: ${scenes.length ? clip(scenes.map((n, i) => `${i + 1}. ${oneLine(n.title)}${oneLine(n.text) ? ` — ${oneLine(n.text)}` : ""}`).join("; ")) : "(no frames yet)"}`);
  if (context.cast) {
    const cast = project.assets.filter((a) => ["Character", "Element", "Environment"].includes(a.category));
    out.push(`Cast: ${cast.length ? clip(cast.map((a) => `${oneLine(a.name)} (${a.category.toLowerCase()}${a.soulIdentityId ? ", identity trained" : ""}${a.locked ? ", locked" : ""})`).join("; ")) : "(nobody cast yet)"}`);
  }
  if (context.rig) out.push(`Rig: ${scenes.length ? clip(scenes.map((n, i) => `Shot ${String(i + 1).padStart(2, "0")} ${oneLine(n.title)} — ${n.status ?? "draft"}${n.linked.length ? `, ${n.linked.length} linked` : ""}`).join("; ")) : "(no shots yet)"}`);
  return out.join("\n");
}

/** "Brief · Script · Boards" for the session panel's Reads row. */
export function readsLabel(context: CrewContext): string {
  return CONTEXT_LABELS.filter(([key]) => context[key]).map(([, label]) => label).join(" · ") || "Nothing";
}
