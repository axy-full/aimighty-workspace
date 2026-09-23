import { test, expect } from "@playwright/test";
import { WORKFLOW_SURFACES, workflowReason } from "../../lib/shell/workflows";
import { VOICE_TOOL_NAMES } from "../../lib/higgsfield-consumer/voice-tools";

/** FINAL_SPEC §4 › Workflows: the surfaces the brief names, each on an advertised tool, and the one reason a tool cannot run. */
test("the surfaces are the brief's: Deliver › Social cuts = reframe, Timeline › Dub · Change voice, Gen › Analysis; nothing without a tool behind it", () => {
  expect(WORKFLOW_SURFACES["studio:deliver"].map((s) => s.tool)).toEqual(["reframe"]);
  expect(WORKFLOW_SURFACES["studio:timeline"].map((s) => s.tool)).toEqual(["dubbing", "voice_change"]);
  expect(WORKFLOW_SURFACES["gen:analysis"].map((s) => s.tool)).toEqual(["video_analysis"]);
  for (const list of Object.values(WORKFLOW_SURFACES)) for (const s of list) expect(VOICE_TOOL_NAMES).toContain(s.tool);
  expect(Object.keys(WORKFLOW_SURFACES)).not.toContain("studio:astra");
});

test("a tool says the one thing in its way, in order: project, owner, connection, suspension, the account's flags", () => {
  const cuts = WORKFLOW_SURFACES["studio:deliver"][0];
  const all = { voice: true, dubbing: true, analysis: false, reframe: true };
  const ok = { owner: true, connected: true, suspended: false };
  expect(workflowReason(cuts, { hasProject: false, capability: ok, capabilities: all })).toBe("Save your project first.");
  expect(workflowReason(cuts, { hasProject: true, capability: null, capabilities: null })).toBe("Reading the connected account…");
  expect(workflowReason(cuts, { hasProject: true, capability: { ...ok, owner: false }, capabilities: all })).toBe("The workspace owner uses the connected account.");
  expect(workflowReason(cuts, { hasProject: true, capability: { ...ok, connected: false }, capabilities: all })).toBe("Connect the owner’s account in Workspace › Engines.");
  expect(workflowReason(cuts, { hasProject: true, capability: { ...ok, suspended: true }, capabilities: all })).toBe("Rendering is paused for this workspace.");
  expect(workflowReason(cuts, { hasProject: true, capability: ok, capabilities: { ...all, reframe: false } })).toBe("The connected account does not advertise reframe.");
  expect(workflowReason(cuts, { hasProject: true, capability: ok, capabilities: all, error: "The connected account could not be read." })).toBe("The connected account could not be read.");
  expect(workflowReason(cuts, { hasProject: true, capability: ok, capabilities: all })).toBeNull();
  expect(workflowReason(WORKFLOW_SURFACES["gen:analysis"][0], { hasProject: true, capability: ok, capabilities: all })).toBe("Video analysis is switched off for this platform.");
});
