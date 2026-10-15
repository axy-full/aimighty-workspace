Particl · prototype v25 · fixes on v24 · written 2026-10-14

OPEN
  THE WHOLE INTERFACE, OFFLINE: keep "Particl app v25.html" and "Particl board v25.html" in the same folder and double-click "Particl app v25.html". Home, Make, Library, Settings, the Workspace settings and Platform consoles, sign-in and plans are in the app file; opening any board (Home card, tab, ⌘K) goes to the board file, and the board's logo, Home · Make tabs, project tabs, ⌘K bar and activity pill come back to the app file. Both work without a server. The .dc.html sources need a local server (python3 -m http.server).
  Particl board.dc.html      the v25 board, both modes, every board type (needs support.js and assets/ beside it)
  Particl board v25.html     the same board as one offline file
  Particl prototype.dc.html  Home, Make, Settings and the consoles, as in v20; the board’s “particl” logo goes to its Home
The board is one new component rather than a seventh layer of patches on v20’s board; the look, type, colours, v17-style bar, slim column and pop-ups carry over.

URLS (params: kind=film|previs|campaign|social|clips · mode=agent|director · step · lens=board|list|rig · sel · drop · at=card · more=1 · full=refs|describe|shotlist|charsheet|deck|clip · preview · compare=1 · role=member)
  1.    Particl board.dc.html?mode=agent&step=storyboard
        Agent · Storyboard · two questions with chips · no column, no bar
  2.    Particl board.dc.html?mode=agent&step=shots
        Agent · Shots · plan card “Render 8 shots · 344 cr · Approve” · no model names
  3.    Particl board.dc.html?mode=agent&step=shots&preview=s4&compare=1
        Agent · a card clicked → preview with versions strip and Compare
  4.    Particl board.dc.html?mode=director&step=shots
        Director · Shots · nothing selected · rail progress · scope pill · column · bar
  5.    Particl board.dc.html?mode=director&step=shots&sel=s4&drop=quality&at=card
        Director · Shot 4 selected · outline, chips, column header and button say Shot 4 · Quality pop-up beside the card
  6a.   Particl board.dc.html?mode=director&step=shots&sel=s4,s5&hover=button
        Director · hovering the button lights the targeted cards
  6b.   Particl board.dc.html?mode=director&step=shots&hover=camera
        Director · hovering Camera outlines the cards set differently, dims the rest
  7a.   Particl board.dc.html?mode=director&step=shots&sel=s4&drop=refs
        Director · References pop-up · roles and limits
  7b.   Particl board.dc.html?mode=director&step=shots&sel=s4&full=refs
        Director · References · Open full sheet
  8a.   Particl board.dc.html?mode=director&step=shots&drop=camera&more=1
        Director · Camera pop-up · move tiles · More open
  8b.   Particl board.dc.html?mode=director&step=shots&sel=s4&drop=describe&typing=1&help=1
        Director · Describe · Help me write it
  9.    Particl board.dc.html?mode=director&step=shots&sel=s4&preview=s4
        Director · preview of a video take · column and bar beside it
  10a.  Particl board.dc.html?mode=director&step=shots&lens=list&sel=s4
        List view · a row selected
  10b.  Particl board.dc.html?mode=director&step=shots&lens=rig&sel=s4
        Rig view · a node selected
  11.   Particl board.dc.html?mode=director&step=edit
        Edit · animatic on the timeline · Shot 4 replaced its frame
  12a.  Particl board.dc.html?mode=director&step=brief&drop=blength&len=1:45&ratio=2:1
        Brief · Length 1:45 · custom ratio
  12b.  Particl board.dc.html?mode=director&step=locations&source=Live%20location&drop=live
        Locations · Live location
  12c.  Particl board.dc.html?mode=director&step=pitch&drop=deckstyle&more=1
        Pitch · Deck style · More open
  13a.  Particl board.dc.html?kind=campaign&mode=director&step=formats&drop=ratios
        Campaign · Formats
  13b.  Particl board.dc.html?kind=social&mode=director&step=captions&drop=cstyle
        Social, narrated · Captions
  13c.  Particl board.dc.html?kind=clips&mode=director&step=moments&drop=howmany
        Social clips · Moments
  14.   Particl board.dc.html?mode=agent&step=storyboard&modehover=1
        Mode switch hovered · Take over in Agent mode

