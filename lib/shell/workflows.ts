/**
 * The connected account's workflows on the Studio pages the brief names
 * (FINAL_SPEC §4 › Workflows): Deliver › Social cuts = `reframe`, Edit ›
 * Dub = `dubbing`, Edit › Change voice = `voice_change`, Gen › Analysis =
 * `video_analysis` (the Virality Predictor's report). Pure: the surfaces and
 * the one reason a tool cannot run.
 */
import { VOICE_TOOL_NAMES, type VoiceToolName } from "@/lib/higgsfield-consumer/voice-tools";

export type WorkflowSurface = { tool: VoiceToolName; title: string; line: string; flag: "voice" | "dubbing" | "analysis" | "reframe" };
export const WORKFLOW_SURFACES: Record<string, readonly WorkflowSurface[]> = {
  "studio:timeline": [
    { tool: "dubbing", title: "Dub", line: "Translate a project video’s speech into another language, re-voice it and lip-sync the result.", flag: "dubbing" },
    { tool: "voice_change", title: "Change voice", line: "Replace the spoken voice in a project video with a voice from the connected account, keeping the timing and picture.", flag: "voice" },
  ],
  "studio:deliver": [
    { tool: "reframe", title: "Social cuts", line: "9:16 and 1:1 reframes from the same master (up to 60 s), filling the new edges and keeping the source content.", flag: "reframe" },
  ],
  "gen:analysis": [
    { tool: "video_analysis", title: "Virality Predictor", line: "Hook, attention and retention score for a finished video — the account’s estimate, filed as a note. Shorter clips give the most reliable report.", flag: "analysis" },
  ],
};

/* Astra › Draw to edit (`draw_to_video`) is not advertised by the account, so
   it has no workflow behind it and is not shown (owner's rule, 22 September). */

export type WorkflowCapability = { owner: boolean; connected: boolean; suspended: boolean };
export type WorkflowCapabilities = { voice: boolean; dubbing: boolean; analysis: boolean; reframe: boolean };

/** Why the tool cannot run right now, in the words shown under its title; null when it can. */
export function workflowReason(surface: WorkflowSurface, input: { hasProject: boolean; capability: WorkflowCapability | null; capabilities: WorkflowCapabilities | null; error?: string | null }): string | null {
  if (!VOICE_TOOL_NAMES.includes(surface.tool)) return "This tool is not offered.";
  if (!input.hasProject) return "Save your project first.";
  if (input.error) return input.error;
  if (!input.capability) return "Reading the connected account…";
  if (!input.capability.owner) return "The workspace owner uses the connected account.";
  if (!input.capability.connected) return "Connect the owner’s account in Workspace › Engines.";
  if (input.capability.suspended) return "Rendering is paused for this workspace.";
  if (!input.capabilities) return "Reading the account’s tools…";
  if (!input.capabilities[surface.flag])
    return surface.flag === "analysis" ? "Video analysis is switched off for this platform." : `The connected account does not advertise ${surface.tool.replace("_", " ")}.`;
  return null;
}
