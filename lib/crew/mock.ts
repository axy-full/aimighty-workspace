import type { CrewPhase } from "./room";

/**
 * ENGINE_MOCK answers: the prototype's own canned room (Particl Crew.dc.html),
 * so a local run and the browser specs read like the design without a vendor.
 */
const PROPOSE: Record<string, string> = {
  director: "Hold one frame: the window, the rain, the bottle already on the sill — nothing moves but water. The product is simply where the light lands, so it is unmistakable without ever being presented.",
  dop: "24mm, camera locked, dawn coming up behind the bottle so it silhouettes then fills with colour over four seconds. One setup, natural light plus a 1×1 bounce off the counter.",
  designer: "Put the bottle where a kitchen would keep it — next to the tea tin, label turned a quarter away. The label colour becomes the only saturated thing in a desaturated room.",
  editor: "Cut at 0:04 exactly as the first drop runs down the glass in front of the label. The viewer reads \"tea, rain, morning\" before anyone even appears.",
  producer: "One plate, one bottle, one light change: this is a single-shot morning and it costs one render. Everything else can wait until Sc 2.",
  costume: "Keep wardrobe a cooler tone than the label, a soft knit that reads at a distance, so the bottle stays the warmest thing in frame.",
  continuity: "The boards mark Sc 1A as a static wide. Whatever we open on has to match that frame, or the board changes first.",
};
const CHALLENGE: Record<string, string> = {
  director: "@DOP — the silhouette is right, but let the colour arrive late. Four seconds of near-black, then light; the product is a reveal, not a pack shot.",
  dop: "@Editor — if you cut on the drop, give me the drop: a mist bottle on the glass, one take, no VFX.",
  designer: "@Producer — agreed on one render, but the tea tin has to be in frame or the bottle reads as a prop.",
  editor: "@Director — a reveal at 0:04 risks a dead first three seconds on social. Let the rain move from 0:00.",
  producer: "@Production designer — the tin is fine if it is in the plate already; no new element before Shot 02 is approved.",
  costume: "@Production designer — clay label, clay knit: too matched. Let wardrobe be the cooler tone.",
  continuity: "@Editor — boards mark Sc 1A as static; a push here contradicts the plan unless the board is updated.",
};
const CONVERGE = "1. Locked dawn frame — 24mm static, bottle on the sill beside the tin, light arrives over 4 s; rain is the only motion from 0:00.\n2. Cut on the drop — Editor cuts at 0:04 as a real water drop crosses the label; no VFX, one mist bottle.\n3. One render first — a single take of Sc 1A before anything else is spent; wardrobe reads cooler than the label.";

export function mockAnswer(presetId: string | null, phase: CrewPhase, others: readonly string[]): string {
  if (phase === "converge") return CONVERGE;
  if (phase === "propose") return PROPOSE[presetId ?? ""] ?? "I propose we keep it to one shot and let the light do the work.";
  const canned = CHALLENGE[presetId ?? ""];
  /* A canned line may address someone who is not seated; then answer whoever is. */
  if (canned && others.some((name) => canned.startsWith(`@${name} —`))) return canned;
  return `@${others[0] ?? "Director"} — agreed, with a smaller frame.`;
}
