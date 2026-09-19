/**
 * What the Dub segment offers, shared by the panel and the admission. No
 * price lives here: the button carries the server's quote in credits.
 */
export type DubbingModeOption = { id: "v1" | "v1-watermark"; label: string; note: string };
export const DUBBING_MODE_OPTIONS: DubbingModeOption[] = [
  { id: "v1", label: "Standard", note: "No watermark. The default." },
  { id: "v1-watermark", label: "Watermarked", note: "A spoken watermark, at the lower rate." },
];
export const DEFAULT_DUBBING_MODE: DubbingModeOption["id"] = "v1";

/** ISO 639-1 codes the dubbing endpoint takes; "auto" detects the source language. */
export const DUBBING_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" }, { code: "es", label: "Spanish" }, { code: "fr", label: "French" }, { code: "de", label: "German" },
  { code: "it", label: "Italian" }, { code: "pt", label: "Portuguese" }, { code: "pl", label: "Polish" }, { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" }, { code: "da", label: "Danish" }, { code: "fi", label: "Finnish" }, { code: "no", label: "Norwegian" },
  { code: "cs", label: "Czech" }, { code: "sk", label: "Slovak" }, { code: "hu", label: "Hungarian" }, { code: "ro", label: "Romanian" },
  { code: "bg", label: "Bulgarian" }, { code: "hr", label: "Croatian" }, { code: "el", label: "Greek" }, { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" }, { code: "ru", label: "Russian" }, { code: "ar", label: "Arabic" }, { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" }, { code: "id", label: "Indonesian" }, { code: "ms", label: "Malay" }, { code: "fil", label: "Filipino" },
  { code: "vi", label: "Vietnamese" }, { code: "th", label: "Thai" }, { code: "ja", label: "Japanese" }, { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];
export const DUBBING_SOURCE_AUTO = "auto";
export const isDubbingLanguage = (code: string) => DUBBING_LANGUAGES.some((l) => l.code === code);
export const dubbingLanguageLabel = (code: string) => DUBBING_LANGUAGES.find((l) => l.code === code)?.label ?? code;
