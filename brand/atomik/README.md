# atomik — brand assets (sub-brand of particl studio)

Direction 1a "compressed trail". Same type and color system as particl; the mark is the
differentiator, not a new palette.

## Files
- svg/ — logo mark and app icon, vector, two grounds
- png/ — mark, wordmark, horizontal + stacked lockups, app icon (transparent, 4x)
- Brand sheet: Atomik Brand Assets.dc.html

## Mark
Six dots on a flatter, shorter arc than particl's, radii 3 → 16 on the 200 grid:
(50,116,3) (68,103,5) (89,96,7) (111,97,9.5) (132,106,12.5) (150,123,16).
Read: particl accelerates; atomik has already arrived — one fewer step, much heavier terminal mass.
Never rotate, recolor per-dot, or add strokes.

## Wordmark
"atomık" in Outfit 600, tracking -0.03em, dotless ı with a ring tittle
(ring 0.17em diameter, 0.04em stroke, centered over the ı, 0.09em from the em-box top).
"BY PARTICL" in Kode Mono 500, uppercase, tracking 0.36em, right-aligned under the last letter,
at 0.21x the wordmark size. Use "PARTICL STUDIO" instead where the parent needs the full name.
Vector wordmark: rebuild from this recipe and outline the type (Outfit, Kode Mono — Google Fonts).

## Color
Unchanged from particl:
- Ink on dark #F5F6F8 · ground #0B0D11 (panel) / #1D1F24 (page)
- Ink on light #15171C · ground #FCFCFD (panel) / #ECEDEF (page)
- Muted #8A8E96 (dark) / #666A72 (light)

## Clear space
At least the height of the largest dot (16 units on the 200 grid) around the mark.
In the horizontal lockup the wordmark sits one mark-height away.

---

## Where this lives in the app

The mark is rebuilt from the numbers above in `components/AtomikMark.tsx`
(`ATOMIK_TRAIL`), not imported as a file, so it takes `currentColor` and
stays crisp at 17px in a menu row. The SVGs here are the reference to check
it against — if the two ever disagree, these are right.

The wordmark deliberately reuses particl's `.wordmark-*` rules in
`app/globals.css`: the dotless ı with a ring tittle is the same
construction at the same measurements, and a second copy would drift the
first time either was touched. Only the tag beneath differs — BY PARTICL
rather than STUDIO.

The app icon stays particl's. atomik is a section of the app, not a
separate install, so the icons here are for a future standalone surface.
