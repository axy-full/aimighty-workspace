"use client";
import { useEffect, useRef } from "react";
import type { Asset } from "@/lib/workbench/studio";
import { AssetPreview } from "./AssetPreview";
/** The edit owns transport; embedded source players never run independently. */
export function TimelinePreview({
  asset,
  seconds,
  playing,
}: {
  asset?: Asset;
  seconds: number;
  playing: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (
      Number.isFinite(el.duration) &&
      (!playing || Math.abs(el.currentTime - seconds) > 0.12)
    )
      el.currentTime = Math.min(seconds, Math.max(0, el.duration - 0.001));
    if (playing) void el.play().catch(() => {});
    else el.pause();
  }, [asset?.url, seconds, playing]);
  useEffect(() => {
    const element = video.current;
    return () => element?.pause();
  }, []);
  if (!asset) return null;
  if (asset.kind !== "video") return <AssetPreview asset={asset} />;
  return (
    <video
      ref={video}
      aria-label="Timeline video preview"
      data-timeline-seconds={seconds}
      src={asset.url}
      muted
      playsInline
      preload="metadata"
      onLoadedData={(e) => {
        if (Math.abs(e.currentTarget.currentTime - seconds) > 0.001)
          e.currentTarget.currentTime = Math.min(
            seconds,
            Math.max(0, e.currentTarget.duration - 0.001),
          );
      }}
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = Math.min(
          seconds,
          Math.max(0, e.currentTarget.duration - 0.001),
        );
        if (playing) void e.currentTarget.play().catch(() => {});
      }}
    />
  );
}
