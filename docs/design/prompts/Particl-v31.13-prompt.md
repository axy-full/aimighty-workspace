# Particl Prototype v31.13 · the Claude Design prompt (zip form, 22 Oct 2026)

How to use it:

1. Same window as v31.12 on this account; nothing to attach. Keep the Mac awake: `caffeinate -dimsu -t 10800`.
2. Paste everything between the two lines below as ONE message, nothing added, nothing left out.
3. Send the finished zip to the advisor chat.

────────────────────────────── copy from here ──────────────────────────────

You are making Particl Prototype v31.13, a revision of v31.12, the build in this window. Start from it and keep everything not named here exactly as it is. Read everything below before you change anything. Where this brief and v31.12 disagree, this brief wins. Two of v31.12's rules are reversed here (THE BAR and DOUBLE-CLICK); the other rules of v31.12 stand.

THE BAR GROWS; THERE IS NO SECOND LINE
Remove the line above the bar everywhere: the questions, suggestions, selection chips, "What is it?" and the scrub time no longer float above it. The bar itself grows upward instead. It is one rounded panel whose height follows its content: at rest, one row (mode switch · field · ✦ · price · button); when there is something to show, rows are added inside it above the field, the same width as the field, in this order from the top: a question or suggestion with its pills (at most four, plus the field for a typed answer); the selection's chips; the scrub time while scrubbing. Each added row is 36 px, 8 px apart; the panel grows to at most eight rows, then scrolls inside itself; nothing is ever drawn outside the panel. When the content is dismissed the bar shrinks back to one row. On the phone the same, at most five rows. The mark spins while Atomik thinks, inside the bar as built.

DOUBLE-CLICK MAKES A NODE, NOTHING MORE
Double-clicking a canvas makes a node where the pointer is and selects it. The Inspector does not open; it stays exactly as it was (open or closed). In Director mode on Elements the new node card itself shows "What is it?" with the eight kinds as pills inside the card (Cast · Prop · Environment · Vehicle · Wardrobe · Product · Words · World); choosing one gives the card its kind and its settings, which the Inspector shows when the person opens it. This reverses v31.12's rule 5; keep everything else about kinds.

RENAME WORKS
Double-click a group header (CAST · 2, ENVIRONMENT · 4 …) or a node's name (@maya, Shot 4, a Look card, a Library item) and it becomes a text field in place; Enter commits, Esc cancels; the count after a group's name stays; the new name shows everywhere the thing appears, and the rename is written to the record. Use the native dblclick event on the header and name elements and stop it reaching the canvas; the canvas's drag, select and tooltip handlers must not swallow the second click (in v31.12 a double-click on CAST · 2 only selects a card and shows the "Right-click · Add node" tip). Show &rename=cast (a group header in rename) and &rename=maya (a node's name in rename).

THE SUB-SETTINGS ARE PILLS TOO
In every panel, when a row opens, it does not open a floating box with a hairline border (v31.12's Background row opens one). The row expands in place: its options appear beneath it as a wrapped row of small pills (the chosen one lit, the others the soft fill), the rows below move down, and a second click on the row folds it. Picture pickers (Camera and light, the engine list's samples) are the same: picture tiles with no hairline, 6 px edges, the chosen one lit. This applies on Elements, Look, Storyboard, Shots, Sound, Edit, Treatment and Make's Settings row, in every tab (Settings · Engine · Inputs · Versions · Comments · Layers). No hairline-bordered menu or dropdown exists inside any panel. The canvas's right-click menus keep their form but lose their hairline: a soft-filled panel of pill rows.

