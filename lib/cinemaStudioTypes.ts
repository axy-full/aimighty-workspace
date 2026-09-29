import { isGenjutsuModel } from "./genjutsuTypes";

/**
 * Cinema Studio 4.0: Higgsfield's own text- and reference-to-video engine on
 * the commercial API key (`POST /higgsfield/cinema-studio/4.0`). Browser-safe
 * facts only; what it costs lives in lib/vendorRates.ts, which never reaches
 * a browser.
 */
export const CINEMA_STUDIO_MODEL_ID = "higgsfield-cinema-studio-4.0";
/** The provider's route for the model. */
export const CINEMA_STUDIO_PATH = "higgsfield/cinema-studio/4.0";
export const CINEMA_STUDIO_RESOLUTIONS = ["720p", "480p"] as const;
export const CINEMA_STUDIO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
/** The published input schema's limits. */
export const CINEMA_STUDIO_LIMITS = {
  minSeconds: 4,
  maxSeconds: 30,
  maxImages: 30,
  maxVideos: 10,
  /** Reference video is billed with the output; above this the provider normalizes it, so it is refused. */
  maxVideoSeconds: 30,
  /** Sound references (`audio_urls`), cited as <<<audio_N>>>. */
  maxAudios: 10,
  /** The provider normalizes sound to its own 30-second budget; more is refused rather than cut unseen. */
  maxAudioSeconds: 30,
  maxReferences: 50,
} as const;
/**
 * The audio types the provider documents for its inputs (its file-upload
 * guide lists WAV only). Particl's own generated sounds are MP3, so a sound
 * reference is a WAV uploaded to the workspace.
 */
export const CINEMA_STUDIO_AUDIO_MIMES: readonly string[] = ["audio/wav", "audio/x-wav"];
export const isCinemaStudioAudioMime = (mime: unknown) =>
  typeof mime === "string" && CINEMA_STUDIO_AUDIO_MIMES.includes(mime.toLowerCase());

export const isCinemaStudioModel = (model: string) => model === CINEMA_STUDIO_MODEL_ID;
/** Higgsfield video on the commercial key: one acknowledged request, polled and collected the same way. */
export const isHiggsfieldVideoModel = (model: string) =>
  isGenjutsuModel(model) || isCinemaStudioModel(model);

/* ── The creative controls ────────────────────────────────────────────── */

/**
 * The provider's documented creative controls, in the order its own form
 * lists them, each with exactly the values its input schema allows. A control
 * left out is chosen by the model itself (the schema has no "auto" value, so
 * Auto is sent as nothing at all). None of them enters the published price
 * formula, which counts only seconds and pixels.
 */
export const CINEMA_CONTROL_KEYS = [
  "camera_model", "camera_lens", "camera_aperture", "camera_movement",
  "era", "genre", "light", "pacing", "color_palette",
] as const;
export type CinemaControlKey = (typeof CINEMA_CONTROL_KEYS)[number];
export type CinemaOption = { value: string; label: string };
export type CinemaControl = { key: CinemaControlKey; label: string; options: readonly CinemaOption[] };
/** A pick per control; a control that is absent is Auto. */
export type CinemaStudioControls = Partial<Record<CinemaControlKey, string>>;

const options = (pairs: readonly (readonly [string, string])[]): CinemaOption[] => pairs.map(([value, label]) => ({ value, label }));

