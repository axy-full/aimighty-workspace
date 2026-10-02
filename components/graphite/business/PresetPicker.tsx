"use client";
import { useState } from "react";
import { presetShelves, type ImageAdPreset } from "@/lib/shell/image-ads";
import { useMarketingPresets } from "@/lib/shell/use-marketing-presets";

/**
 * Marketing Studio Image's presets for Image ads (the API's own catalogue:
 * product shots, graphic ads, marketplace design and the rest), on shelves by
 * the group the provider files each under, with its cover and the aspect it
 * was made for. Search narrows the catalogue at the provider; More presets
 * pages further. Reading it is free; a preset only changes what the next
 * estimate prices.
 */
export function PresetPicker({ scope, value, onPick }: { scope: string; value: ImageAdPreset | null; onPick: (preset: ImageAdPreset | null) => void }) {
  const [open, setOpen] = useState(false);
  const presets = useMarketingPresets(scope, open);
  const { status, items, cursor, more, error } = presets.state;
  const shelves = presetShelves(items);
  const searching = presets.search.trim().length > 0;
  return (
    <div className="gx-gen-row" data-testid="image-ad-preset">
      <span className="gx-eyebrow" data-functional-label="">Preset<span className="bz-note"> · optional · the ad is built around the product</span></span>
      <div className="bz-preset-bar">
        {value ? (
          <span className="gx-ref bz-preset-picked" data-testid="image-ad-preset-picked">
            <span className="gx-ref-name">{value.name}</span>
            <button type="button" className="gx-ref-x" aria-label={`Clear the preset ${value.name}`} onClick={() => onPick(null)}>×</button>
          </span>
        ) : <span className="cw-dim">None · your prompt as written</span>}
        <button type="button" className="gx-hbtn" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="image-ad-preset-browse">{open ? "Close presets" : value ? "Change preset" : "Browse presets"}</button>
      </div>
      {open ? (
        <div className="bz-presets" data-testid="image-ad-presets">
          <input className="gx-field" type="search" aria-label="Search presets" placeholder="Search presets" maxLength={100} value={presets.search}
            onChange={(e) => presets.setSearch(e.target.value)} data-testid="image-ad-preset-search" />
          {status === "error" ? (
            <div className="gx-retry" role="alert" data-testid="image-ad-presets-error">
              <span className="gx-gen-error">{error ?? "The presets could not be read."}</span>
              <button type="button" className="gx-hbtn" onClick={presets.retry}>Try again</button>
            </div>
          ) : status === "loading" && !items.length ? (
            <div className="bz-preset-grid" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="bz-preset bz-skel-tile" aria-hidden="true" />)}</div>
          ) : status === "ready" && !items.length ? (
            <p className="cw-dim" data-testid="image-ad-presets-empty">{searching ? "No presets match that search." : "No presets are available right now."}</p>
          ) : shelves.map((shelf) => (
            <div className="bz-shelf" key={shelf.group} data-testid="image-ad-shelf">
              <span className="gx-eyebrow" data-functional-label="">{shelf.group}</span>
              <div className="bz-preset-grid" role="group" aria-label={shelf.group}>
                {shelf.items.map((preset) => (
                  <button key={preset.id} type="button" className="bz-preset" aria-pressed={value?.id === preset.id} title={preset.name}
                    onClick={() => { onPick({ id: preset.id, name: preset.name }); setOpen(false); }} data-testid="image-ad-preset-option">
                    <span className="bz-preset-cover">
                      {/* eslint-disable-next-line @next/next/no-img-element -- The catalogue's own cover picture, as the template cards show theirs. */}
                      {preset.cover ? <img src={preset.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.hidden = true; }} /> : null}
                    </span>
                    <span className="bz-preset-name">{preset.name}</span>
                    {preset.aspectRatio ? <span className="bz-note">{preset.aspectRatio}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {cursor && status === "ready" ? (
            <div className="bz-more">
              <button type="button" className="gx-hbtn" disabled={more === "loading"} onClick={() => void presets.more()} data-testid="image-ad-presets-more">{more === "loading" ? "Loading…" : "More presets"}</button>
              {more === "error" ? <span className="gx-gen-error" role="alert">More presets could not be read. Try again.</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
