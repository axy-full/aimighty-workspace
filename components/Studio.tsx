"use client";

/**
 * The Studio panel — the Artlist-style half of the composer.
 *
 * Cast (characters, locations, looks) already handles consistency across
 * shots. This is the other half: the shot itself. Framing, angle, move, lens,
 * light, time, look, mood, motion — picked as chips rather than remembered as
 * prose, and shown back as the sentence they'll become so nobody has to guess
 * what the chips did to their prompt.
 */
import { useState } from "react";
import { CATEGORIES, specToPhrase, specCount, type ShotSpec } from "@/lib/studio";

export default function Studio({ spec, setSpec }: {
  spec: ShotSpec;
  setSpec: (next: ShotSpec) => void;
}) {
  const [open, setOpen] = useState(false);
  const n = specCount(spec);
  const phrase = specToPhrase(spec);

  const toggle = (cat: string, value: string) =>
    setSpec({ ...spec, [cat]: spec[cat] === value ? "" : value });

  return (
    <section className="card overflow-hidden">
      <button onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <span className="grouplabel">Shot control</span>
        {n > 0 && <span className="chip bg-blue text-on-ink">{n}</span>}
        <span className="ml-auto text-[13px] text-mute">{open ? "Hide" : "Show"}</span>
      </button>

      {n > 0 && (
        <div className="border-t border-hair px-4 py-3">
          <p className="text-[13px] leading-snug text-dim">
            <span className="text-mute">Appended: </span>{phrase}.
          </p>
          <button onClick={() => setSpec({})}
            className="mt-2 text-[12px] text-lift">Clear all</button>
        </div>
      )}

      {open && (
        <div className="max-h-[42vh] overflow-y-auto border-t border-hair px-4 py-3">
          {CATEGORIES.map((c) => (
            <div key={c.key} className="mb-4 last:mb-1">
              <p className="text-[12px] font-medium uppercase tracking-wide text-mute">
                {c.label}
              </p>
              {c.hint && <p className="mt-0.5 text-[12px] text-mute">{c.hint}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.options.map((o) => {
                  const on = spec[c.key] === o.value;
                  return (
                    <button key={o.value} onClick={() => toggle(c.key, o.value)}
                      title={o.phrase}
                      className={`chip ${on ? "bg-blue text-on-ink" : ""}`}>
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="pb-1 text-[12px] text-mute">
            One choice per row. Everything you leave alone stays out of the
            prompt — padding a prompt with adjectives is what makes engines
            drift, not what makes them sharp.
          </p>
        </div>
      )}
    </section>
  );
}
