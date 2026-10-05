/*
 * LOCAL STUB of stream 9's lib/shell/settings.ts (decision 7). Never committed
 * by stream 8; replaced by stream 9's file when it lands.
 */
export const SETTINGS_SECTIONS = ["team", "credits", "rules", "connections", "advanced"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
