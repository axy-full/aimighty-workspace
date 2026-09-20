"use client";

import { useImperativeHandle, useRef, type Ref } from "react";
import { DRAFT_UPLOAD_ACCEPT, uploadDraftFiles } from "@/lib/workbench/draft-upload";
import type { Asset } from "@/lib/workbench/studio";

/**
 * The categorised upload picker, as one component any host can mount.
 *
 * It is the hidden file input Studio has always used, with Studio's own upload
 * loop behind it (lib/workbench/draft-upload.ts). A host calls `pick(category)`
 * on the handle and receives the stored draft assets; nothing about the draft
 * is written here, so the host stays the only writer.
 */

export type DraftUploadHandle = { pick: (category?: string) => void };

export function DraftUploadInput({
  handle,
  scope,
  disabled = false,
  onAssets,
  onError,
  onBusy,
}: {
  handle: Ref<DraftUploadHandle>;
  scope: string;
  disabled?: boolean;
  /** The stored assets, in the order chosen. Empty when every file failed. */
  onAssets: (assets: Asset[], category: string) => void;
  onError: (message: string) => void;
  /** True while files are being stored, so the host can block a switch. */
  onBusy?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const category = useRef("Reference");
  useImperativeHandle(handle, () => ({
    pick: (next = "Reference") => {
      category.current = next;
      input.current?.click();
    },
  }));
  return (
    <input
      ref={input}
      type="file"
      multiple
      accept={DRAFT_UPLOAD_ACCEPT}
      className="hidden"
      aria-label="Upload project files"
      disabled={disabled}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        if (!files.length) return;
        const chosen = category.current;
        onBusy?.(true);
        void uploadDraftFiles(files, { scope, category: chosen, onError })
          .then((assets) => onAssets(assets, chosen))
          .finally(() => {
            onBusy?.(false);
            if (input.current) input.current.value = "";
          });
      }}
    />
  );
}
