Particl · "every gap, now" · Batch B · README · written 2026-10-06

Corrections applied (6 Oct) — to the committed master "Particl Suites.dc.html" (shared by Gaps A and Gaps B)
  1. Thinking: every "Ask · up to N cr", "Start · up to N cr" (and the other Atomik thinking buttons and lines) reads "up to 9 cr", the code's own figure: the planner's ceiling for a new board (lib/workbench/rig-agent.ts planningCredits -> plannerCeilingUsd -> quotedCredits). Never "4 cr". What a plan actually settled at ("Thinking · 4 cr · billed when Atomik planned it") is a charge, not a ceiling, and stays.
  2. The header balance matches the state shown: the short-by frames (money and Make) show 40 cr in the header.
  3. Edit & Sound: the code's own export is the browser renderer (components/workbench/MovieExport.tsx: MP4 or WebM, up to 3 minutes, keep the page open, no credits). The frames say exactly that ("Rendering the movie · 62%", "rendered in your browser"); nothing claims a server render or a device render of the master. If server rendering is wanted, "Render master" would instead be disabled with the one line "Final render arrives with server rendering."
  4. Per-shot admin cap is the code's default, 50 cr (lib/approvalRule.ts cleanShotCap). The "needs an admin" example is Shot 1 as a 10 s Seedance 2.5 shot at 86 cr; "Approve the rest" is 43 + 7 = 50 cr and leaves out only that step.
  5. Sample budget per production: 400 cr, the 80 % pause at 320 cr; the plan (93 cr) plus its fix allowance (186 cr) fits.
  6. Make: Auto enhance is on (1 cr), so the button reads "Make · 51 cr" (43 + 7 draft + 1).
  7. Team roles are the code's owner / admin / member. Only those three roles, and no per-role approval limits. The Team frame draws You (owner), Admin, Member; the budget-and-cap view for a person who is not an admin is ?role=member.
  8. The sample publishing handle is "@your-brand". Code and seed data never copy Maison Aurel, Northline or any other sample brand.
  9. Loudness target is a choice per deliverable: Broadcast −23 LUFS or Web & social −14 LUFS (Edit & Sound and Deliver).
  Also: the sample MCP token reads "ptk_example_····_····".
  Where a line below still says otherwise, this section wins.

