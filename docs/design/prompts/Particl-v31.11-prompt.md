# Particl Prototype v31.11 · the Claude Design prompt (zip form, 22 Oct 2026)

How to use it:

1. Same window as v31.10 on this account; nothing to attach. Keep the Mac awake: `caffeinate -dimsu -t 10800`.
2. Paste everything between the two lines below as ONE message, nothing added, nothing left out.
3. Send the finished zip to the advisor chat.

────────────────────────────── copy from here ──────────────────────────────

You are making Particl Prototype v31.11, a revision of v31.10, the build in this window. Start from it and keep everything not named here exactly as it is. The rules of v31.7 stand. Read everything below before you change anything. Where this brief and v31.10 disagree, this brief wins.

THE ROWS IN EVERY PANEL
Every option row in the Inspector and its tabs (Settings · Engine · Inputs · Versions · Comments · Layers) and in the Treatment's tabs (Design · Text · Image · Page · Narration · Versions · Export · Present) is drawn the way the Versions row is drawn in v31.10: one filled pill the full width of the panel, a soft dark fill, no hairline box, a leading dot or small icon, the name at the left, the value at the right in mono, a chevron only when the row opens something; 8 px between rows; the lit or chosen row a shade lighter. The engine list is the same rows (dot · name · kind in small caps · price in mono), not bordered boxes. Section headings stay as small caps above their rows. The panel, the rail and its tiles keep the 6 px edges of v31.10; it is the rows inside that become pills. The same rows in the Library's list views, the + menu, Settings and Top up.

MAKE, THE LAST FIXES
1. On Make the bar at the bottom is gone: the composer is the bar there. The Agent · Director switch, the field, the tiles and the button live in the composer only. Everywhere else the bar stays as built.
2. The reference tile inside the composer is a 56 px square with its × at the corner, as the prompt asked, not a 24 px thumbnail; up to six in a row.
3. When nothing has been made in Make, the wall shows "From your Library" with the last twelve things from the Library (stills, clips, sound), so the room is never empty; "What you make lands here" is the line above them. Once something is made, "Made here" takes over as built.
4. The top-centre pill reads "Make · one question, then a quote" in Agent mode and "Make · the generator" in Director mode; its first line is never empty.

TREATMENT, TWO FIXES
1. The FORMAT group in the toolbar is never a hole: with nothing selected it shows the page's own controls (background, transition, build order) greyed to 50%, and the moment an element is selected they swap to the element's.
2. The zoom pill (Fit · 50 · 100 · 200) sits inside the toolbar's right end and is never clipped at 1280 or 1440; the toolbar's groups shrink to icons with labels on hover under 1440 before anything is cut.

THE LIBRARY
Kept · Unkept appear only while This production is chosen. Under Everything the two toggles are absent (not greyed), and the line under the filter row reads "Everything that exists, in every production". Nothing else in the Library changes.

