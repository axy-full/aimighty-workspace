Particl · prototype v15 · on v14: board sharing between teammates · written 2026-10-13

PRICES STILL MARKED "CONFIRM" — check against CLAUDE.md § Pricing before build
  Plans · Individual (monthly): Explore $50 · 500 cr · Create $100 · 1,000 cr · Master $250 · 2,500 cr                    (placeholders · v13)
  Plans · Business (per seat per month, pooled): Business 100 $100 · 1,000 cr · Business 250 $250 · 2,500 cr · Business 500 $500 · 5,000 cr   (placeholders · v13)
  Enterprise: no price · "Get in touch"                                                                                  (v13)
  Enhance: +1 cr per make when On (Make · 9 cr for 4 stills vs 8 cr off; Kling clip 8 cr vs 7 cr; board bar Make · 3 cr vs 2 cr)   (placeholder · the real cost is the text model's tokens)
  Console › Engines: Kling 3.0 Pro · 5 s · 14 cr · Nano Banana Pro · 4K · 4 cr                                         (placeholders · not on the rate card)
  Console › Text models · $/1M tokens in · out: Claude Sonnet 4.5 $3 · $15 · Claude Haiku 4.5 $1 · $5 · GPT-5 $1.25 · $10 · GPT-5 mini $0.25 · $2 · Gemini 2.5 Pro $1.25 · $10 · Gemini 2.5 Flash $0.30 · $2.50 · Grok 4 $3 · $15 · Grok 4 Fast $0.20 · $0.50   (placeholders · read from the providers' pages before build)
  Console › Caps defaults: Welcome credits 100 · New project cap none · Warn at 80 % · Renders at once 4 · Renders an hour 60 · Storage kept 500 GB   (placeholders)
  Console sample data: workspaces, credits left, this month's spend, grants, health numbers, "Running 3ab5385 · deployed 11 Oct 17:05"   (neutral placeholders)
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


Open "Particl prototype.dc.html" with support.js and assets/ beside it (or the single-file "Particl prototype v15.html", which needs nothing beside it). Inside the prototype, the "v15 · Screens" pill bottom-right lists every screen of this round. "Prototype v15 screens.dc.html" shows them as frames with a 1280 × 800 · 1440 × 900 · 1920 × 1080 switcher. React, ReactDOM and Babel load from assets/vendor; the three Dune Studies stills load from particl.app (local fallback in assets/) and Geist from Google Fonts (system fallback), so imagery and type need a connection. Desktop, 1180 px or wider (1440 × 900 is the design size); phone frames render as a 390 × 844 shell. If it stays black over file://, run "python3 -m http.server" in this folder. Everything from v14 not listed under V15 below is unchanged.

V15 · WHAT CHANGED (everything else is v14 as it was)
The rules the design shows: every board has one owner (its maker). New boards are private in Individual workspaces and "Shared with team · Can edit" in Business ones. Three levels: Not shared (only the owner) · Can view (teammates look, can't change) · Can edit (teammates change it together, live). Members never see each other's private boards anywhere: Home, ⌘K, the + board picker, Atomik, links, Activity. Admins can deliberately open any board from "All boards" and can move ownership; when an admin opens a private board the owner sees it in the board's history — no notification, no badge. "Can edit" teammates render at the same live prices, caps and the over-200 cr admin tap. Client review links: owner and admins only. Nothing crosses workspaces.
1 · Share submenu. In the board's ⋯ menu ("Share with team · ‹state› ›") and in the tab's right-click menu ("Share with team ▸"): Not shared · "Only you" / Can view · "Teammates can look, not change" / Can edit · "Teammates can change this board with you"; the current choice is ticked. Only the owner and admins can change it; everyone else sees the state disabled with the tooltip "Only the owner or an admin can change sharing". Board cards on Home carry a small state icon — lock, eye, two-person — with a tooltip.
2 · "Viewed by" history line: "Viewed by Lena Ortiz (admin) · 12 Oct, 14:20", quiet grey, no alert, no badge.
3 · Who's editing: an avatar stack (max 3 + "+N") at the right end of the board's header row; a coloured ring = active now; hover lists names with "editing" or "viewing". A card someone else is editing has a thin outline in their colour and their initials in the corner. Nothing blocks your own work.
4 · "Changed since you opened it": a slim bar under the header — "Sam changed this board 2 min ago · your change to Shot 3 is kept until you choose" — with Reload (the screen's one filled button; the stage's next action drops to an outline while the bar shows) and "Keep my version" (quiet).
5 · Move this board to…: from ⋯ (owner and admins), a centred sheet with a people picker (members of this workspace only — avatar, name, role), "They become the owner. You keep access only if the board is shared.", Move (filled) and Cancel. After moving: toast "Board moved to Noor" with Undo for 10 s.
6 · All boards (admins only): a chip after the kind filters on Home's "Your boards" row. Same grid, plus an owner line on each card and a "Private" tag where it applies. Members never see the chip.
7 · Admin view bar: opening a member's private board shows "You're viewing Noor's private board as an admin · Noor will see this in the board's history" with "Edit anyway" (quiet) and ×. "Edit anyway" switches to editing and adds "Edited by Lena Ortiz (admin)" to the history.
A · Make bar: the Make button reserves its width (124 px) so the Enhance ⓘ no longer shifts when the price arrives.
B · Workspace settings › People: "Owner of N boards" under each name; Remove opens "Move Noor's boards to…" (the same picker) before removing — "Move and remove" (or just "Remove" when they own nothing).
Sample ownership (Northwind Films): Lena Ortiz owns Maggi Atta · 30 s ad (Can edit), Dune Studies · Mirror film (Can view), Maggi · recipe film (Not shared), Maggi Atta · launch campaign (Can edit). Sam Iyer owns Canva · launch clips and Lantern · teaser clips (Can edit). Noor Haddad owns Maggi Atta · social cut and Northwind · 15 s spot (Not shared). Jonas Weber owns Canva · pitch (Can view) and Harbor · docu boards (Not shared). As a member (?role=member) you are Noor.
Decision: in the ⋯ menu "Share with team" and "Move this board to…" sit at the top, above Versions; the share choices open in place of the menu with a ‹ back control, so the menu never grows a flyout past the window edge.

1 · Two consoles, a clear split. "Workspace settings" (?view=settings) is for each workspace's admins and shows only their own workspace — never another workspace's name, people, boards, spend or numbers. Members (?view=settings&role=member) get the smaller version: Profile, Notifications, their own usage, the plan read only. "Platform console" (?view=admin) stays owner only and never appears in a client workspace (absent from the member's avatar menu). Avatar menu, top to bottom: credits + Top up · Workspace settings · Credits & billing · Platform console (Owner badge, owner only) · Sign out — every item works.
2 · Workspace settings, in the v13 console frame (header, left column, scrolling content, no bottom bar). YOUR WORKSPACE: Overview (Credits left · Spent this month · People · Renders running; a low-credit note at 20 % left; recent activity with who, what, cost) · People (invite by email with one filled Invite; Name · Email · Role dropdown Admin / Member · Last active · ⋯ Remove, also on right-click; pending invites with Resend / Revoke; seats used vs seats on the plan) · Credits & billing (current plan card, Change plan reveals the v13 plan cards, Top up, per-board spend with Open, history, Export CSV) · Usage (by board and by person, This month / Last month) · Defaults (Enhance on/off by default; default video and still engine with today's price; default aspect) · Style rules (the same editor as the platform's, scoped to this workspace) · Limits (spend cap per board, warn at % of cap, optional monthly cap per person; Save filled, Reset to defaults quiet) · Workspace (name, logo, Leave workspace, Delete workspace — type the name to enable, quiet red). YOUR ACCOUNT: Profile (name, email, photo, Sign out) · Notifications (render ready / needs approval / credits low). Bottom of the column: "Only people in this workspace can see this." The house (?view=settings&section=billing&house=1) sees "House · pays at cost": no plan cards, no Top up.
3 · Simpler left column, both consoles: a plain label plus one grey line under it; group headings in small caps; count badges only when something needs action (requests, pending invites, failed saves, low credits). Platform console labels: Overview · Who can join · Public site · All workspaces · AI models · Style rules · Limits · Plans & prices · Failed saves.
4 · Every button works. Avatar "Settings" is now Workspace settings; Sign out shows a signed-out screen with one filled Log in (?signedout=1); billing Open opens that board (the launch campaign too); Export for billing · CSV toasts "CSV downloaded"; the three extra Home boards (Northwind · Lantern · Harbor) open their boards. Disabled buttons say why on hover: Edit prices — "Prices are set in config — checkout comes later"; Delete for good — "Type the workspace name exactly to enable"; your own Role — "Your own role — another admin changes it"; Leave workspace when you are the only admin — "Blocked — you are the only admin".
5 · Small fixes. House billing has no Top up. The low-credit warning is at 20 % of the month's credits (1,000 cr on Business 100 × 5 seats; ?credits=low shows it). "Prices are placeholders · confirm" is gone; plan prices are final. Failed saves shows its explanation once, with the column headings on their columns. The take viewer's action labels are centred. Enhance shows one total only (Make · 9 cr), never "+1 cr".
Decision: the demo account is Lena Ortiz, admin of Northwind Films (Business 100 · 5 seats · 5,000 credits a month) and also the platform owner, so one avatar menu can show both consoles. In v13 the current plan read "Create"; it is now Business 100 so People, seats and Usage by person make sense. ?view=billing still works and lands on Workspace settings › Credits & billing.

1 · The platform console (?view=admin). Owner only; never shown in a client workspace. Reached from the avatar menu › "Platform console · Owner". The v12 frame (header, no board rail), a left sub-nav, scrolling content, no bar at the bottom; the Atomik field stays in the header. Sections in order: Overview (Workspaces · People · Credits granted this month · Renders at risk, red only when > 0; Health strip Database · Storage · Background jobs · Mail · Engines with a dot and one line; "Running 3ab5385 · deployed 11 Oct 17:05") · Access (Invite someone: Email · Name · Note · Invite, filled; Invites table Email · Name · State Sent / Accepted / Expired · Note · Expires · ⋯ Resend / Revoke, also on right-click; "Asked to be let in" cards with Invite and Mark handled; empty state "Nobody waiting.") · Site (Open sign-up · Visitor pages · New interface for everyone as switches with one-line explanations; Sample workspace picker) · Workspaces (search; table Name · Owner · Plan · Seats · Credits left · This month's spend · Created · Status; the house row reads "House · pays at cost"; row click or right-click › Open opens a side sheet with plan, members, credit history, Grant credits amount + reason (filled), Pause / Resume workspace (quiet)) · Engines & models (Default video engine · Default still engine as pickers showing engine · price; Text models Prompt enhancement · Ideas and treatments · Shot lists, each a picker grouped Anthropic · OpenAI · Google · xAI with "$/1M tokens in · out" in mono; "Only models with a working key are listed.") · Rules (scope chip All · Video + still · Stills · per engine, click cycles · For the writer / In the prompt · the rule text · Remove · drag handle to reorder · + Rule) · Caps (number fields with units; Save filled · Reset to defaults quiet) · Plans (the customer cards, read only, Edit prices disabled, "Checkout comes later") · Renders at risk (workspace · take · engine · since · last error · Retry save; empty state "Nothing at risk."). Esc closes the sheet, a picker or a menu first. Decision: on Access the form's Invite is the one filled primary; the request cards' Invite is the blue outline, so the screen keeps one filled primary.
2 · Header, all signed-in screens and the visitor. Logo · board tabs · the Atomik field directly after the tabs, flexible: it grows into free space up to 560 px and never below 280 px · right corner: Activity pill then avatar (visitor: Log in, then Request access filled), pinned to the right edge with the logo's 16 px margin. When space runs out the field shrinks first (to 280), then tabs overflow into "+N ▾"; the pill and avatar never move. At 1440 × 900 three board tabs show, at 1280 two, at 1920 six.
3 · Enhance replaces "Improve prompt" everywhere. In every composer that makes a take (Make, all tabs; the board bar when a placed image or video card is selected) a compact switch "Enhance" with ⓘ sits before the Make button; default On. The ⓘ tooltip (hover, focus, or click to pin): "Enhance — On: Particl rewrites your prompt for the chosen engine (light, camera, detail) before it runs. Its small cost is included in the price shown. Off: your prompt is sent exactly as you typed it." The Make price includes it (9 cr on, 8 cr off for 4 stills). The viewer labels the prompt "Enhanced" or "Raw"; enhanced takes have "See original", which reveals what was typed.
4 · Plans in Settings › Credits & billing and on the new-workspace "Choose a plan" step. Toggle Individual · Business. Individual (monthly): Explore $50 · 500 credits "For trying Particl: first films and campaigns." · Create $100 · 1,000 "For making every week." · Master $250 · 2,500 "For full productions." Business (one shared workspace, per seat per month, credits pooled; heading "Business — from $100 per seat"): Business 100 · 250 · 500 at $100 · $250 · $500 a seat with 1,000 · 2,500 · 5,000 credits a seat; a seats stepper shows the total ("5 seats · $1,250/month · 12,500 credits"). Enterprise card "Enterprise — for large studios and agencies" · Get in touch, no price. The house workspace (?house=1) sees no plans, just "House · pays at cost". On billing the current plan is Create; the other cards say Choose (checkout comes later); Top up stays the one filled primary.

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
V15
  ?view=board&share=menu                       Share submenu · owner · Can edit ticked
  ?view=board&share=menu&role=member           Share submenu as a member · disabled, tooltip
  ?view=home&cards=sharestate                  Board cards with the lock · eye · two-person icon
  ?view=board&history=viewed                   History drawer with the "Viewed by Lena Ortiz (admin)" line
  ?view=board&editors=3                        Avatar stack · 3 + "+1" · hover lists names
  ?view=board&editing=card                     Shot 2 outlined in Sam's colour with "SI"
  ?view=board&changed=1                        "Sam changed this board 2 min ago" · Reload · Keep my version
  ?view=board&transfer=1                       Move this board to… sheet
  ?view=board&transfer=done                    After moving · toast with Undo (10 s) · owner now Noor
  ?view=home&boards=all                        All boards (admin) · owner line · Private tag · click a private one for the admin view bar
  ?view=home&role=member                       Home as Noor · no All boards chip · nobody else's private boards
  ?view=board&adminview=1                      Admin view bar on Noor's private board
  ?view=board&adminview=editing                After "Edit anyway" · History open with the "Edited by" line
  ?view=make                                   Make bar · ⓘ does not jump
  ?view=settings&section=people&remove=1       People · "Move Noor's boards to…" before removing
  All v14 and v13 URLs below still work.
V14
  ?view=settings                               Workspace settings · Overview
  ?view=settings&section=people                People · invite, roles, ⋯ Remove (or right-click), pending invites
  ?view=settings&section=billing               Credits & billing · current plan · Change plan · Top up · history · Export CSV   (?view=billing lands here too)
  ?view=settings&section=usage                 Usage · by board · by person · This / Last month
  ?view=settings&section=defaults              Defaults · Enhance · engines · aspect
  ?view=settings&section=rules                 Style rules · this workspace only
  ?view=settings&section=limits                Limits · Save (filled) · Reset to defaults
  ?view=settings&section=workspace             Workspace · name · logo · Leave · Delete (type the name)
  ?view=settings&section=profile               Profile · Save · Change photo · Sign out
  ?view=settings&section=notifications         Notifications · three switches
  ?view=settings&role=member                   The member's smaller view (Your usage · Plan read only · Profile · Notifications)
  ?view=settings&section=billing&house=1       House · pays at cost · no plan cards, no Top up
  ?view=home&acct=1                            Avatar menu open
  ?signedout=1                                 Signed-out screen · Log in
  ?view=home&credits=low                       Low-credit pill in the header and the note on Overview
  All v13 URLs below still work.
V13
  ?view=admin                                  Platform console · Overview
  ?view=admin&section=access                   Access · invite form, invites table (⋯ or right-click a row), requests
  ?view=admin&section=site                     Site · switches, sample workspace
  ?view=admin&section=workspaces               Workspaces · table, search · &ws=northwind opens the side sheet
  ?view=admin&section=engines                  Engines & models · pickers grouped by provider
  ?view=admin&section=rules                    Rules · drag to reorder, + Rule
  ?view=admin&section=caps                     Caps · Save (filled) · Reset to defaults
  ?view=admin&section=plans                    Plans · read only · Edit prices disabled
  ?view=admin&section=risk                     Renders at risk · Retry save (both rows → "Nothing at risk.")
  ?view=make                                   Enhance toggle on · Make · 9 cr
  ?view=make&enhance=off                       Enhance off · Make · 8 cr
  ?view=make&tip=enhance                       The Enhance tooltip pinned open
  ?view=make&viewer=1                          Viewer · "Enhanced" label · See original
  ?view=billing&plans=individual               Plans · Individual (Create is current)
  ?view=billing&plans=business                 Plans · Business · seats stepper
  ?view=billing&house=1                        House workspace · "House · pays at cost", no plans
  ?guest=1&invite=new&step=plan                Choose a plan · new workspace (Individual · Business)
  ?view=home&tabs=1 · ?view=home&tabs=10       Header with 1 tab and with 10 tabs (field grows to 560 / shrinks to 280, then +N ▾)
  ?guest=1                                     Visitor header · Log in · Request access pinned right
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

CHECKS (2026-10-13, v15) — every V15 URL rendered at 1440 × 900, 1280 × 800 and 1920 × 1080 and confirmed visually: no overlap, no cut text, nothing hidden under a bar (the changed/admin bars push the canvas down, they do not cover it), one filled primary per screen (changed bar: Reload — the stage's next action becomes an outline; transfer sheet: Move; People: Invite, with "Move and remove" inside the modal), no text under 12 px except the 11 px "Private" caps tag (raise to 12 px if you prefer). Every new button, menu item, chip and choice was clicked and does something visible: share choices change the state and the card icon with an Undo toast; the back arrow returns to the menu; All boards toggles the grid and the owner lines; a private card opens the admin view; Edit anyway changes the bar and the history; Reload / Keep my version each close the bar with a toast; the picker ticks, Move / Move and remove change ownership (and the "Owner of N boards" lines) with Undo; Cancel and Esc close the sheet; the tab's right-click "Share with team ▸" opens the same panel. Intentionally disabled: the three share choices for a non-owner member — tooltip "Only the owner or an admin can change sharing"; Move / Move and remove until a person is picked — tooltip "Pick a person first".
CHECKS (2026-10-11, v14) — every V14 URL rendered at 1440 × 900, 1280 × 800 and 1920 × 1080 and confirmed visually: no overlap, no cut text, nothing under a bar (the consoles have none), one filled primary per screen (Overview: Top up in the low-credit note, only when low; People: the form's Invite; Credits & billing: Top up — Current plan and Choose are outlines; Limits, Workspace, Profile: Save; Signed out: Log in; Platform console unchanged), no text under 12 px (the grey nav lines are 12 px at 60 % white). Every button, switch, dropdown and menu item on every V14 URL was clicked and does something visible (a change, a sheet, a menu or a toast). Intentionally disabled: Edit prices (Plans & prices), Delete for good until the name is typed, your own Role dropdown — each says why on hover.
CHECKS (2026-10-11, v13) — every V13 URL rendered at 1440 × 900, 1280 × 800 and 1920 × 1080 and confirmed visually: no overlap, no cut text, nothing under a bar (the console has none), the header's right group pinned to the right edge at every width with the Atomik field between 280 and 560 px, the Enhance tooltip fully visible above the composer, one filled primary per screen (Access: the form's Invite; Workspaces sheet: Grant credits; Caps: Save; Make: Make; billing: Top up; plan step: Continue). The v12 checks below still hold: Shots and Storyboard 4 across with one 24 px gap and no overlap in every render state; finished shot cards show only Approve · Reject; Rig shows Takes · Cut · Masters as thumbnail nodes aligned with the shots, faces cropped in, two-line names, hint above the bar; the desktop join sheet fits at both widths; the phone sheet is a one-column bottom sheet inside the 390 shell. No text under 12 px; one filled primary per screen.

PRICES (1 cr = $0.10; hover a price for dollars)
  43 cr Seedance 2.5 · 5 s · 1080p (held while rendering) · 7 cr Kling 3.0 Standard (held; Retry · 7 cr) · 2 cr Nano Banana 2 (as written in the brief; the rate card lists 1 cr — confirm) · 8 cr "4 stills" on the join sheet = 4 × 2 · 128 cr Make 8 shots · plan step: Starter 500 cr · $50, Studio 2,000 cr · $180, Team 6,000 cr · $500 (placeholders, confirm) · free Ask, Approve, Lock, Download, Attach, Request access.

PLACEHOLDERS
  v15: presence (Sam editing, Noor viewing, Jonas editing, Ana viewing), the "2 min ago" change and the viewed/edited timestamps are staged. Live editing itself is not simulated; only its surfaces are.
  v14: Northwind Films, its people (Lena Ortiz · Sam Iyer · Noor Haddad · Jonas Weber · Ana), usage and activity numbers are invented. Upload logo / Change photo / Export CSV / Delete workspace stop at a toast in the prototype.
  v13: console workspaces Northwind Films · Studio Nine · Blue Harbor Agency · Saffron Studio · Kite & Co · Ferro Film and their people are invented; invites and requests likewise; the three extra boards for the 10-tab header (Northwind · 15 s spot, Lantern · teaser clips, Harbor · docu boards) are neutral names.
  Brands Maggi, Dune Studies, Canva · boards as in v10 · inviter "ZigZag Films" · invite codes ZZF-7K2Q, ZZF-NEW-3M · characters MAYA, GUIDE · the three stills stand in for every image, including the visitor showcase · typical render times and plan prices as marked.

KNOWN LIMITS
  v15: sharing state lives in the page; reload resets it. Member identity (Noor) comes from the URL. The canvas right-click menu does not carry the share entry — the tab's right-click menu and ⋯ do.
  v14: role (admin / member) and house come from the URL, not from sign-in. Sign out and Log in are one screen; there is no password step. Seats cannot be added from People yet (the toast points to Credits & billing).
  v13: the console is one owner account; there is no sign-in gate in the prototype (guests never see it). Caps "Save" only confirms. The text-model prices are typed in, not fetched. Tab overflow is computed from the window width (160 px a tab), not measured.
  Rendering states are driven by the URL (?render=…) for review; the live tick still drives Make and the Storyboard · the particle field is CSS motion, not the production shader · the reveal plays once per load · browser notifications are drawn, not requested · the invite code is not validated · the phone frames are the three visitor screens · Rig still scrolls at 1280.

DECISIONS (answers to the open questions)
  Cancel discards the take and bills nothing where the provider allows; otherwise the confirm line states what's billed.
  Time is shown as a range ("usually 1–2 min").
  One fixed sample board for every visitor.
  Request access collects an optional Company size (1–10 · 11–50 · 51–200 · 200+).
