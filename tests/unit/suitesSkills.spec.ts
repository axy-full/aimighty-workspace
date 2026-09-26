import { test, expect } from "@playwright/test";
import { SKILL_PACKS, SKILLS_REPO } from "../../lib/shell/skills";
import { shellPage } from "../../lib/shell/ia";

test("the eight higgsfield-ai/skills packs, in the prototype's order, each installable from its real folder", () => {
  expect(SKILL_PACKS.map((p) => p.id)).toEqual([
    "higgsfield-generate", "higgsfield-soul-id", "higgsfield-brandkit", "higgsfield-product-photoshoot",
    "higgsfield-youtube-thumbnail", "higgsfield-video-explainer", "higgsfield-websites", "higgsfield-marketplace-cards",
  ]);
  for (const p of SKILL_PACKS) {
    expect(p.href).toBe(`${SKILLS_REPO}/tree/main/${p.id}`);
    expect(p.install).toBe(`npx skills add higgsfield-ai/skills --skill ${p.id}`);
    expect(p.line.length).toBeGreaterThan(8);
  }
  expect(SKILL_PACKS[0].line).toBe("image · video · 3D · audio · Marketing Studio · Virality Predictor");
  expect(shellPage("atomik", "skills")?.own).toBe(true);
  expect(shellPage("atomik", "agent")?.own).toBeUndefined();
});
