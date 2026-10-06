Particl · "every gap, now" · Batch A · README · written 2026-10-06

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

FRAMES (desktop 1440 × 900 unless marked phone)
3D blocking — a card in the Storyboard and Shots regions that opens a full-screen overlay
  ?view=board&gap=blocking                          The 3D blocking card on the board, next to Shot 3
  ?view=board&gap=blocking&state=empty              Overlay, empty scene: "Add from Shot 3 · free", add a figure, a prop or a prop from a photo
  ?view=board&gap=blocking&state=building           Overlay, scene being built: viewport with the lead as a figure, the sphere, the set; objects list; camera position, height, lens 24/35/50/85 mm, frame guide; timeline for a slow push; "Use as reference for Shot 3 · free"
  ?view=board&gap=blocking&state=saved              Saved to Shot 3: the blocking frame on the shot's card; "Remake Shot 3 · 7 cr"
  ?device=phone&screen=blocking                     Phone, view only: the saved blocking frame and camera summary
Transcribe — on a video or audio card, or a Social source
  ?view=board&gap=transcribe                        The card action with its price before it runs
  ?view=board&gap=transcribe&state=running          Running: live progress on the card, time estimate, Notify me when done
  ?view=board&gap=transcribe&state=done             Transcript with timestamps, editable lines, "Use as script" (into the Brief) and "Use as captions" (into Cut)
  ?view=board&gap=transcribe&state=failed           Failed · Nothing billed · Retry
Line drawings — a card action on any frame
  ?view=board&gap=lines                             The action on the storyboard frames with its price
  ?view=board&gap=lines&state=running               Running on the card
  ?view=board&gap=lines&state=done                  A new line-art version on the same card (v1 photo, v2 lines)
Cut-out — a card action on any still
  ?view=board&gap=cutout                            The action with its price
  ?view=board&gap=cutout&state=done                 New version with the background removed (after)
  ?view=board&gap=cutout&state=done&compare=before  The before/after toggle set to before
Crew review — a panel on any board
  ?view=board&gap=crew                              Reviewers' notes per take, Approve / Reject, "Copy client link"
  ?view=board&gap=crew&state=reject                 Reject with a reason (chips and a free line)
  ?view=board&gap=client                            The client's view from the share link: approve and comment without signing in
  ?device=phone&screen=client                       Phone: the client's view
Identity — on the Cast card for the lead
  ?view=board&gap=identity                          Consent not recorded: "Record consent"; "Train Identity · 54 cr" disabled until it is
  ?view=board&gap=identity&state=consent            The consent step a person completes: whose face and voice, uses allowed, end date, the recording, the attest box
  ?view=board&gap=identity&state=recorded           Consent on file; the photos; "Train Identity · 54 cr"
  ?view=board&gap=identity&state=training           Training: progress on the card
  ?view=board&gap=identity&state=ready              Identity ready: "Use in Shot 3"
  ?view=board&gap=identity&state=failed             Training failed: Nothing billed · "Retry · 54 cr"
  ?device=phone&screen=consent                      Phone: the consent step (a person records it)
Edit & Sound — the Cut region
  ?view=board&gap=edit                              The Cut card: approved takes in order, "Open Edit & Sound"
  ?view=board&gap=edit&state=open                   Timeline of the approved takes, trims, music, voice, captions; "Render master · free"
  ?view=board&gap=edit&state=check                  Loudness check with the target chosen per deliverable (Broadcast −23 LUFS or Web & social −14 LUFS) and its result
  ?view=board&gap=edit&state=render                 Rendering the movie in your browser: progress
  ?device=phone&screen=cut                          Phone: watch the cut and approve it only

PRICES SHOWN, WITH THEIR RATE-CARD ROW
  Remake Shot 3 · 7 cr ............... Kling 3.0 Standard · 5 s (1.4 cr/s × 5)
  Train Identity · 54 cr · Retrain · 54 cr · Retry · 54 cr ... identity training 54 cr
  Use as reference for Shot 3 · free · Add from Shot 3 · free · Render master · free · Use as script / captions · free
  Transcribe · N cr .................. N cr, from the code (no rate-card row)
  Line drawings · N cr · Line drawings for all 3 · N cr ... N cr, from the code
  Cut-out · N cr ..................... N cr, from the code
  Prop from a photo · N cr ........... N cr, from the code
  Ask the crew · N cr ................ N cr, from the code (a thinking run); Atomik's own Ask / Start show up to 9 cr
  New voice line · N cr · New music · 15 s · N cr ... N cr, from the code (ElevenLabs, per character / per length)
  Retry · N cr (Transcribe failed) ... same basis as Transcribe; nothing was billed
  Rate card (CLAUDE.md § Pricing, 1 cr = $0.10): Seedance 2.5 · 1080p · 5 s = 43 cr (8.6 cr/s) · Kling 3.0 Standard · 5 s = 7 cr (1.4 cr/s) · Nano Banana Pro = 3 cr · Nano Banana 2 = 1 cr · Topaz Astra 23 / 38 cr per 5 s · identity training = 54 cr · enhance = 1 cr.

PLACEHOLDERS
  Sample production: "A 15-second film" · cast: "Lead" · people in Team: "You" (owner), "Admin", "Member" (roles, not names) · addresses: you@your-studio.com, admin@your-studio.com, member@your-studio.com, particl.si
  Images: assets/hero.webp, environment.webp, character.webp — named stand-ins for every take, plate, cast photo and clip (the real stills are generated on the site). Where they could not be fetched they are striped placeholders with the same names.

CHECKS RUN ON 2026-10-06 (every URL above, in a fresh copy of this folder)
  Text ≥ 12 px and ≥ 55 % white · phone touch targets ≥ 44 px · one filled button per screen · every spending button shows its price · no Rig, Astra (except "Topaz Astra"), Soul, Genjutsu, Moleculr, Subatomik or Higgsfield · no invented people or project names · only a person approves spending or records consent; Atomik has no approve button.

KNOWN GAPS
  - "N cr" prices: Transcribe, Line drawings, Cut-out, Prop from a photo, Ask the crew, ElevenLabs voice and music have no rate-card row yet; the buttons show "N cr" until CLAUDE.md § Pricing has one.
  - The three stills are stand-ins; the real desert-and-sphere stills are generated on the site.
  - Earlier rounds' frames inside the master (the Ads board, Activity, Approvals) still use the sample brand "Maison Aurel · Silk scarf" and the sample project "Northline", as those rounds asked; this batch's frames do not show them.
  - "Rendering the movie · 62%" on the render frame is a progress label in a disabled button, not a spend; it has no price by design.
