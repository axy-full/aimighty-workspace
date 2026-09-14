"use client";

import { useCallback } from "react";
import { useSession } from "./session";
import { uploadFile } from "./uploadClient";

/** Keep every chunk and finish bound to the document that selected the file.
 * A fresh scope lookup here would silently adopt another tab's new account. */
export function useUploadFile() {
  const { signedIn, requestScope } = useSession();
  return useCallback(
    (
      file: File,
      purpose: "reference" | "chat",
      onProgress?: (pct: number) => void,
    ) => {
      if (!signedIn || !requestScope)
        return Promise.reject(
          new Error("Sign in to the intended workspace before uploading."),
        );
      return uploadFile(file, purpose, onProgress, { scope: requestScope });
    },
    [signedIn, requestScope],
  );
}
