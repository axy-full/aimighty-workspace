import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

/**
 * The one typeface, bundled in public/fonts (SIL Open Font License, see OFL-Outfit.txt). It is
 * loaded from the bundle's own files: nothing is fetched from the network. A render waits for it.
 */
export const FONT_FAMILY = "ParticlExport";

const FACES: { file: string; range: string }[] = [
  { file: "fonts/outfit-latin-wght-normal.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { file: "fonts/outfit-latin-ext-wght-normal.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
];

let started = false;

export function loadFonts(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  const handle = delayRender("Loading the bundled typeface", { timeoutInMilliseconds: 30_000 });
  Promise.all(
    FACES.map((face) => new FontFace(FONT_FAMILY, `url(${staticFile(face.file)})`, { weight: "100 900", unicodeRange: face.range }).load()),
  )
    .then((loaded) => {
      loaded.forEach((font) => document.fonts.add(font));
      continueRender(handle);
    })
    .catch((error) => cancelRender(error));
}
