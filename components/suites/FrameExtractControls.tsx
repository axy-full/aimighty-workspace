"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { useUploadFile } from "@/lib/useUploadFile";
import {
  GEN_ASSETS_CHANGED,
  inputFromUpload,
  type GenInputAsset,
} from "@/lib/genAssetInput";
import { fileProjectUpload } from "@/lib/workbench/project-library-client";
import {
  captureVideoFrame,
  type VideoFrameSource,
  type VideoFrameEdge,
} from "@/lib/videoFrameCapture";

export type FrameExtractControlsProps = {
  source: VideoFrameSource | null;
  projectId: string;
  scope: string;
  disabled?: boolean;
  onCreated: (asset: GenInputAsset) => void;
  onBusyChange?: (busy: boolean) => void;
};

/** Changing the source, account or target project destroys the active receiver.
 * A completed upload stays in its captured workspace even if the UI has moved. */
export function FrameExtractControls(props: FrameExtractControlsProps) {
  return (
    <Controls
      key={`${props.scope}:${props.projectId}:${props.source?.origin}:${props.source?.id}`}
      {...props}
    />
  );
}
function Controls({
  source,
  projectId,
  scope,
  disabled,
  onCreated,
  onBusyChange,
}: FrameExtractControlsProps) {
  const session = useSession(),
    upload = useUploadFile();
  const [busy, setBusy] = useState<VideoFrameEdge | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const current = useRef(false),
    pending = useRef(false),
    controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  useEffect(() => {
    busyCallback.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
      controller.current?.abort();
      if (pending.current) {
        pending.current = false;
        busyCallback.current?.(false);
      }
    };
  }, []);
  const enabled =
    !!source &&
    !!projectId &&
    !!scope &&
    session.signedIn &&
    session.requestScope === scope &&
    !disabled &&
    !busy;
  async function extract(edge: VideoFrameEdge) {
    if (!enabled || !source || pending.current) return;
    pending.current = true;
    setBusy(edge);
    busyCallback.current?.(true);
    setError("");
    setNotice("");
    const active = new AbortController();
    controller.current = active;
    try {
      const frame = await captureVideoFrame(source, edge, scope, active.signal);
      if (!current.current || active.signal.aborted) return;
      const saved = await upload(
        new File([frame.blob], frame.filename, {
          type: "image/png",
          lastModified: 0,
        }),
        "reference",
      );
      if (!current.current || active.signal.aborted) return;
      await fileProjectUpload(projectId, saved.id, scope);
      if (!current.current || active.signal.aborted) return;
      const asset = inputFromUpload(saved);
      if (asset.kind !== "image")
        throw new Error(
          "The saved frame is not a valid image. Refresh Uploads before using it.",
        );
      window.dispatchEvent(
        new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope } }),
      );
      onCreated(asset);
      setNotice(
        `${edge === "start" ? "Start" : "End"} frame saved to this project · ${frame.width} × ${frame.height} PNG.`,
      );
    } catch (cause) {
      if (current.current && !active.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "The frame could not be saved.",
        );
    } finally {
      pending.current = false;
      if (current.current) {
        setBusy(null);
        busyCallback.current?.(false);
      }
    }
  }
  return (
    <div aria-label="Extract original video frames">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          className="suite-button"
          disabled={!enabled}
          onClick={() => void extract("start")}
        >
          {busy === "start" ? "Extracting start frame…" : "Extract start frame"}
        </button>
        <button
          type="button"
          className="suite-button"
          disabled={!enabled}
          onClick={() => void extract("end")}
        >
          {busy === "end" ? "Extracting end frame…" : "Extract end frame"}
        </button>
      </div>
      <p className="suite-helper">
        Save a full-resolution PNG to this project. Your source video stays
        unchanged.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
