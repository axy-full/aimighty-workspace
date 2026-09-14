"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createColorRenderer, loadCube } from "@/lib/workbench/color-render";
import type { ColorGrade } from "@/lib/workbench/color";
import type { Asset } from "@/lib/workbench/studio";

export function ColorPreview({
  media,
  sourceUrl,
  grade,
  lut,
}: {
  media: RefObject<HTMLVideoElement | HTMLImageElement | null>;
  sourceUrl: string;
  grade: ColorGrade;
  lut?: Asset;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const currentGrade = useRef(grade);
  const [state, setState] = useState("Loading sequence look…");
  useEffect(() => {
    currentGrade.current = grade;
  }, [grade]);
  useEffect(() => {
    const abort = new AbortController();
    let raf = 0,
      processor: ReturnType<typeof createColorRenderer> | undefined;
    const frame = document.createElement("canvas"),
      context = frame.getContext("2d", { alpha: false, colorSpace: "srgb" });
    const output = canvas.current,
      target = output?.getContext("2d", { colorSpace: "srgb" });
    let shown = false;
    const element = media.current;
    let sourceFailed = false;
    const sourceError = () => {
      sourceFailed = true;
      setState(
        "This source could not be decoded. Open or replace it before grading.",
      );
    };
    element?.addEventListener("error", sourceError);
    async function start() {
      try {
        if (!context || !target || !output)
          throw new Error("Color preview is unavailable on this device.");
        if (new URL(sourceUrl, location.href).origin !== location.origin)
          throw new Error(
            "Import this media into the workspace to preview its sequence look.",
          );
        const cube = lut ? await loadCube(lut, abort.signal) : undefined;
        abort.signal.throwIfAborted();
        processor = createColorRenderer(cube);
        let lastFrame = "";
        const draw = () => {
          if (abort.signal.aborted || sourceFailed) return;
          try {
            const source = media.current;
            const width =
              source instanceof HTMLVideoElement
                ? source.videoWidth
                : source?.naturalWidth;
            const height =
              source instanceof HTMLVideoElement
                ? source.videoHeight
                : source?.naturalHeight;
            const signature = `${width}:${height}:${source instanceof HTMLVideoElement ? source.currentTime : 0}:${JSON.stringify(currentGrade.current)}`;
            if (
              !document.hidden &&
              signature !== lastFrame &&
              source &&
              width &&
              height &&
              (!(source instanceof HTMLVideoElement) || source.readyState >= 2)
            ) {
              const scale = Math.min(1, 1280 / Math.max(width, height));
              if (
                frame.width !== Math.round(width * scale) ||
                frame.height !== Math.round(height * scale)
              ) {
                frame.width = Math.round(width * scale);
                frame.height = Math.round(height * scale);
                output!.width = frame.width;
                output!.height = frame.height;
              }
              context!.drawImage(source, 0, 0, frame.width, frame.height);
              target!.drawImage(
                processor!.render(frame, currentGrade.current),
                0,
                0,
              );
              lastFrame = signature;
              if (!shown) {
                shown = true;
                setState("");
                output!.dataset.colorReady = "true";
              }
            }
            raf = requestAnimationFrame(draw);
          } catch (error) {
            setState(
              error instanceof Error ? error.message : "Color preview failed.",
            );
          }
        };
        draw();
      } catch (error) {
        if (!abort.signal.aborted)
          setState(
            error instanceof Error ? error.message : "Color preview failed.",
          );
      }
    }
    void start();
    return () => {
      abort.abort();
      element?.removeEventListener("error", sourceError);
      cancelAnimationFrame(raf);
      processor?.dispose();
    };
  }, [lut, sourceUrl, media]);
  return (
    <>
      <canvas
        ref={canvas}
        aria-label="Graded timeline preview"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          visibility: state ? "hidden" : "visible",
          pointerEvents: "none",
        }}
      />
      {state && (
        <span
          role="status"
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            top: 12,
            padding: 8,
            background: "#191c18",
            fontSize: 12,
            zIndex: 2,
          }}
        >
          {state}
        </span>
      )}
    </>
  );
}