V22 URLS (new states)
  Walk a Film board in Agent, from Pitch:   Particl board.dc.html?mode=agent&kind=film&fresh=1
  Walk a Film board in Director, from Pitch: Particl board.dc.html?mode=director&kind=film&fresh=1
  Agent hand-off (Go to …):                 Particl board.dc.html?mode=agent&step=pitch&flow=handoff
  Agent progress after Approve:              Particl board.dc.html?mode=agent&step=shots&flow=making
  Director · Making… · Cancel:               Particl board.dc.html?mode=director&step=shots&flow=making
  Director · Next: Edit → (step done):       Particl board.dc.html?mode=director&step=shots&flow=done
  Approved step · Rewrite + Next:            Particl board.dc.html?mode=director&step=brief
  Brief · Length 1:45 updates the Spec card: Particl board.dc.html?mode=director&step=brief&len=1:45
  Rail at 800 px (one line per step):        any URL above in a 1280 × 800 window
  Logo icon on cards, header and tab:        Particl board.dc.html?mode=director&step=brief&logo=1  (without &logo=1: the client’s letter tile)
  Cast · voice card chips:                   Particl board.dc.html?mode=director&step=cast&sel=cast3
  Pitch · 6 of 12 shown · Open deck:         Particl board.dc.html?mode=director&step=pitch
  Model pop-up, Auto never names its pick:   Particl board.dc.html?mode=director&step=shots&sel=s4&drop=model  (&role=member hides Pro pick)

V24 URLS
  Director · Shots:                       Particl board.dc.html?mode=director&kind=film&step=shots
  Director · Shot 4 selected (chips only where it differs): …&step=shots&sel=s4
  Agent · Treatment from a fresh board:    Particl board.dc.html?mode=agent&kind=film&fresh=1
  Director · fresh Film walk:              Particl board.dc.html?mode=director&kind=film&fresh=1
  Social narrated, both modes:             …&kind=social&fresh=1 with &mode=agent | director
  Campaign · Pitch deck:                   Particl board.dc.html?mode=director&kind=campaign&step=pitchdeck
  Social clips (5 steps, rail shrinks):    Particl board.dc.html?mode=director&kind=clips
  Rail at 800 px:                          any URL in a 1280 × 800 window — all steps fit without scrolling
  Preview with ✓ / ✕ and versions:         …&step=shots&preview=s4
  Social narrated › Voice (new settings):  …&kind=social&step=voice&drop=vpick
  Captions › Language (translate to…):     …&kind=social&step=captions&drop=clang
  Pre-vis › Animatic (scratch voice, temp music): …&kind=previs&step=animatic
  Social clips › Clips (other languages):  …&kind=clips&step=clips&drop=olang

V25 · WHAT CHANGED (fixes only; everything else is v24)
1 · First-load layout: the canvas is measured on mount, after fonts load, and by a ResizeObserver, so the grid (3 per row at 1280, 4 at 1440, 5 at 1920), the scope pill and the bottom bar use the real canvas from the first frame.
2 · Canvas bottom padding = bottom bar height + 32 px; the last row scrolls fully clear of the bar.
3 · Agent mode: Ready cards show ✓ and ✕ on hover, exactly as in Director; ✕ reasons the same; Atomik replies with a priced plan.
4 · Hover marks never sit on text: text cards have a title row (logo tile · page title) that holds the drag handle and ✓ ✕ ⋯; the text starts below it.
5 · Selecting a card whose step has no per-card settings (Brief, Script…) shows that step's settings in the column instead of an empty panel.
6 · Text-only page cards (Treatment / Pitch deck / PPM pages) show a mini page: title row with the brand letter tile, then the first lines in small type. No large letter tile.
7 · Rail: the current step's status wraps to two lines, never "…". Right column: items tighten (40 px rows, no gap) before scrolling, so every item fits at 1280 × 800 (Model · Auto included).
8 · One shared top bar: Home, Make, Library, Settings and the consoles use the board's bar (dot logo + wordmark, Home · Make, project tabs with letter tiles, +, ⌘K bar, activity pill, avatar). The "v20" review badge is gone.
9 · The ⌘K bar sits on the right, directly left of the activity pill and avatar, fixed width (280 at 1280 · 320 at 1440 · 360 at 1920), widening by 160 px when focused — on the board and on every app screen.

