"use client";
import { useRef, useState } from "react";
import { BOARD_TEMPLATES } from "@/lib/board/kind";
import { uploadFilesToProject } from "@/lib/workspace/library";
import type { UploadedFile } from "@/lib/uploadClient";
import { AttachThumbs } from "../AttachThumbs";
import { TileMedia, uploadTile } from "../LibraryTile";
import { useBoardAgent } from "./agent";
import type { BoardCtx } from "./cards/types";
import { Glyph } from "./Rail";

/*
 * The empty board (README § 3.1 frame a): "What are we making?", the words,
 * Attach, aspect and length, Start, and the templates as a quiet row.
 *
 * Start is Atomik's (stream 7's seam, useBoardAgent): its price is the
 * server's estimate of Atomik's thinking and the press is a person's; until
 * that seam is on the board, Start says why it waits. Aspect is the
 * project's, carried everywhere (ease rule 3); length goes into the words.
 * Attach keeps the files in the project's Library and hands them to Atomik;
 * each shows under the box as its Library tile, and pressing one takes it out
 * of what Start sends (it stays in the Library).
 */
const ASPECTS = ["16:9", "9:16", "1:1"] as const;
const LENGTHS = [6, 15, 30] as const;
const ATTACH = "application/pdf,text/plain,image/*,video/*";
const SCRIPT = "application/pdf,text/plain";
/** The design's example (it names nobody): the box teaches by example (ease rule 10). */
const EXAMPLE = "A 15-second fashion film about quiet confidence. A woman in ivory crosses a sculptural desert; a mirror sphere reflects the world around her.";

export function EmptyBoard({ ctx }: { ctx: BoardCtx }) {
  const agent = useBoardAgent();
  const [words, setWords] = useState("");
  const [seconds, setSeconds] = useState<number | null>(15);
  const [attached, setAttached] = useState<{ id: string; upload: UploadedFile }[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const aspect = ctx.project.aspect || "16:9";
  const price = agent.startPrice;
  const why = !agent.start ? "Atomik is not on this board yet."
    : ctx.offline ? "Needs a connection"
    : !words.trim() ? "Say what we are making, or pick a template."
    : !price || price.state === "loading" ? "Getting the price…"
    : price.state === "unavailable" ? "Atomik's thinking cannot be priced right now."
    : null;

  const attach = (accept: string) => {
    const input = files.current;
    if (!input) return;
    input.accept = accept;
    input.click();
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const { uploads, notes } = await uploadFilesToProject(ctx.scope, ctx.project.id, [...list]);
      setAttached((was) => [...was, ...uploads.map((upload) => ({ id: `upload:${upload.id}`, upload }))]);
      setSaid(notes.length ? notes.join(" ") : null);
    } catch (error) {
      setSaid(error instanceof Error ? error.message : "The files could not be uploaded.");
    } finally {
      setBusy(false);
      if (files.current) files.current.value = "";
    }
  };
  const start = async () => {
    if (why || !agent.start) return;
    setBusy(true);
    const refusal = await agent.start({ words: words.trim(), aspect, seconds, attachments: attached.map((a) => a.id) });
    setBusy(false);
    setSaid(refusal);
  };
  const template = (id: (typeof BOARD_TEMPLATES)[number]["id"], kind: (typeof BOARD_TEMPLATES)[number]["kind"]) => {
    if (id === "script") { attach(SCRIPT); return; }
    if (kind === ctx.kind) { box.current?.focus(); return; }
    /* Ads and Social: this project's board becomes that template's, for everyone (a draft edit, free). */
    const refusal = ctx.rig.apply((p) => ({ ...p, boardKind: kind }));
    if (refusal) setSaid(refusal);
  };

  return (
    <div className="bd-empty" data-testid="board-empty">
      <div className="bd-empty-inner">
        <h1 className="bd-empty-title">What are we making?</h1>
        <div className="bd-empty-box">
          <textarea ref={box} className="bd-empty-words" aria-label="What are we making?" placeholder={EXAMPLE} value={words} onChange={(e) => setWords(e.target.value)} maxLength={4000} />
          <div className="bd-empty-row">
            <button type="button" className="gx-hbtn bd-attach" onClick={() => attach(ATTACH)} disabled={busy || ctx.offline}>
              <Glyph d="M4 2h6l3 3v9H4zM10 2v3h3" /><span>Attach</span>
            </button>
            <span className="bd-empty-rule" aria-hidden="true" />
            <div className="bd-chips" role="group" aria-label="Aspect">
              {ASPECTS.map((a) => (
                <button key={a} type="button" className="bd-chip" aria-pressed={aspect === a} onClick={() => { if (a !== aspect) ctx.rig.apply((p) => ({ ...p, aspect: a })); }}>{a}</button>
              ))}
            </div>
            <span className="bd-empty-rule" aria-hidden="true" />
            <div className="bd-chips" role="group" aria-label="Length">
              {LENGTHS.map((s) => (
                <button key={s} type="button" className="bd-chip" aria-pressed={seconds === s} onClick={() => setSeconds(seconds === s ? null : s)}>{s} s</button>
              ))}
            </div>
            <span className="bd-empty-grow" />
            <button type="button" className="gx-btn gx-btn--primary bd-start" aria-disabled={why ? true : undefined} title={why ?? undefined} onClick={() => void start()} data-testid="board-start">Start</button>
          </div>
        </div>
        <AttachThumbs testId="board-attached" disabled={busy}
          items={attached.map(({ id, upload }) => { const tile = uploadTile(upload); return { key: id, name: upload.filename, picture: <TileMedia url={tile.url} media={tile.media} /> }; })}
          onRemove={(id) => setAttached((was) => was.filter((a) => a.id !== id))} />
        {said ? <p className="bd-empty-line" role="status">{said}</p> : null}
        <div className="bd-templates" role="group" aria-label="Templates">
          {BOARD_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="gx-hbtn bd-template" onClick={() => template(t.id, t.kind)}><Glyph d={t.icon} /><span>{t.name}</span></button>
          ))}
        </div>
      </div>
      <input ref={files} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
    </div>
  );
}