Open "Particl Suites.dc.html" (support.js and assets/ beside it); append a URL below to its address. Desktop frames are drawn at 1440 × 900, phone frames at 390 × 844. Everything is local: React, ReactDOM and Babel load from assets/vendor; the stills are in assets/. The frames file shows every frame of this batch side by side (some browsers block iframes over file:// — run "python3 -m http.server" in this folder, or open the URLs directly).

FRAMES (desktop 1440 × 900)
Money states on the board
  ?view=board&gap=money&state=short                 Short by N cr: the plan's Approve waits; "Top up · 500 cr · $50" beside it
  ?view=board&gap=money&state=failed                A take failed: Nothing billed · "Retry · 43 cr"
  ?view=board&gap=money&state=unavailable           Engine unavailable (Kling 3.0 · no key) with the reason; "Move Shot 3 to Seedance 2.5 · 43 cr" or "Approve 2 shots · 86 cr"
  ?view=board&gap=money&state=admin                 A step needs an admin (Shot 1 as a 10 s Seedance 2.5 shot · 86 cr, over the 50 cr cap): marked, "Ask an admin", "Approve the rest · 50 cr"
  ?view=board&gap=money&state=paused                Paused at 80 % of the 400 cr budget (320 cr): "Continue · 7 cr" or Stop
Takes
  ?view=board&gap=takes                             A take in review: Approve, Reject, Change with words · 7 cr
  ?view=board&gap=takes&state=reject                Reject with a reason (chips + a free line); "Reject · spends nothing"
  ?view=board&gap=takes&state=undo                  The Undo toast after a rejection (top-right of the canvas)
Make details
  ?view=board&gap=make                              Film chips and shot control, Enhance with Auto (1 cr), aspect, Draft first (Kling 3.0 Standard · 7 cr), resolution, length, Sound, takes ×1/×2/×4; "Make · 51 cr"
  ?view=board&gap=make&state=audio                  Audio: voice (Eleven v3), music length; "Make · N cr"
  ?view=board&gap=make&state=short                  Insufficient credits: "Top up · 500 cr · $50" in place of Make
  ?view=board&gap=make&state=failed                 Failed: Nothing billed · "Retry · 43 cr"
Motion transfer and Object swap
  ?view=board&gap=motion                            Source video, start and end frames, references (drag to reorder, 1–8), live price
  ?view=board&gap=motion&state=running              Running on the card with Cancel
  ?view=board&gap=swap                              One element replaced: source, the element, its reference, live price
  ?view=board&gap=swap&state=running                Running with Cancel
Settings details
  ?view=workspace&ws=connections&token=new          New MCP token: name, scope (read / prepare jobs), monthly cap
  ?view=workspace&ws=connections&token=shown        The token shown once, Copy, Revoke; outside agents prepare jobs, a person approves each
  ?view=workspace&ws=team                           Team security: two-factor per person, roles (owner, admin, member)
  ?view=workspace&ws=rules&edit=rules               Admin editing the production budget (400 cr) and the per-shot cap (50 cr); changes save as you type ("Done", "Undo changes")
  ?view=workspace&ws=rules&edit=rules&role=member   The same as a member: read only, "Ask an admin"
Ads and Social
  ?view=board&kind=ads&gap=empty                    Empty Ads board on first open: one action (a product page or brand site) and a template row
  ?view=board&kind=social&gap=empty                 Empty Social board on first open: one action (a long video) and a template row
  ?view=board&kind=social&gap=posts                 Post states: draft, waiting for approval (a person approves), scheduled, posted, failed (Reconnect, "Retry · free")

PRICES SHOWN, WITH THEIR RATE-CARD ROW
  43 cr · Retry · 43 cr · Move Shot 3 to Seedance 2.5 · 43 cr · Needs an admin · 43 cr ... Seedance 2.5 · 1080p · 5 s (8.6 cr/s × 5)
  7 cr · Continue · 7 cr · Change with words · 7 cr · Draft first · 7 cr ... Kling 3.0 Standard · 5 s (1.4 cr/s × 5)
  51 cr (Make · 51 cr) ... 43 + 7 + 1 (Seedance 2.5 hero + Kling 3.0 Standard draft + Auto enhance)
  50 cr (Approve the rest · 50 cr) ... 43 + 7 (the plan without the over-cap step)
  86 cr (Shot 1, needs an admin) ... a 10 s Seedance 2.5 shot (8.6 cr/s × 10) · 136 cr (Make 3 shots with it) ... 86 + 43 + 7
  86 cr (×2, Approve 2 shots) ... 2 × 43 · 172 cr (×4) ... 4 × 43
  93 cr (Approve · 93 cr, Make 3 shots) ... 43 + 43 + 7 · 186 cr ... the fix allowance, 2 × 93
  1 cr (Enhance now, Auto on) ... enhance 1 cr
  320 cr / 400 cr ... the 80 % pause of the 400 cr sample budget (a setting, not a price) · 50 cr ... the per-shot admin cap (a setting; the code's default)
  Top up · 500 cr · $50 ... the Starter top-up pack (500 cr at $0.10)
  Make · N cr (audio) · voice · N cr ... N cr, from the code (ElevenLabs, per character)
  Motion transfer · 8 s · N cr · Object swap · N cr ... N cr, from the code (no rate-card row)
  Retry · free (a failed post) · Reject · spends nothing ... free
  Rate card (CLAUDE.md § Pricing, 1 cr = $0.10): Seedance 2.5 · 1080p · 5 s = 43 cr (8.6 cr/s) · Kling 3.0 Standard · 5 s = 7 cr (1.4 cr/s) · Nano Banana Pro = 3 cr · Nano Banana 2 = 1 cr · Topaz Astra 23 / 38 cr per 5 s · identity training = 54 cr · enhance = 1 cr.

PLACEHOLDERS
  Sample production: "A 15-second film" · cast: "Lead" · people in Team: "You" (owner), "Admin", "Member" (roles, not names) · addresses: you@your-studio.com, admin@your-studio.com, member@your-studio.com, particl.si
  Images: assets/hero.webp, environment.webp, character.webp — named stand-ins for every take, plate, cast photo and clip (the real stills are generated on the site). Where they could not be fetched they are striped placeholders with the same names.

CHECKS RUN ON 2026-10-06 (every URL above, in a fresh copy of this folder)
  Text ≥ 12 px and ≥ 55 % white · one filled button per screen · every spending button shows its price · no Rig, Astra (except "Topaz Astra"), Soul, Genjutsu, Moleculr, Subatomik or Higgsfield · no invented people or project names · only a person approves spending or records consent; Atomik has no approve button.

KNOWN GAPS
  - "N cr" prices: ElevenLabs voice and music, Motion transfer and Object swap have no rate-card row yet.
  - The three stills are stand-ins; the real stills are generated on the site.
  - Earlier rounds' frames inside the master (the Ads board frames 1–3, Activity, Approvals) still use "Maison Aurel · Silk scarf" and "Northline", as those rounds asked; this batch's frames do not show them.
  - On the empty Ads board the rail's "Adapt" entry is a section label, not a spending button, so it has no price.
