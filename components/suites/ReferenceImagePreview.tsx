"use client";
/* eslint-disable @next/next/no-img-element -- Private images use authenticated same-origin requests. */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { GenInputAsset } from "@/lib/genAssetInput";
import styles from "./subatomik.module.css";

export function ReferenceImagePreview({
  asset,
  onClose,
}: {
  asset: GenInputAsset;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.imageDialog}
      aria-label="Reference image preview"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <header>
        <h2>{asset.name}</h2>
        <button
          type="button"
          aria-label="Close reference preview"
          onClick={() => dialog.current?.close()}
        >
          <X size={20} />
        </button>
      </header>
      <img src={asset.url} alt={asset.name} />
      <a className="suite-button" href={`${asset.url}?download=1`} download>
        Download reference original
      </a>
    </dialog>
  );
}
