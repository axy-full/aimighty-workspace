/**
 * The Library's Tools for the Production suite's rebuilt stages (owner's brief,
 * 23 September: no button hanging in limbo). Each row is a real section of the
 * stage on screen; pressing it brings that section into view (and switches to
 * its tab), never a dead end.
 */
export type ProductionTool = { name: string; sub: string; section: string };
export type ProductionToolGroup = { title: string; items: ProductionTool[] };
const g = (title: string, items: [string, string, string][]): ProductionToolGroup => ({ title, items: items.map(([name, sub, section]) => ({ name, sub, section })) });

export const PRODUCTION_TOOLS: Record<string, ProductionToolGroup[]> = {
  brief: [
    g("AGENT", [["Agent", "Claude · Grok · OpenAI", "agent"]]),
    g("SCRIPT", [["Prompt", "Write the script", "prompt"], ["Review & redraft", "Drafts · Notes · Approve", "review"], ["Script editor", "Edit · Import a PDF", "editor"]]),
  ],
  beats: [
    g("AGENT", [["Agent", "Claude · Grok · OpenAI", "agent"], ["Break it down", "Scenes · Beats · Shots", "breakdown"]]),
    g("BEAT SHEET", [["Beat board", "Edit beats and shots", "board"], ["Redraft the script", "From these beats", "redraft"]]),
  ],
  boards: [
    g("AGENT", [["Agent", "Claude · Grok · OpenAI", "agent"], ["Frame prompts", "One per shot", "prompts"]]),
    g("FRAMES", [["Look", "Live action · Colour · B&W sketch", "look"], ["Frames", "Prompt · Drawing · Render", "frames"]]),
  ],
};

/** Studio pages the Production agent runs itself: their own priced actions replace the page head's "Run stage". */
export const PRODUCTION_AGENT_PAGES = new Set(["brief", "beats", "boards"]);

export const SECTION_EVENT = "particl:production-section";
/** Brings a stage's section into view; the stage listens for the event to switch tabs first. */
export function focusSection(section: string) {
  window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: section }));
  requestAnimationFrame(() => document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
}
