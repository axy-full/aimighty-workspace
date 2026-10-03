This is Particl's final design: "Particl Suites.dc.html", in the Graphite look. Keep the look exactly as it is: colours, type, spacing, radii, icons and components. Don't restyle anything. Don't add glass, blur or gradients, and leave the "flair" switch off. Don't add colours. Work in "Particl Suites.dc.html" only, except in step 6.

Rules for every step:
- The app is the repo axy-full/aimighty-workspace, branch main. Sync from GitHub before you start. Treat lib/shell/ia.ts as the source for the suites, their page names and their order.
- Particl uses provider APIs and loginless MCP only (owner's decision, 28 September 2026). Nothing may need a Higgsfield sign-in: no connected account, no Higgsfield CLI, no skill packs, no connected-account catalogue. Higgsfield work runs on Particl's own API key.
- Every paid action shows its price on its button. Prices come from the repo's rate card (CLAUDE.md, Pricing); never invent one.
- Do one step at a time. After each step, stop, show me the screens you changed, and wait for my go-ahead.

1. Remove what Particl no longer offers, everywhere in the file:
   - the "Higgsfield catalogue" model group and every model in it, including Veo 3.1, Cinematic Studio and Virality Predictor;
   - the higgsfield-generate, higgsfield-soul-id and higgsfield-brandkit tools;
   - Business > Ads, because Marketing Studio video ran on the connected account;
   - Cast's reference elements.
   Then rename "Supercomputer" to "Agent": the Atomik suite is "Atomik Agent", and its header mark reads AGENT.

2. Gen (header segment "Gen", title "Generate"). Build it inside this shell: Video · Images · Audio, the one composer, the Takes and assets wall, Seedance Edit, and the Astra and Topaz upscales. Take the layout and copy from "Particl Gen.dc.html", fitted to this file's shell. Offer only engines Particl runs on its own keys, as named in the rate card.

3. Atomik ("Atomik Agent"). Build its eight pages in this order:
   - Agent: plan, price, then run
   - Runs: durable, recoverable, accounted
   - Approvals: nothing paid without a gate
   - Budget: settled accounting, not estimates
   - Models: Claude, OpenAI and Grok for planning; engines for output
   - Tools & connections: what Atomik reaches, and what reaches Particl
   - Memory: the brand, audience and references Atomik keeps in mind
   - Skills: saved runs, run again with new words
   Use the Atomik rail and the run and models dialogs in "Particl.dc.html", and the ideas, treatment, breakdown, shot list and run screens in "Particl Productions.dc.html". Every run stops at an approval gate before it spends.

4. Business ("Moleculr Business Suite"). Build these pages:
   - Image ads: branded stills from your products and references, on Particl's API key
   - Setup: Particl's own saved products, brand kit and reference ad
   - Brand: a brand kit read from a website, reviewed before it is used
   - Product: approved facts and original photographs
   - Format: eighteen creative briefs in six formats, made in Gen
   - Hooks: up to twelve opening lines, written against the brief
   - Reference: a video you own, reviewed for what to adapt
   - Design: a poster designer with editable layers, exported as a full-size PNG

5. Viral ("Subatomik Viral Studio") and Crew.
   - Viral: Motion Transfer (recast the motion you own) and Object Swap (one element replaced), each a composer with one to eight references and a live price. Then History: every result, kept as the original file.
   - Crew: Room (a room of Grok agents, one per department, who propose, challenge each other, then the chair converges), Members (role cards the room can seat) and Sessions (every room this project has run, with its solutions and settled cost).

6. Phone. Rebuild "Particl iPhone.dc.html" in this shell's Graphite look:
   - flat, with no Liquid Glass (ignore GLASS_SPEC)
   - Home as the suite picker
   - the bottom dock, sheets, and a pinned, priced primary button
   - nothing smaller than 12px text or 44px touch targets

When all six steps are done, check every deep link still works, then export a handoff for Claude Code.
