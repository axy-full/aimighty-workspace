Particl · prototype v12 · frozen for engineering · bug fixes on v11, no new features · written 2026-10-10

PRICES STILL MARKED "CONFIRM" — check against CLAUDE.md § Pricing before build
  2 cr    Nano Banana 2 · one frame / redraw / fix / finished panel / upscale   (brief says 2 cr; the rate card lists 1 cr)
  8 cr    "4 stills" on the join sheet = 4 × 2 cr                               (follows the Nano Banana 2 row)
  10 cr   "Change MAYA · 5 shots will redraw" = 5 × 2 cr                        (follows the Nano Banana 2 row)
  16 cr   Redraw all (8 × 2 cr)                                                  (follows the Nano Banana 2 row)
  11 cr + N   Recipe total: Still 2 + Upscale 2 + Video 7 + Lip-sync N          (no rate-card row for Lip-sync)
  4 cr    Make turnaround · board start · Atomik thinking per ask               (from the code)
  8 cr    Moodboard · Variations (4 stills)                                      (from the code)
  up to 12 cr   Start from a tile                                                (from the code)
  Plan step: Starter 500 cr · $50 · Studio 2,000 cr · $180 · Team 6,000 cr · $500   (placeholders)
  Typical render times: Seedance 2.5 2–4 min · Kling 3.0 Standard 1–2 min · Nano Banana 2 20–40 s · ElevenLabs ~15 s   (placeholders from job history)
  Low-credit threshold 100 cr                                                    (placeholder)
  On the rate card as-is: 43 cr Seedance 2.5 · 5 s · 1080p · 7 cr Kling 3.0 Standard · 5 s · 128 cr Make 8 shots (2 × 43 + 6 × 7) · 256 cr fix allowance (2 × 128) · free Ask, Approve, Reject, Lock, Download, Attach, Request access.


Open "Particl prototype.dc.html" with support.js and assets/ beside it. React, ReactDOM and Babel load from assets/vendor; the three Dune Studies stills load from particl.app (local fallback in assets/) and Geist from Google Fonts (system fallback), so imagery and type need a connection. Desktop, 1180 px or wider (1440 × 900 is the design size); phone frames render as a 390 × 844 shell. If it stays black over file://, run "python3 -m http.server" in this folder. "Prototype v11 screens.dc.html" shows the v11 screens first (V11·1 …), then earlier rounds. Everything from v10 not listed below is unchanged.

A · RENDERING (jobs take 2–5 min)
A rendering card keeps its source visible — the storyboard frame or reference still, blurred and dimmed — under a slow particle field that echoes the logo's dots (no spinner). When the take is ready the particles gather into the frame (≈0.6 s) and the result shows (?demo=reveal). Honest time: "Seedance 2.5 · usually 2–4 min · 1:12 so far"; a thin bar fills to ~90 % over the typical time, then holds with a soft shimmer; never 99 %. Stages in plain words: In queue (position N) → Preparing → Rendering → Saving. Money once: "43 cr held · charged only when it's ready". A small Cancel on the card (never Esc) with the billed-what line in its tooltip. Past 2× the typical time: "Taking longer than usual — the provider is slow right now. Still working; you won't be charged twice." (no red). Failed: "Didn't finish · nothing billed · Retry · N cr". Batches: the stage header reads "3 of 8 ready · about 4 min left"; finished takes can be approved while others render. Elsewhere: the board tab shows a progress ring; the header's running pill lists every running job with time left and "Open card"; a finished job raises "Shot 3 is ready · View" bottom-centre; the first job over a minute offers "Tell me when it's done" (browser notification, opt-in); the browser tab title reads "(N ready) Particl". The same states show in Make tiles and on Rig shot nodes.
Typical times are placeholders from Particl's job history: Seedance 2.5 · 2–4 min · Kling 3.0 Standard · 1–2 min · Nano Banana 2 · 20–40 s · ElevenLabs · ~15 s (confirm).

B · FIXES ON v10
Storyboard and Shots keep one even gap at 4 across (Tidy too). Elements: 4 across; the Approved button is gone where the status already says Approved; cards clear the bottom controls; "Added by you" is out of the breadcrumb. Rig: thumbnails crop to the subject (faces for characters, products centred); shot names wrap to two lines; inputs | shots | Takes · Cut · Masters as three thumbnail nodes; the first-time hint sits above the bar; column headings in Geist sentence case.

C · FIRST-TIME VISITORS (?guest=1 · Particl is invite-only)
Visitors see the same app, laid out the same way. Header: logo · Home · Make · one tab "Sample · Dune Studies" · the search field · "Log in" (text) · "Request access" (filled). No avatar, credits, Activity pill; + opens the join sheet. Home: the full wall "Made with Particl" (Particl's own sample work only), no Waiting for you / Your boards, a "How it works" row (Describe it → Atomik plans the stages → Approve as it's made → Deliver in every size and language), the bar as in v10. Make: composer and tabs work; results are marked "Sample"; download, Send to board and Keep in Library open the join sheet. Sample board: every stage, Canvas / List / Strip / Rig, the tray, tooltips, right-click menus; cards move but a pill says "Sample · changes on the sample aren't saved"; Approve, Lock, Redraw, Fix, Make, Upload, Download and Attach open the join sheet.
The join sheet opens on: Start / Make / Ask / Enter in any bar or the search field; any priced action; Upload / Attach; Download; "Make one like this" / Remix; + new board. A centred modal: what they were doing with their prompt, two paths side by side — "I have an invite" (code → Continue with Google · Continue with email) and "Request access" (name, work email, company, role, "What do you want to make?" pre-filled) → "You're on the list. We'll email you when your invite is ready; your prompt is saved for when you're in." — plus "Already a member? Log in" and "Your work stays private to your workspace." Esc or × closes it and keeps the typed text.
Invite links (?invite=team | new | expired): a slim banner under the header; the sheet opens with the code pre-filled and the inviter shown. Team invite → "Join ZigZag Films' workspace" → Continue with Google / email. New-workspace invite → "Create your workspace" (name) → "Choose a plan / add credits" (placeholder prices, confirm). Expired or used → "This invite has expired or been used · Request access". After joining (?joined=1) they land back on Home with the prompt kept and the price shown.
Privacy: the wall only shows Particl's public showcase; search, ⌘K and Atomik never return another workspace's boards, names or assets; a link to another workspace's board opens "You don't have access" (Log in / Request access), never a preview.

