"use client";
import { useEffect, useState } from "react";
import type { ScreenplayImport } from "@/lib/workbench/screenplay";
import {
  editOcrPage,
  reviewOcrPage,
  screenplayPage,
} from "@/lib/workbench/screenplay-ocr-state";
import styles from "./script-panel.module.css";

export function ScreenplayOcrReview({
  file,
  result,
  busy,
  onChange,
  onError,
}: {
  file: File;
  result: ScreenplayImport;
  busy: boolean;
  onChange: (result: ScreenplayImport) => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState(0);
  const number = result.ocr?.requestedPages.includes(selected)
    ? selected
    : result.ocr?.requestedPages[0] || 1;
  const [preview, setPreview] = useState<{
    file: File;
    number: number;
    url?: string;
    error?: string;
  }>();
  const currentPreview =
    preview?.file === file && preview.number === number ? preview : undefined;
  const recognition = result.ocr?.pages.find((page) => page.page === number);
  useEffect(() => {
    if (busy) return;
    const abort = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const { screenplayPagePreview } =
          await import("@/lib/workbench/screenplay-pdf");
        const blob = await screenplayPagePreview(file, number, abort.signal);
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setPreview({ file, number, url });
      } catch (error) {
        if (!abort.signal.aborted)
          setPreview({
            file,
            number,
            error:
              error instanceof Error
                ? error.message
                : "Could not preview this page.",
          });
      }
    })();
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, number, busy]);
  const reviewed =
    result.ocr?.pages.filter((page) => page.reviewed).length || 0;
  return (
    <section className={styles.ocrReview} aria-label="Review recognized pages">
      <h4>
        Review recognized pages · {reviewed}/{result.ocr?.requestedPages.length}
      </h4>
      <p>
        Check headings, scene numbers, names and dialogue against the original.
        English OCR can misread text; its confidence score is not an accuracy
        guarantee.
      </p>
      <div className={styles.actions}>
        <label>
          PDF page
          <select
            aria-label="OCR page"
            value={number}
            onChange={(event) => setSelected(Number(event.target.value))}
            disabled={busy}
          >
            {result.ocr?.requestedPages.map((page) => {
              const record = result.ocr?.pages.find(
                (item) => item.page === page,
              );
              return (
                <option key={page} value={page}>
                  {page} ·{" "}
                  {record?.reviewed
                    ? "Reviewed"
                    : record
                      ? "Needs review"
                      : "Waiting for OCR"}
                </option>
              );
            })}
          </select>
        </label>
        <button
          className="btn"
          type="button"
          disabled={
            busy ||
            !result.ocr?.pages.some(
              (page) => !page.reviewed && page.page !== number,
            )
          }
          onClick={() => {
            const unreviewed =
              result.ocr?.pages.filter(
                (page) => !page.reviewed && page.page !== number,
              ) || [];
            setSelected(
              (unreviewed.find((page) => page.page > number) || unreviewed[0])
                ?.page || number,
            );
          }}
        >
          Next unreviewed page
        </button>
      </div>
      {recognition && (
        <p className={recognition.confidence < 80 ? styles.error : styles.hint}>
          Engine confidence: {Math.round(recognition.confidence)}%
          {recognition.confidence < 80
            ? " · Low confidence. Check every line carefully."
            : ""}
          {recognition.corrected ? " · Manually corrected" : ""}
        </p>
      )}
      {!busy && (
        <div className={styles.ocrColumns}>
          <div className={styles.ocrOriginal}>
            {currentPreview?.url ? (
              // A local blob preview, never an external image or optimizer request.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentPreview.url}
                alt={`Original screenplay page ${number}`}
              />
            ) : (
              <p role="status">
                {currentPreview?.error || "Rendering original page…"}
              </p>
            )}
          </div>
          <textarea
            aria-label={`Recognized text page ${number}`}
            value={screenplayPage(result, number)}
            disabled={!recognition}
            spellCheck={false}
            onChange={(event) => {
              try {
                onChange(editOcrPage(result, number, event.target.value));
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          />
        </div>
      )}
      {recognition && (
        <label>
          <input
            type="checkbox"
            checked={recognition.reviewed}
            disabled={busy || !currentPreview?.url}
            onChange={(event) =>
              onChange(reviewOcrPage(result, number, event.target.checked))
            }
          />
          I reviewed page {number} against the original and corrected its text.
        </label>
      )}
      {!recognition && (
        <p className={styles.hint}>
          Resume OCR to recognize this page. Completed pages stay in this import
          while this panel is open.
        </p>
      )}
    </section>
  );
}
