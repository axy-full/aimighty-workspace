"use client";

import { useTheme, setTheme, type ThemePref } from "@/lib/theme";

const OPTIONS: { id: ThemePref; label: string }[] = [
  { id: "auto",  label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark",  label: "Dark" },
];

/** Appearance, as a segmented control in a settings row. */
export default function ThemeRow() {
  const pref = useTheme();
  return (
    <div className="row">
      <span className="min-w-0 flex-1">
        Appearance
        <span className="mt-0.5 block text-[12px] leading-snug text-mute">
          Auto follows the system.
        </span>
      </span>
      <span className="row-value">
        <span className="inline-flex rounded-[10px] bg-chip p-[3px]" role="radiogroup" aria-label="Appearance">
          {OPTIONS.map((o) => {
            const on = pref === o.id;
            return (
              <button key={o.id} role="radio" aria-checked={on}
                onClick={() => setTheme(o.id)}
                className={`rounded-[8px] px-3 py-1 text-[13px] font-medium transition-colors ${
                  on ? "bg-panel text-ink shadow-[var(--shadow-card)]" : "text-dim"
                }`}>
                {o.label}
              </button>
            );
          })}
        </span>
      </span>
    </div>
  );
}
