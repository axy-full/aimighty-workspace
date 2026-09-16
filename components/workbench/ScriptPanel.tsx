"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FileText,
  Upload,
  GitBranch,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@/lib/workbench/studio";
import {
  MAX_SCRIPT_CHARS,
  parseScreenplay,
  type SceneReview,
  type ScreenplayImport,
  type ScriptScene,
} from "@/lib/workbench/screenplay";
import styles from "./script-panel.module.css";
import { ScreenplayOcrReview } from "./ScreenplayOcrReview";
import {
  ocrReviewComplete,
  remainingOcrPages,
  requestOcr,
} from "@/lib/workbench/screenplay-ocr-state";

export function ScriptPanel({
  project,
  onScript,
  onFormat,
  development,
  onImport,
  onReview,
  onBuild,
  onDevelop,
  onCrew,
}: {
  project: Project;
  onScript: (value: string) => void;
  onFormat: (value: "screenplay" | "adfilm") => void;
  development: ReactNode;
  onImport: (file: File, result: ScreenplayImport) => Promise<void>;
  onReview: (id: string, review: SceneReview) => void;
  onBuild: (scenes: ScriptScene[]) => void;
  onDevelop: (scene: ScriptScene) => void;
  onCrew: () => void;
}) {
  const adfilm = project.scriptFormat === "adfilm";
  const fileInput = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [pending, setPending] = useState<{
    file: File;
    result: ScreenplayImport;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false),
    [replace, setReplace] = useState(false);
  const [pageState, setPageState] = useState({ signature: "", value: 0 }),
    [selectionState, setSelectionState] = useState<{
      signature: string;
      ids: Set<string>;
    }>({ signature: "", ids: new Set() });
  const script = useDeferredValue(project.script || "");
  const pages = project.scriptSource?.edited
    ? undefined
    : project.scriptSource?.pages;
  const scenes = useMemo(() => parseScreenplay(script, pages), [script, pages]);
  const signature = scenes.map((s) => s.id + s.sourceKey).join(":");
  const selected =
    selectionState.signature === signature
      ? selectionState.ids
      : new Set<string>();
  const page =
    pageState.signature === signature
      ? Math.min(
          pageState.value,
          Math.max(0, Math.ceil(scenes.length / 12) - 1),
        )
      : 0;
  function setSelected(
    update: Set<string> | ((prior: Set<string>) => Set<string>),
  ) {
    setSelectionState((prior) => ({
      signature,
      ids:
        typeof update === "function"
          ? update(prior.signature === signature ? prior.ids : new Set())
          : update,
    }));
  }
  function setPage(update: (prior: number) => number) {
    setPageState({ signature, value: update(page) });
  }
  const room = Math.max(0, 250 - project.nodes.length);
  const visible = scenes.slice(page * 12, page * 12 + 12);
  const chosen = scenes.filter((s) => selected.has(s.id));
  useEffect(() => () => controller.current?.abort(), []);
  async function read(file: File) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(adfilm ? "Reading ad-film script…" : "Reading screenplay…");
    setError("");
    setPending(null);
    setAcknowledged(false);
    setReplace(false);
    try {
      let result: ScreenplayImport;
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        const { extractScreenplayPdf } =
          await import("@/lib/workbench/screenplay-pdf");
        result = await extractScreenplayPdf(file, abort.signal, (page, total) =>
          setBusy(`Reading page ${page} of ${total}…`),
        );
      } else {
        if (!/\.(txt|fountain)$/i.test(file.name))
          throw new Error("Choose PDF, TXT or Fountain.");
        if (file.size > MAX_SCRIPT_CHARS * 4)
          throw new Error("Use a script under one million characters.");
        const text = (await file.text()).replace(/\r\n?/g, "\n");
        if (text.length > MAX_SCRIPT_CHARS)
          throw new Error(
            "This script exceeds one million characters. Nothing was imported.",
          );
        const hash = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        result = {
          text,
          pages: [],
          emptyPages: [],
          sha256: Array.from(new Uint8Array(hash), (v) =>
            v.toString(16).padStart(2, "0"),
          ).join(""),
        };
      }
      if (abort.signal.aborted) return;
      setPending({ file, result });
    } catch (e) {
      if (!abort.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Could not read this script.",
        );
    } finally {
      if (controller.current === abort) setBusy("");
    }
  }
  async function runOcr(pages: number[]) {
    if (!pending || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    const current = {
      ...pending,
      result: pages.length ? requestOcr(pending.result, pages) : pending.result,
    };
    setPending(current);
    setAcknowledged(false);
    setBusy("Loading local English OCR…");
    setError("");
    try {
      const { recognizeScreenplayPdf } =
        await import("@/lib/workbench/screenplay-ocr");
      await recognizeScreenplayPdf(
        current.file,
        current.result,
        abort.signal,
        (result) => {
          if (!abort.signal.aborted) setPending({ file: current.file, result });
        },
        (message) => {
          if (!abort.signal.aborted) setBusy(message);
        },
      );
    } catch (error) {
      if (!abort.signal.aborted)
        setError(
          error instanceof Error ? error.message : "OCR could not finish.",
        );
    } finally {
      if (controller.current === abort) setBusy("");
    }
  }
  async function accept() {
    if (!pending || busy || !ocrReviewComplete(pending.result)) return;
    setBusy("Saving original source…");
    setError("");
    try {
      await onImport(pending.file, pending.result);
      setPending(null);
      toast.success(
        adfilm ? "Complete ad-film script imported. Review the source, then develop its breakdown." : "Complete screenplay imported. Review the scene boundaries.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save script.");
    } finally {
      setBusy("");
    }
  }
  const source = project.assets.find(
    (a) => a.id === project.scriptSource?.assetId,
  );
  return (
    <div className={"stage-scroll " + styles.panel}>
      <header className={styles.header}>
        <div>
          <span className="eyebrow">SCRIPT & BREAKDOWN</span>
          <h2>{adfilm ? "From ad-film script to a shoot." : "From screenplay to scenes."}</h2>
          <p>
            {adfilm ? "Import a commercial script or write audio and visual beats. Develop timing, product moments, coverage and a clear end frame." : "Import the full screenplay, review scene boundaries, then develop beats and coverage."}
          </p>
        </div>
        <button
          className="btn"
          onClick={() => fileInput.current?.click()}
          disabled={!!busy}
        >
          <Upload size={15} />
          {adfilm ? "Import ad-film script" : "Import screenplay"}
        </button>
        <input
          hidden
          ref={fileInput}
          aria-label={adfilm ? "Import ad-film script file" : "Import screenplay file"}
          type="file"
          accept=".pdf,.txt,.fountain,application/pdf,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void read(file);
          }}
        />
      </header>
      <div className={styles.formats} role="group" aria-label="Script format">
        <button type="button" aria-pressed={!adfilm} disabled={!!busy || !!pending} onClick={() => onFormat("screenplay")}>
          <strong>Screenplay</strong><span>Feature, short or episode · PDF, TXT, Fountain</span>
        </button>
        <button type="button" aria-pressed={adfilm} disabled={!!busy || !!pending} onClick={() => onFormat("adfilm")}>
          <strong>Ad-film script</strong><span>Commercial · audio, visuals, timing and end frame</span>
        </button>
      </div>
      {development}
      {busy && (
        <div className={styles.notice} role="status">
          {busy}
          {busy !== "Saving original source…" && (
            <button
              onClick={() => {
                controller.current?.abort();
                setBusy("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {pending && (
        <section
          className={styles.importReview}
          aria-label="Review screenplay import"
        >
          <h3>{pending.file.name}</h3>
          <p>
            {pending.result.pages.length
              ? `${pending.result.pages.length} PDF pages · `
              : ""}
            {pending.result.text.length.toLocaleString()} characters ·{" "}
            {parseScreenplay(pending.result.text, pending.result.pages).length}{" "}
            scenes found
          </p>
          <p>
            The original file will be saved in Assets. Page extraction is local
            to this browser.
          </p>
          {pending.result.emptyPages.length > 0 && (
            <div className={styles.error}>
              <p>
                Pages {pending.result.emptyPages.join(", ")} contain little or
                no extractable text. Recognize scanned pages below before
                breaking them down.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I checked the original: these pages are intentionally blank or
                contain no screenplay text.
              </label>
            </div>
          )}
          {!!pending.result.pages.length && (
            <>
              <div className={styles.actions}>
                {!!pending.result.emptyPages.filter(
                  (page) =>
                    !pending.result.ocr?.pages.some(
                      (record) => record.page === page,
                    ),
                ).length && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => void runOcr(pending.result.emptyPages)}
                  >
                    Recognize scanned pages (English)
                  </button>
                )}
                <button
                  className="btn"
                  disabled={
                    !!busy ||
                    pending.result.ocr?.pages.length ===
                      pending.result.pages.length
                  }
                  onClick={() =>
                    void runOcr(pending.result.pages.map((page) => page.page))
                  }
                >
                  Run OCR on all PDF pages
                </button>
                {!!remainingOcrPages(pending.result).length && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => void runOcr([])}
                  >
                    Resume OCR · {remainingOcrPages(pending.result).length}{" "}
                    pages
                  </button>
                )}
              </div>
              <p className={styles.hint}>
                OCR runs on this device in English, one page at a time. For
                scans with headers or a faulty text layer, use all pages. Keep
                this panel open; closing it discards the unimported review.
              </p>
            </>
          )}
          {pending.result.ocr && !busy && (
            <ScreenplayOcrReview
              file={pending.file}
              result={pending.result}
              busy={!!busy}
              onChange={(result) => {
                setPending({ ...pending, result });
                setAcknowledged(false);
              }}
              onError={setError}
            />
          )}
          {!!project.script?.trim() && (
            <label>
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              Replace the current script and its beat notes. Existing scene
              nodes and original source assets stay available.
            </label>
          )}
          <div className={styles.actions}>
            <button
              className="btn primary"
              disabled={
                !!busy ||
                (!!project.script?.trim() && !replace) ||
                (!!pending.result.emptyPages.length && !acknowledged) ||
                !ocrReviewComplete(pending.result)
              }
              onClick={() => void accept()}
            >
              {adfilm ? "Import complete ad-film script" : "Import complete screenplay"}
            </button>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => setPending(null)}
            >
              Cancel import
            </button>
          </div>
        </section>
      )}
      <div className={styles.grid}>
        <section className={styles.source}>
          <div className="section-heading">
            <span>
              <FileText size={15} />
              {adfilm ? "AD-FILM SCRIPT" : "SCREENPLAY"}
            </span>
            <span>
              {(project.script || "").length.toLocaleString()} characters
            </span>
          </div>
          {source && (
            <p className={styles.sourceLink}>
              <a href={source.url} target="_blank" rel="noreferrer">
                Original: {source.name}
              </a>{" "}
              · {project.scriptSource?.pages.length || "Text"}
              {project.scriptSource?.pages.length ? " pages" : ""}
              {project.scriptSource?.ocr
                ? ` · English OCR: ${project.scriptSource.ocr.pages.length} reviewed pages`
                : ""}
              {project.scriptSource?.edited
                ? " · edited text; original page mapping retired"
                : ""}
            </p>
          )}
          <textarea
            aria-label={adfilm ? "Project ad-film script" : "Project screenplay"}
            disabled={!!busy}
            value={project.script || ""}
            maxLength={MAX_SCRIPT_CHARS}
            spellCheck={false}
            onChange={(e) => onScript(e.target.value)}
            placeholder={
              adfilm ? "00–05s · OPEN\nVISUAL: A tactile product detail in morning light.\nAUDIO: A single breath.\n\n05–15s · REVEAL\nVISUAL: Show the product in use.\nVO: The promise, in one line.\n\n15–30s · RESOLVE\nVISUAL: Pack shot and end frame.\nAUDIO: Brand signature." : "INT. LOCATION - DAY\n\nStart with what we see.\n\nCHARACTER\nAnd what we hear."
            }
          />
          <p className={styles.hint}>
            PDF up to 20 MB / 400 pages. Text up to one million characters.
            Extraction preserves the full source; scene and cast cues need
            review.
          </p>
        </section>
        <section
          className={styles.breakdown}
          aria-label="Screenplay scene breakdown"
        >
          <div className="section-heading">
            <h3>Scene breakdown</h3>
            <span>{scenes.length} scenes</span>
          </div>
          <p className={styles.hint}>
            Select scenes for the canvas. {room} node spaces available. Beat
            notes are editorial decisions and stay with this script version.
          </p>
          <div className={styles.actions}>
            <button
              className="btn"
              disabled={!scenes.length || scenes.length > room}
              onClick={() => setSelected(new Set(scenes.map((s) => s.id)))}
            >
              Select all scenes
            </button>
            <button
              className="btn"
              disabled={!selected.size}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          </div>
          {scenes.length > room && (
            <p className={styles.notice}>
              This script has more scenes than the canvas has room for. Choose a
              batch below; every scene remains in the screenplay.
            </p>
          )}
          {!scenes.length && (
            <p className={styles.hint}>
              INT. / EXT. scene headings appear here after import.
            </p>
          )}
          {visible.map((scene) => {
            const saved = project.scriptReviews?.[scene.id];
            const review =
              saved?.sourceKey === scene.sourceKey
                ? saved
                : { sourceKey: scene.sourceKey, intent: "", beats: [] };
            const changeReview = (update: Partial<SceneReview>) =>
              onReview(scene.id, { ...review, ...update });
            return (
              <article
                key={scene.id + scene.sourceKey}
                className={styles.scene}
              >
                <label className={styles.sceneTitle}>
                  <input
                    type="checkbox"
                    aria-label={"Select scene " + (scene.number || scene.id)}
                    checked={selected.has(scene.id)}
                    onChange={(e) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(scene.id);
                        else next.delete(scene.id);
                        return next;
                      })
                    }
                  />
                  <strong>
                    {scene.number ? `${scene.number} · ` : ""}
                    {scene.slug}
                  </strong>
                </label>
                <small>
                  {scene.pageStart
                    ? `PDF p. ${scene.pageStart}${scene.pageEnd !== scene.pageStart ? "–" + scene.pageEnd : ""} · `
                    : ""}
                  {scene.characters.join(", ") || "No dialogue cues"}
                </small>
                <button className="btn" onClick={() => onDevelop(scene)}>
                  Plan shot coverage
                </button>
                <details>
                  <summary>
                    Read scene · {scene.body.length.toLocaleString()} characters
                  </summary>
                  <pre>{scene.body}</pre>
                </details>
                {saved && saved.sourceKey !== scene.sourceKey && (
                  <p className={styles.notice}>
                    The source changed. Earlier beat notes are retained in the
                    saved project until you replace them.
                  </p>
                )}
                <label>
                  Scene intent
                  <textarea
                    aria-label={"Scene intent " + scene.id}
                    maxLength={5000}
                    value={review.intent}
                    onChange={(e) => changeReview({ intent: e.target.value })}
                    placeholder="What changes emotionally or dramatically?"
                  />
                </label>
                <details>
                  <summary>Beats · {review.beats.length}</summary>
                  <p className={styles.hint}>
                    Add or edit the dramatic beats in order. Paragraphs are a
                    starting point, not an AI analysis.
                  </p>
                  {review.beats.map((beat, index) => (
                    <div key={index} className={styles.beat}>
                      <span>{index + 1}</span>
                      <textarea
                        aria-label={`Beat ${index + 1} ${scene.id}`}
                        value={beat}
                        maxLength={5000}
                        onChange={(e) =>
                          changeReview({
                            beats: review.beats.map((value, i) =>
                              i === index ? e.target.value : value,
                            ),
                          })
                        }
                      />
                      <button
                        aria-label={`Remove beat ${index + 1} ${scene.id}`}
                        onClick={() =>
                          changeReview({
                            beats: review.beats.filter((_, i) => i !== index),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div className={styles.actions}>
                    <button
                      className="btn"
                      disabled={review.beats.length >= 100}
                      onClick={() =>
                        changeReview({ beats: [...review.beats, ""] })
                      }
                    >
                      Add beat
                    </button>
                    <button
                      className="btn"
                      disabled={!!review.beats.length}
                      onClick={() => {
                        const beats = scene.body
                          .split(/\n\s*\n/)
                          .map((v) => v.trim())
                          .filter(Boolean);
                        if (
                          beats.length > 100 ||
                          beats.some((b) => b.length > 5000)
                        ) {
                          toast.error(
                            "This scene needs a manual beat split; no source text was shortened.",
                          );
                          return;
                        }
                        changeReview({ beats });
                      }}
                    >
                      Start from paragraphs
                    </button>
                  </div>
                </details>
              </article>
            );
          })}
          {scenes.length > 12 && (
            <div className={styles.pagination}>
              <button
                className="btn"
                aria-label="Previous scenes"
                disabled={page === 0}
                onClick={() => setPage((v) => v - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {page * 12 + 1}–{Math.min((page + 1) * 12, scenes.length)} of{" "}
                {scenes.length}
              </span>
              <button
                className="btn"
                aria-label="Next scenes"
                disabled={(page + 1) * 12 >= scenes.length}
                onClick={() => setPage((v) => v + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          <button
            className="btn primary full-width"
            disabled={
              !chosen.length ||
              chosen.length > room ||
              script !== project.script
            }
            onClick={() => onBuild(chosen)}
          >
            <GitBranch size={15} />
            Build {chosen.length || ""} scene nodes
          </button>
          <button className="btn full-width" onClick={onCrew}>
            Develop with production crew
          </button>
        </section>
      </div>
    </div>
  );
}
