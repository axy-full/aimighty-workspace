# Particl Prototype v31.15 · the Claude Design prompt (zip form, 22 Oct 2026)

How to use it:

1. Same window as v31.14; nothing to attach. Keep the Mac awake: `caffeinate -dimsu -t 10800`.
2. Paste everything between the two lines below as ONE message. Send the finished zip to the advisor chat.

────────────────────────────── copy from here ──────────────────────────────

You are making Particl Prototype v31.15, a revision of v31.14, the build in this window. Start from it and keep everything not named here exactly as it is. These are defects found by opening v31.14's screens; each names what was seen. Fix them and nothing else.

1. GROUP RENAME STILL DOES NOT WORK. Double-clicking CAST · 2 on Elements selects @maya and shows the "Right-click · Add node from these" tip; no field appears. A node's name (@maya) does become a field on double-click, so do the same for the group header: a native dblclick listener on the header element itself, stopPropagation, the name becomes a field, Enter commits, Esc cancels, the count stays. &rename=cast must open that state on load (in v31.14 it shows nothing).

2. DIRECTOR DOUBLE-CLICK OPENS THE INSPECTOR. On Elements in Director mode a double-click on empty canvas makes "New element" and opens "New element · Settings" on the right by itself. It must not: the Inspector stays as it was. The new card shows "What is it?" with the eight kind pills inside it (Cast · Prop · Environment · Vehicle · Wardrobe · Product · Words · World) instead of "An empty element · upload yours or let it be drawn"; Upload and Generate appear only after a kind is chosen. &new=director must show that card on load (in v31.14 it shows nothing).

3. A NEW NODE LANDS ON TOP OF OTHER CARDS. In both modes the new card is placed over the ENVIRONMENT group's cards and is counted into CAST (CAST · 3) whatever the pointer's place. The card goes where the pointer is; if the pointer is inside a group it joins that group and the group grows to hold it; if the pointer is on empty canvas it stands alone, ungrouped, until it has a kind; it never overlaps a card (nudge it to the nearest free space).

4. A STRAY NODE ON SHOTS. On Shots (both modes) a card "@maya · Cast" sits below Shot 7 at the right with a picture of a different person (a man in a kitchen). Remove it; no Elements card is drawn on the Shots canvas, and no picture that is not in assets/stills for that production is ever shown.

5. THE PANEL COVERS THE BRIEF. On Brief in Agent mode with the Atomik panel open (&q=1) the panel covers the page's action row ("Talk · up to 8 cr", "Import anything · Reading · 2–6 cr", "Back to the interview" is clipped). The page content reflows to the panel's left edge on every step, as the canvases do; nothing sits under the panel.

6. THE PHONE'S QUESTION CARD HAS THE OLD COPY. At 390×844 on Shots the sheet reads "Takes a shot?" with 1 · 2 · 3 and a "Just make it" button. Count is 1 · 2 · 3 · 4, and the button reads "Decide for me" (the only multi-word button, by the scope's rule R3). Search every screen for "Just make it" and remove it.

7. THE PHONE'S MAKE IS BROKEN. At 390×844 the composer is drawn over the "What are we making?" heading and under the Home · Make · New · Library dock, and the bar sits over the heading too. Order from the top: the pill row, the heading and its line, the composer (tiles in a row, the field, the chips wrapped, the button), Settings, the quick starts wrapped, Library and its wall in two columns; the dock at the foot, clear of everything, clear of the home indicator; the bar above the dock. Nothing overlaps.

8. "HOW PARTICL WORKS". The line under "Ten steps, in order." still says "click a card for its loop"; it reads "Tap a screen to play it." Each step band's screen runs to the page's edge on its side (full-bleed, at least 70% of the width), the text beside it in the remaining column; at the moment the screen is about half the width with margins on both sides. The twelve feature bands the same.

URLS
As v31.14. &rename=cast and &new=director render their states. One file per opening screen; README.txt with the full schema; CHANGES.txt numbered from 1.

CHECKS BEFORE YOU HAND OVER
Double-click on CAST · 2 shows a field; &rename=cast opens it. A Director double-click makes a card with "What is it?" and leaves the Inspector alone; &new=director shows it; a new card never overlaps another and joins the group under the pointer. No "@maya · Cast" on Shots; no picture outside assets/stills. The Brief's action row is fully visible with the panel open. "Just make it" appears nowhere; Count is 1 · 2 · 3 · 4 on every screen including the phone. The phone's Make stacks with no overlap and the dock clear. The How page's bands bleed to the edge; "click a card" is gone. Every button that spends shows a price; "free" is lowercase and never near Import or Upload; no engine or vendor name in Agent mode; none of these anywhere: Atomik produces, directed by Atomik, AI-powered, made with AI, token, markup, margin, seed, model, template. Open every URL at 1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440, 3008×1692 at 2× and 3840×2160 at 1×, plus 390×844 and 1024×768; nothing cut off, nothing scrolls sideways; say so only if it is true.

────────────────────────────── to here ──────────────────────────────
