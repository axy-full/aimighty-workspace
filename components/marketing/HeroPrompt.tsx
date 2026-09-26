"use client";

import { useState } from "react";
import type { GenPreset } from "@/lib/shell/assets";
import { stashGenPreset } from "@/lib/shell/gen-preset";
import { APP_HREF, SIGN_IN_HREF } from "@/lib/marketing/links";
import { cr } from "@/lib/marketing/format";

const SAMPLE = "A woman in an ivory suit crosses a dune at golden hour; a chrome sphere reflects the sky. Slow dolly in, 35mm.";
const GEN_HREF = `${APP_HREF}?view=gen`;

/**
 * The hero's prompt bar. Nothing renders here and nothing is charged: the
 * prompt goes to Gen through the shell's own preset letterbox
 * (lib/shell/gen-preset, stashed for the page load) with the engine and settings this
 * bar quoted, and Gen shows the live quote before anything runs. Only a
 * visitor sees this bar (a member at / gets the app), so the prompt is kept
 * in this tab and opens in Gen after sign-in.
 */
export default function HeroPrompt({ model, label, short, credits }: {
  model: string; label: string; short: string; credits: number | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [saved, setSaved] = useState(false);

  function send() {
    const text = prompt.trim() || SAMPLE;
    const preset: GenPreset = {
      prompt: text, type: "video", model,
      picks: { ratio: "16:9", resolution: "1080p", duration: 5 },
      note: `From the site · ${label} · 16:9 · 5 s · 1080p`,
    };
    stashGenPreset(preset);
    if (!prompt.trim()) setPrompt(text);
    setSaved(true);
  }

  return (
    <div className="mk-hero-actions">
      <form className="mk-prompt" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="mk-sr" htmlFor="mk-hero-prompt">Describe the shot</label>
        <textarea id="mk-hero-prompt" rows={2} value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setSaved(false); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder="Describe the shot. Cite references as @Image1; start with raw: to skip the enhancer." />
        <div className="mk-prompt-bar">
          <span className="mk-model-chip"><span className="mk-model-tag">{short}</span>{label}</span>
          <span className="mk-set">16:9</span>
          <span className="mk-set">5 s</span>
          <span className="mk-set">1080p</span>
          <span className="mk-set mk-set--on">Audio on</span>
          <span style={{ flex: 1 }} />
          <span className="mk-prompt-meta mk-hide-phone">Opens in Gen · quoted before it runs</span>
          <button type="submit" className="mk-btn gx-primary mk-go">
            Generate · {cr(credits)}
          </button>
        </div>
      </form>
      <div className="mk-hero-status" aria-live="polite">
        {saved && (
          <div className="mk-take">
            <div className="mk-take-copy">
              <span className="mk-tag">Prompt kept · {label} · 16:9 · 5 s · 1080p</span>
              <span className="mk-take-prompt mk-wrap-text">{prompt.trim() || SAMPLE}</span>
              <span className="mk-take-meta">Sign in and it opens in Gen, quoted at {cr(credits)}. Nothing is charged until you press Generate there.</span>
            </div>
            <div className="mk-take-actions">
              <a className="mk-btn mk-btn--sm gx-primary" href={`${SIGN_IN_HREF}?next=${encodeURIComponent(GEN_HREF)}`}>Sign in</a>
              <a className="mk-btn mk-btn--sm mk-btn--secondary" href="#access">Request access</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