"HOW PARTICL WORKS": THE STEPS AS BANDS, THE HERO CENTRED
1. The ten steps are not cards. THE WORKFLOW becomes ten full-bleed bands in the same form as the twelve feature bands: the real screen of the step drawn live at the page's full width, a small-caps mono label ("01 · BRIEF"), a heading, and two lines beside or over it, alternating left and right. No grid of cards anywhere on the page. Use these words:
   01 BRIEF · "Say what it is." · One interview, one question at a time. Format, cast, look and language are set here and never asked again.
   02 SCRIPT · "The words first." · A page, then a list, then cards. Approve the script and the cards make themselves.
   03 TREATMENT · "A deck a client signs." · The cover sets the system; every page flows from it; a client link with comments.
   04 ELEMENTS · "Your cast, your places, your product." · From a line or from your references. A face with consent on file. A place made walkable.
   05 LOOK · "Light, decided once." · Three directions inside the genre, or your LUT and your references. It carries into every frame.
   06 STORYBOARD · "Coverage, not guesses." · Frames drawn from the cast and the look, on one side of the line, playable as a cut for free.
   07 SHOTS · "One shot at a time." · Each take quoted, approved and judged. Keep one and the next begins.
   08 SOUND · "Voice, music, room." · A voice bound to each character, music under or leading, a mix that keeps the dialogue clear.
   09 EDIT · "Cut from a sentence." · Agent mode re-cuts on request. Director mode is the suite.
   10 DELIVER · "Every size. Every language." · One table, a price in every cell, previewed before you approve.
   The twelve feature bands stay as built after the steps; a step named in both (the Treatment, the Edit, Deliver) keeps both bands.
2. The hero is centred: the mark and wordmark on the page, the line "Built by filmmakers for likeminded filmmakers." and the philosophy line are centre-aligned in the column, text-align centre, at every size.

MAKE: THE WALL FILLS THE WIDTH
The wall still stops short (at 1440 four columns end at 1075 px with the fifth empty) because it uses CSS `columns`, which draws fewer columns when the content is short. Replace it: the column count is floor(width ÷ 288) (five at 1440, six at 1920, eight at 2560, two on the phone); draw a CSS grid of exactly that many equal columns across the full width between the margins, and place the cards into the columns round-robin by height (the next card goes into the shortest column) so every column is used and the last card sits at the right margin, whatever the count. A card is the column's width. This is the second time; do not leave it.

"HOW MANY" IS "COUNT"
Everywhere the word appears (Make's foot chips, the Settings row, the Inspector's Count row, the question "How many takes a shot?") it reads Count, and its values are 1 · 2 · 3 · 4 in every place, never 1 · 3. The question reads "Takes a shot?" with 1 · 2 · 3 · 4.

URLS
As v31.12, with: &rename=cast | maya · &new=director (the new card with "What is it?" inside it) · &q=1 (a question inside the grown bar) · &sel=s3,s4 (the selection's chips inside the bar) · &open=background on Elements in Director mode (the Background row opened in place). One file per opening screen; README.txt with the full schema; CHANGES.txt numbered from 1.

CHECKS BEFORE YOU HAND OVER
No line exists above the bar on any screen; the bar grows to hold questions, suggestions, selection chips and the scrub time, at most eight rows, and shrinks back. Double-click makes a node and never opens the Inspector; a new Director node on Elements asks "What is it?" on the card. Double-click renames a group header and a node name in place, Enter commits, Esc cancels, on Elements, Shots, Storyboard, Look and the Library. No hairline-bordered menu or box inside any panel on any step: opened rows expand in place as pills; picture pickers are borderless tiles. "How Particl works": ten step bands and twelve feature bands, no cards; the hero centred. Make's wall uses every column and reaches the right margin at 1280, 1440, 1920, 2560 and 3840; Count 1 · 2 · 3 · 4 everywhere, "How many" nowhere. Every button that spends shows a price; "free" is lowercase and never near Import or Upload; no engine or vendor name in Agent mode; none of these anywhere: Atomik produces, directed by Atomik, AI-powered, made with AI, token, markup, margin, seed, model, template. Open every URL at 1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440, 3008×1692 at 2× and 3840×2160 at 1×, plus 390×844 and 1024×768; nothing cut off, nothing scrolls sideways; say so only if it is true.

────────────────────────────── to here ──────────────────────────────