export const CINEMA_STUDIO_CONTROLS: readonly CinemaControl[] = [
  { key: "camera_model", label: "Camera", options: options([
    ["modern", "Modern digital"], ["35mm-film", "35mm film"], ["8mm-film", "8mm film"], ["dv-camcorder", "DV camcorder"],
  ]) },
  { key: "camera_lens", label: "Lens", options: options([
    ["clean-sharp", "Clean and sharp"], ["anamorphic", "Anamorphic"], ["vintage-anamorphic", "Vintage anamorphic"],
    ["warm-vintage", "Warm vintage"], ["halation-vintage", "Halation vintage"],
  ]) },
  { key: "camera_aperture", label: "Aperture", options: options([
    ["f14-wide-open", "f/1.4 wide open"], ["f4-moderate", "f/4 moderate"], ["f11-deep-focus", "f/11 deep focus"],
  ]) },
  { key: "camera_movement", label: "Movement", options: options([
    ["snorricam", "Snorricam"], ["robot-arm", "Robot arm"], ["tilt-up", "Tilt up"], ["rack-focus", "Rack focus"],
    ["tilt-down", "Tilt down"], ["pov", "POV"], ["pan-left", "Pan left"], ["crane-up", "Crane up"],
    ["pan-right", "Pan right"], ["crane-down", "Crane down"], ["side-tracking", "Side tracking"],
    ["pedestal-up", "Pedestal up"], ["pedestal-down", "Pedestal down"], ["handheld", "Handheld"],
    ["tracking", "Tracking"], ["drone-orbit", "Drone orbit"], ["dolly-zoom", "Dolly zoom"],
    ["aerial-pullback", "Aerial pullback"], ["static-shot", "Static shot"], ["bullet-time", "Bullet time"],
    ["whip-pan", "Whip pan"], ["slow-zoom-in", "Slow zoom in"], ["arc-left", "Arc left"],
    ["slow-zoom-out", "Slow zoom out"], ["arc-right", "Arc right"], ["truck-right", "Truck right"],
    ["dolly-in", "Dolly in"], ["truck-left", "Truck left"], ["dolly-out", "Dolly out"],
    ["slider-right", "Slider right"], ["crush-zoom", "Crush zoom"], ["slider-left", "Slider left"],
    ["helicopter-shot", "Helicopter shot"],
  ]) },
  { key: "era", label: "Era", options: options([
    ["1960s", "1960s"], ["1980s", "1980s"], ["1990s", "1990s"], ["2000s", "2000s"], ["2020s", "2020s"],
  ]) },
  { key: "genre", label: "Genre", options: options([
    ["epic", "Epic"], ["drama", "Drama"], ["noir", "Noir"], ["comedy", "Comedy"], ["horror", "Horror"], ["action", "Action"],
  ]) },
  { key: "light", label: "Light", options: options([
    ["silhouette", "Silhouette"], ["practicals", "Practicals"], ["window", "Window light"],
    ["overhead-fall", "Overhead fall"], ["contre-jour", "Contre-jour"], ["soft-cross", "Soft cross"],
  ]) },
  { key: "pacing", label: "Pacing", options: options([
    ["chaotic", "Chaotic"], ["dynamic", "Dynamic"], ["calm", "Calm"], ["single-shot", "Single shot"],
  ]) },
  { key: "color_palette", label: "Palette", options: options([
    ["static-noon", "Static Noon"], ["twilight-fable", "Twilight Fable"], ["back-row-kissing-seats", "Back Row Kissing Seats"],
    ["on-the-other-side-of-the-porthole", "On the Other Side of the Porthole"], ["the-emerald-ambush", "The Emerald Ambush"],
    ["highway-standoff", "Highway Standoff"], ["the-faded-fresco", "The Faded Fresco"], ["oil-ochre", "Oil Ochre"],
    ["the-mountain-convent", "The Mountain Convent"], ["ghost-in-the-code", "Ghost in the Code"], ["pink-velvet", "Pink Velvet"],
    ["two-days-to-the-horizon", "Two Days to the Horizon"], ["industrial-fog", "Industrial Fog"], ["stairs-go-up", "Stairs Go Up"],
    ["field-post", "Field Post"], ["home-is-the-next-gas-station", "Home Is the Next Gas Station"], ["glossy-flesh", "Glossy Flesh"],
    ["the-crimson-ballet", "The Crimson Ballet"], ["neon-rain-at-midnight", "Neon Rain at Midnight"],
    ["the-morning-after-rain", "The Morning After Rain"], ["the-iron-borough", "The Iron Borough"], ["the-ground", "The Ground"],
    ["the-investigation", "The Investigation"], ["turquoise-mirage", "Turquoise Mirage"], ["a-dream-in-color", "A Dream in Color"],
    ["breakfast-on-schedule", "Breakfast on Schedule"], ["favela-gold", "Favela Gold"], ["a-hotel-for-one", "A Hotel for One"],
    ["after-dark", "After Dark"],
    /* The schema's own spelling of this palette's value is `crimson-vigi`; that is what is sent. */
    ["crimson-vigi", "Crimson Vigil"],
    ["the-neighbors-saw-everything", "The Neighbors Saw Everything"], ["the-grey-channel", "The Grey Channel"],
    ["mirage-at-noon", "Mirage at Noon"], ["bubblegum-boulevard", "Bubblegum Boulevard"], ["yellow-room", "Yellow Room"],
    ["the-earth-keeps-things-reluctantly", "The Earth Keeps Things Reluctantly"], ["tropic-fever-dream", "Tropic Fever Dream"],
    ["bioluminescent-night", "Bioluminescent Night"], ["dont-turn-it-off-im-watching", "Don’t Turn It Off, I’m Watching"],
    ["the-silk-curtain-falls", "The Silk Curtain Falls"], ["the-butterfly", "The Butterfly"], ["playtime", "Playtime"],
    ["wallpaper-romance", "Wallpaper Romance"], ["overtime", "Overtime"], ["the-way-home-is-longer", "The Way Home Is Longer"],
    ["everyone-speaks-in-whispers", "Everyone Speaks in Whispers"], ["runaway-summer", "Runaway Summer"],
    ["amber-wasteland", "Amber Wasteland"], ["the-circus", "The Circus"], ["gasoline-sunset", "Gasoline Sunset"],
  ]) },
];

