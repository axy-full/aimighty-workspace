@AGENTS.md

# Rules for this work

Copied from docs/particl-brief.md, section 2. The brief is the source of truth; read it in full before touching code.

1. **Other people's money.** Every render bills a customer workspace in credits that they paid real money for. Never trigger a generation, training run or upscale against any customer workspace. Development uses mocked engine responses and fixtures; if a test genuinely needs a real engine call, it runs in a dedicated internal test workspace, and you tell me the cost and wait for a yes.
2. **Tenant isolation is not a feature, it's the floor.** Every table carries a `workspace_id`; every query filters on it; every Blob path is prefixed by it; every signed URL is scoped to it. Identities, cast, masters, prompts, costs and rules never cross a workspace boundary. If you can't point to where a query is scoped, it's a bug.
3. **Nothing tied to one studio in the code.** The rules, defaults and camera bank the product has today were learned by one team. They become the **platform layer** — defaults every workspace inherits and can override — not hard-coded behaviour. No workspace name, client name or person appears in source, seed data or copy.
4. **Do not redesign what already works.** The shot/take model, Draft/Picked/Approved, cost-on-the-button, Setup-carried-into-every-shot, `@cast`, file naming and caps are the product. Extend them; don't replace them.
5. **One vocabulary.** Every surface must use the same names. Decide with me, then enforce in code: one word for the render feed (currently "The wall" / "Library" / "All" / "Browse every render"), one word for the make screen (currently "MAKE" in the dock, "Video/Images/Audio" in the segmented control, "Generate" on the login page), and drop "Canvas" and "Production" from the login page unless they map to real screens.
6. **The first five minutes.** A stranger with an invite must get from email to first render inside five minutes without reading a paragraph. Every screen is judged against that person, not against someone who already knows the product.
7. **Mobile is a first-class surface.** Producers approve takes from a phone. Every change ships with Playwright checks at 360×640, 390×844 and 844×390. No horizontal overflow on any route, all primary actions reachable without panning, dock and composer bar clear of the home indicator.
8. **Ship in small PRs**, one concern each, in the order of the phases below. Don't start Phase 2 until Phase 0 and Phase 1 are merged.
9. **Prose in the product is a cost.** The copy voice is good; there's too much of it. Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.