URLS
Rendering
  ?view=board&stage=Shots&render=queued        In queue · position 7 · source visible under the particle field
  ?view=board&stage=Shots&render=rendering     Rendering · 1:12 so far · 7 cr held · Cancel
  ?view=board&stage=Shots&render=slow          Taking longer than usual
  ?view=board&stage=Shots&render=failed        Didn't finish · nothing billed · Retry · 7 cr
  ?view=board&stage=Shots&render=batch         3 of 8 ready · about 4 min left; approve finished takes while others render; tab ring
  ?view=board&stage=Shots&render=batch&jobs=1  The running list from the header pill
  ?view=board&stage=Shots&render=ready         "Shot 3 is ready · View" toast; tab title "(1 ready) Particl"
  ?view=board&stage=Shots&demo=reveal          The reveal: particles gather into the frame (plays on load)
  ?view=board&stage=Shots&render=rendering&notify=1   "Tell me when it's done"
  ?view=make&render=1 · ?view=board&v=rig&render=1    The same states in Make tiles and on a Rig shot node
Fixes
  ?view=board&stage=Storyboard                 4 across, one even gap
  ?view=board&stage=Elements                   Elements, no redundant Approved button
  ?view=board&v=rig · &rig=input               Rig default (Geist headings, Takes · Cut · Masters nodes, subject crops) · MAYA selected
Visitors
  ?guest=1                                     Visitor Home: "Made with Particl" wall, How it works, Log in / Request access
  ?guest=1&view=make                           Visitor Make with "Sample" results
  ?guest=1&view=board                          Sample board · Canvas (read-only pill)
  ?guest=1&view=board&v=rig                    Sample board · Rig
  ?guest=1&join=start · &join=make · &join=upload · &join=ask   The join sheet from Start / Make / Upload / Ask Atomik
  ?guest=1&join=start&requested=1              Request-access confirmation
  ?guest=1&invite=team                         Invite banner + sheet, team invite
  ?guest=1&invite=new                          New-workspace invite ("Create your workspace")
  ?guest=1&invite=new&step=plan                Choose a plan / add credits (placeholder prices · confirm)
  ?guest=1&invite=expired                      Expired or used invite
  ?joined=1                                    After joining: Home with the prompt kept
  ?guest=1&view=board&project=other            "You don't have access"
  ?guest=1&device=phone                        Phone · visitor Home
  ?guest=1&device=phone&join=start             Phone · join sheet as a bottom sheet
  ?guest=1&device=phone&invite=team            Phone · invite banner

CHECKS (2026-10-10) — every URL rendered at 1440 × 900 and 1280 × 800 (phone at 390 × 844) and confirmed visually: Shots and Storyboard 4 across with one 24 px gap and no overlap in every render state; finished shot cards show only Approve · Reject; Rig shows Takes · Cut · Masters as thumbnail nodes aligned with the shots, faces cropped in, two-line names, hint above the bar; the desktop join sheet fits at both widths; the phone sheet is a one-column bottom sheet inside the 390 shell. No text under 12 px; one filled primary per screen.

PRICES (1 cr = $0.10; hover a price for dollars)
  43 cr Seedance 2.5 · 5 s · 1080p (held while rendering) · 7 cr Kling 3.0 Standard (held; Retry · 7 cr) · 2 cr Nano Banana 2 (as written in the brief; the rate card lists 1 cr — confirm) · 8 cr "4 stills" on the join sheet = 4 × 2 · 128 cr Make 8 shots · plan step: Starter 500 cr · $50, Studio 2,000 cr · $180, Team 6,000 cr · $500 (placeholders, confirm) · free Ask, Approve, Lock, Download, Attach, Request access.

PLACEHOLDERS
  Brands Maggi, Dune Studies, Canva · boards as in v10 · inviter "ZigZag Films" · invite codes ZZF-7K2Q, ZZF-NEW-3M · characters MAYA, GUIDE · the three stills stand in for every image, including the visitor showcase · typical render times and plan prices as marked.

KNOWN LIMITS
  Rendering states are driven by the URL (?render=…) for review; the live tick still drives Make and the Storyboard · the particle field is CSS motion, not the production shader · the reveal plays once per load · browser notifications are drawn, not requested · the invite code is not validated · the phone frames are the three visitor screens · Rig still scrolls at 1280.

DECISIONS (answers to the open questions)
  Cancel discards the take and bills nothing where the provider allows; otherwise the confirm line states what's billed.
  Time is shown as a range ("usually 1–2 min").
  One fixed sample board for every visitor.
  Request access collects an optional Company size (1–10 · 11–50 · 51–200 · 200+).
