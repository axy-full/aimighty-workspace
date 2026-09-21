/**
 * Atomik › Skills = the higgsfield-ai/skills packs (FINAL_SPEC §5). One row
 * per pack: its name, the prototype's one line, and where Install opens —
 * the pack's folder in the public repo, which is what the agent's tool reach
 * is made of. Nothing here is a fictional integration: the packs are read
 * and installed the way their INSTALL.md says.
 */
export const SKILLS_REPO = "https://github.com/higgsfield-ai/skills";
export type SkillPack = { id: string; line: string; href: string; install: string };
const pack = (id: string, line: string): SkillPack => ({ id, line, href: `${SKILLS_REPO}/tree/main/${id}`, install: `npx skills add higgsfield-ai/skills --skill ${id}` });

export const SKILL_PACKS: readonly SkillPack[] = [
  pack("higgsfield-generate", "image · video · 3D · audio · Marketing Studio · Virality Predictor"),
  pack("higgsfield-soul-id", "train a Soul ID from 1–40 portraits"),
  pack("higgsfield-brandkit", "logo, palette, type, brandbook, packaging"),
  pack("higgsfield-product-photoshoot", "ten mode-specific templates on GPT Image 2"),
  pack("higgsfield-youtube-thumbnail", "thumbnail frameworks · baked text overlays"),
  pack("higgsfield-video-explainer", "narrated explainer from a topic or document"),
  pack("higgsfield-websites", "sites, apps and games around your assets"),
  pack("higgsfield-marketplace-cards", "marketplace listing cards"),
];
