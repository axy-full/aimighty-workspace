"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  listUploadEnvelopes,
  subscribeUploads,
  type UploadEnvelope,
} from "@/lib/uploadRecovery";
import { checkUpload, dismissUpload, followFinishing, resumeUpload } from "@/lib/uploadClient";
import { fileRecoveredUpload } from "@/lib/workspace/library";
import styles from "./upload-recovery.module.css";

const serverSnapshot = () => "{}";
const STILL_FINISHING = "Storage is still finishing. Check again shortly.";
const READY_TO_RESUME = "Ready to resume. Choose the original file if needed.";
export default function UploadRecovery({ scope }: { scope: string | null }) {
  const snapshot = useCallback(() => {
    if (!scope) return "{}";
    try {
      return JSON.stringify({ entries: listUploadEnvelopes(scope) });
    } catch (error) {
      return JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Upload recovery is unavailable.",
      });
    }
  }, [scope]);
  const state = JSON.parse(
    useSyncExternalStore(subscribeUploads, snapshot, serverSnapshot),
  ) as { entries?: UploadEnvelope[]; error?: string };
  const entries = state.entries ?? [];
  if (!scope || (!entries.length && !state.error)) return null;
  /* Finished receipts stay listed until dismissed; only an unfinished upload asks for its original file. */
  const resumable = entries.some(
    (entry) => entry.state !== "complete" && entry.state !== "blocked",
  );
  return (
    <details className={styles.panel}>
      <summary>
        Uploads <span>{entries.length || "!"}</span>
      </summary>
      <section aria-label="Upload recovery" className={styles.body}>
        {resumable && (
          <p>Choose the original file to resume an interrupted upload.</p>
        )}
        {state.error && <p role="alert">{state.error}</p>}
        {entries.map((entry) => (
          <UploadRow key={entry.session} entry={entry} />
        ))}
      </section>
    </details>
  );
}

function UploadRow({ entry }: { entry: UploadEnvelope }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const complete = entry.state === "complete";
  /* Shown already finishing (the page reloaded while the server assembled it):
     follow that finish to its end. Nothing is sent; an upload still running in
     this or another tab is waited for first. Resume and Cancel stay usable. */
  const finishingAtMount = useRef(entry.state === "finishing");
  useEffect(() => {
    if (!finishingAtMount.current) return;
    finishingAtMount.current = false;
    setMessage(STILL_FINISHING);
    followFinishing(entry)
      .then(async (result) => {
        setMessage((shown) => (shown === STILL_FINISHING ? (result === "resume" ? READY_TO_RESUME : "") : shown));
        if (result && result !== "resume") await fileRecoveredUpload(entry);
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : "Upload recovery failed. Try again."),
      );
    // Once per row, from the record it was first shown with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Upload recovery failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={styles.row} aria-label={entry.file.name}>
      <strong>{entry.file.name}</strong>
      <span>
        {complete
          ? "Upload ready"
          : entry.state === "blocked"
            ? "Upload unavailable"
            : `${Math.round((entry.storedChunks.length / entry.count) * 100)}% uploaded`}
      </span>
      {(message || entry.error) && (
        <p role="status">{message || entry.error}</p>
      )}
      <div className={styles.actions}>
        {!complete && entry.state !== "blocked" && (
          <>
            <button
              disabled={busy}
              onClick={() => void action(() => resumeUpload(entry).then(() => fileRecoveredUpload(entry)))}
            >
              Resume upload
            </button>
            <button disabled={busy} onClick={() => file.current?.click()}>
              Choose original file
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await checkUpload(entry);
                  /* Found stored after all: it goes where it was dropped, as a resume would have put it. */
                  if (result.state === "committed") await fileRecoveredUpload(entry);
                  else if (result.failure) setMessage("");
                  else
                    setMessage(
                      result.retryAfterMs > 0 ? STILL_FINISHING : READY_TO_RESUME,
                    );
                })
              }
            >
              Check status
            </button>
            <input
              ref={file}
              type="file"
              aria-label={`Resume ${entry.file.name}`}
              hidden
              onChange={(event) => {
                const selected = event.target.files?.[0];
                event.target.value = "";
                if (selected) void action(() => resumeUpload(entry, selected).then(() => fileRecoveredUpload(entry)));
              }}
            />
          </>
        )}
        {complete && entry.result && (
          <a href={entry.result.url} target="_blank" rel="noopener noreferrer">
            Open uploaded file
          </a>
        )}
        <button
          disabled={busy}
          onClick={() => void action(() => dismissUpload(entry))}
        >
          {complete || entry.state === "blocked" ? "Dismiss" : "Cancel upload"}
        </button>
        {busy && <span role="status">Working…</span>}
      </div>
    </article>
  );
}