CARD SYSTEM
  Card = picture (or logo / letter tile) + title + one status line. Status: Not started · Making… (bar on the picture) · Ready (· vN when more than one) · ✓ Approved · ✕ <reason>.
  Hover a Ready card: ✓ and ✕; ✕ opens reason chips for the step + one optional line (⏎ sends). Option steps (Hook, Moments): ✓ on one is the pick, the others grey out.
  Double-click or Space: Preview with versions, Compare, ✓ / ✕ for the version shown, Download, ← / →. Script preview has Script · Beats · Breakdown tabs; sound cards show a waveform.
  ⋯ / right-click: Preview · Fix › (Shots, product and text elements) · Duplicate · Remove. User-owned items (Brand kit, Reference ads, Source, live-location photos): no ✓ / ✕, Replace instead of Fix.
  Next → (Director) and Looks good, next / Go to … (Agent) approve every Ready card that isn’t ✕. Director chips appear only where a card differs from the step’s setting.

RULES
  One filled button on screen (Director’s bar button, or Agent’s Approve). Credits only. Text 12 px and up.
  Agent never names a model; the one exception is “Powered by Runway” on Shot 2’s take. Director names models only in Pro pick (Business and admins).
  Director and Agent keep separate settings: switching to Director shows Director’s standard defaults.

KEYS
  Esc closes the top thing, then clears the selection. Space (Director) quick-looks; double-click previews; ← / → step through a preview. ⌘J Atomik overlay (Director). L Library. ⇧/⌘-click or a drag box selects several.

PLACEHOLDERS
  Final 43 cr a shot, Draft 7 cr, takes multiply; Pro pick Kling 3.0 7 · Seedance 2.5 43 · Runway Gen-4 40 · Veo 3 60 cr; storyboard 2 cr a panel. Images are the three sample stills.

V23 CHECKS (2026-10-14, v25) — fresh loads, no clicks, at 1440 × 900, 1280 × 800 and 1920 × 1080: 4 · 3 · 5 cards per row; rail and column centred on the canvas area (0 px off), 16 px from their edges; scope pill and bottom bar centred between them (0 px off); canvas bottom padding 106 px (bar 58 + 16 + 32), last row scrolls clear. Hovered a Ready card in Agent (Treatment · Director's note) and Director (Shot 4): ✓ ✕ ⋯ visible, in the title row on text cards, never over text. Selected the Brief card: Type · Length · Formats · Frame rate · Story · Plan · Brand kit show. Shots column at 1280 × 800: 10 items, Model · Auto visible, no scroll. Home opens with the same top bar as the board. Zero console errors on both offline files.
CHECKS (2026-10-14) — walked Director from Pitch (&fresh=1) to Deliver using only the bar button and “Next: …”: Film (Pitch → … → Shots “Render 8 shots · 344 cr” → Making… · Cancel → Next: Edit → … → Download all) and Social narrated (Brief → … → Shots → Voice → Captions → Deliver → Download all). “Render Shot 4 · 43 cr” also goes Making… → Next: Edit →. One filled button at every step; zero console errors. All ten rail names fit uncut. Run in the preview pane; the rail is a fixed 116 px, so names fit at every window size.

KNOWN LIMITS
  v25: ✕ in Agent adds a priced reply in the chat; the actual redo is the step’s Approve. “Add step” adds a sample step so the rail’s growth can be seen; Duplicate, Remove, Replace, Fix › items and Download confirm with a toast. Header tabs, Home, Make, ⌘K and the activity pill link to the v20 prototype (Particl prototype.dc.html), which needs a local server; in the single offline file they are visual.
  v25: “Making…” is a timed simulation (about 2.5 s); “Download all” and “Rewrite…” only confirm with a toast. The logo is a sample still cropped as a stand-in. The tab favicon is the letter tile. Agent answers in the chat are remembered per step only while the page is open.
  Rendering is staged. Waveforms are drawn. “Help me write it” fields are visual; “Write it for me” fills a sample line. Open-full sheets show structure; Describe and shot-list text are editable. The sheet is 820 px wide.

CHECKS (2026-10-14) — rendered with the URLs above at 1440 × 900 (spot-checked 1280 × 800, 1920 × 1080): one filled button per screen; pop-ups ≤ 320 px, scroll inside, stay above the bar; card pop-ups sit beside their card; the scope words match in pill, column header and button; Agent has no column and no bar.
