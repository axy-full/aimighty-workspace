"use client";
import { useEffect, useRef } from "react";
import type { Asset } from "@/lib/workbench/studio";
import { AssetPreview } from "./AssetPreview";
import { ColorPreview } from "./ColorPreview";
import { colorActive, type ColorGrade } from "@/lib/workbench/color";
/** The edit owns transport; embedded source players never run independently. */
export function TimelinePreview({
  asset,
  seconds,
  playing,
  grade,
  lut,
}: {
  asset?: Asset;
  seconds: number;
  playing: boolean;
  grade?: ColorGrade;
  lut?: Asset;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
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
  const graded = colorActive(grade);
  if (asset.kind !== "video")
    return graded && asset.kind === "image" ? (
      <>
        {/* The image element is also the decoded input for the shared GPU processor. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={image} src={asset.url} alt={asset.name} />
        <ColorPreview
          key={asset.url + lut?.id}
          media={image}
          sourceUrl={asset.url}
          grade={grade}
          lut={lut}
        />
      </>
    ) : (
      <AssetPreview asset={asset} />
    );
  return (
    <>
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
      {graded && (
        <ColorPreview
          key={asset.url + lut?.id}
          media={video}
          sourceUrl={asset.url}
          grade={grade}
          lut={lut}
        />
      )}
    </>
  );
}