export const cinemaControl = (key: string): CinemaControl | undefined => CINEMA_STUDIO_CONTROLS.find((c) => c.key === key);

/** A pick's name as a person reads it ("Dolly in"), or "" when the control is Auto or the value unknown. */
export function cinemaOptionLabel(key: string, value: string | undefined): string {
  if (!value) return "";
  return cinemaControl(key)?.options.find((o) => o.value === value)?.label ?? "";
}

export type CinemaControlsRead = { ok: true; controls: CinemaStudioControls } | { ok: false; error: string };

/**
 * The controls a request names, checked against the documented values: an
 * object whose keys are documented controls and whose values are one of that
 * control's documented strings, exactly. Absent (or null) is every control on
 * Auto. Anything else is refused whole, never trimmed or guessed at: an
 * unknown control, "auto", an empty or differently spelled value, another
 * control's value, or anything that is not a string.
 */
export function readCinemaControls(value: unknown): CinemaControlsRead {
  if (value == null) return { ok: true, controls: {} };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "Cinema Studio's controls are named settings, one value per control." };
  const controls: CinemaStudioControls = {};
  for (const [key, picked] of Object.entries(value as Record<string, unknown>)) {
    const control = cinemaControl(key);
    if (!control) return { ok: false, error: `Cinema Studio has no control called “${key.slice(0, 40)}”.` };
    if (typeof picked !== "string" || !control.options.some((o) => o.value === picked))
      return { ok: false, error: `That ${control.label.toLowerCase()} is not one of Cinema Studio’s. Choose one from the list, or leave it on Auto.` };
    controls[control.key] = picked;
  }
  return { ok: true, controls: orderedControls(controls) };
}

/** The picks in the documented order, so equal choices always read and fingerprint the same. */
function orderedControls(controls: CinemaStudioControls): CinemaStudioControls {
  const out: CinemaStudioControls = {};
  for (const key of CINEMA_CONTROL_KEYS) if (controls[key]) out[key] = controls[key];
  return out;
}

/** A stored or held set of picks, keeping only documented pairs (for restoring a composer, never for sending). */
export function cleanCinemaControls(value: unknown): CinemaStudioControls {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const kept: CinemaStudioControls = {};
  for (const [key, picked] of Object.entries(value as Record<string, unknown>)) {
    const control = cinemaControl(key);
    if (control && typeof picked === "string" && control.options.some((o) => o.value === picked)) kept[control.key] = picked;
  }
  return orderedControls(kept);
}