WORDS AND PRECISE EDITS
A still engine that spells and edits precisely joins the catalogue; in Agent mode it is never named, in Director mode it is "Ideogram 4.5 · stills · edits" in the Engine tab and on the engine list of "How Particl works", with its prices.
- Elements: a product card gains three chips on hover and in its Revise menu: "Fix the label · N cr" (the label's words redrawn legibly, the rest untouched), "Colorways · N cr" (up to five finishes from swatches; the variants land as takes on the same card, tagged by colour), "Swap the material · N cr" (Glass · Matte · Metal · Wood, one picker). A product still made from photos keeps its name legible by default and says so in its facts ("label kept").
- Look: "Look test · 3 references · N cr" on the Look canvas: drop up to three pictures and one line; one still carrying their style lands as a look card marked Test.
- Storyboard and Shots: a frame or start frame whose line names words to be shown (a sign, a screen, a headline) carries a small "Aa" glyph meaning the words will read; "Fix the text · N cr" in its Revise menu.
- The selection tool on stills: Replace · Remove · Recolour as built; after a result the strip gains "Again", a second edit on the same picture in one tap and one quote; the Versions tab shows the chain ("label fixed → amber → v3").
- Treatment: in the Insert group, "Lettering": a title or a word drawn as a picture in the deck's type and palette, placed as an image element, quoted; "Poster" joins the arrangements.
- Edit: on the TITLES track, "Title card · N cr" and "End card · N cr" make a 2K still from a line in the deck's system; "Change a word" on any title card.
- Deliver: the table gains a Words row per language: the packshot's label and the end card's title in that language without remaking the picture, priced per picture, previewed in the cell before Approve.
- Make: two quick starts, "A still with words in it" and "Fix the text".
Show Sand's Elements with the bottle's three chips and the Colorways picker open (&chips=product), Mirror's Deliver with the Words row (&deliver=words), and Mirror's Edit with a Title card on TITLES (&tab=titles).

WORLDS
A new kind of card, the World: an environment made walkable. On Elements every Environment card gains "Make a world · N cr" in its right-click menu and in its Revise menu; in Agent mode Atomik offers it when a film has more than two shots in one place ("Three shots in the flat: make it a world so every angle matches · 24 cr"). A world card sits beside the environment that made it, marked World, with a small cube badge; on it "Light it as · <the Look's name> · N cr" takes the Look's light (before and after on the card); its Quick Look is a walkable view (drag to look, scroll to move, a reset button) with two actions under it: "Angle · N cr" (pick a shot size, a lens and a camera position on a small top-down map, get a still that lands as a Storyboard frame or as a Start frame row, with a camera glyph on the card that reopens the map to nudge it) and "Move · N cr" (draw a path on the map, pick a length, get a camera-move clip that lands as a "Reference clip" row on a take, so the shot follows that camera, or as the shot itself in the Pre-vis film type, whose Shots step is Moves only, no take engine). A Treatment arrangement "World page" embeds the walkthrough with a caption and works on the Client link; Deliver's extras gain "Export the world · mesh · splat · free". A world can also be made from a drop: several photos of a place, a panorama or a clip dropped on Elements, then "Make a world" on the group. On Storyboard and in the Pre-vis film type, a frame card offers "Frame from the world" when its environment has one; on Shots a take's Start frame row can read "Angle 3 · @flat · world". The record carries each world ("World · @flat · from 4 photos") and the angles taken from it. The Library's types gain Worlds. In Director mode the world's engine shows in the Engine tab like any other; in Agent mode nothing names it. Show Mirror's Elements with a world beside @flat (&world=1), its Quick Look (&world=1&sel=flat-world), and Shot 3 on Shots with "Angle 2 · @flat · world" as its Start frame row.

URLS
As v31.10, with: &world=1 · &sel=flat-world · &lib=worlds · &chips=product · &deliver=words · &tab=titles · &look=test. One file per opening screen; README.txt with the full schema; CHANGES.txt numbered from 1.

CHECKS BEFORE YOU HAND OVER
Every option row in every panel is a filled pill with dot · name · value, no bordered boxes anywhere, the engine list included; panels and tiles keep 6 px edges. Make has no bottom bar, 56 px tiles, "From your Library" when empty, a filled top-centre pill. Treatment's FORMAT group is never empty and the zoom pill is never clipped. The Library hides Kept · Unkept under Everything. Words: the three product chips and the Colorways takes on Sand's bottle, the Look test card, the Aa glyph, Again on the selection strip, Lettering in the Treatment's Insert group, Title card on TITLES, the Words row on Deliver, the two Make quick starts; "Ideogram 4.5 · stills · edits" only in Director's Engine tab and the engine list. Worlds: a world card beside @flat with "Light it as", its walkable Quick Look with Angle and Move, "Frame from the world" on Storyboard, "Angle 2 · @flat · world" on Shot 3, Worlds in the Library's types; no engine named in Agent mode. Every button that spends shows a price; "free" is lowercase and never near Import or Upload; none of these anywhere: Atomik produces, directed by Atomik, AI-powered, made with AI, token, markup, margin, seed, model, template. Open every URL at 1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440, 3008×1692 at 2× and 3840×2160 at 1×, plus 390×844 and 1024×768; nothing cut off, nothing scrolls sideways; say so only if it is true.

────────────────────────────── to here ──────────────────────────────
