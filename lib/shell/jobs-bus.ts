/**
 * "A job just started": said by every place that submits one (the shared
 * dispatch in lib/workspace/generate-submit, Business's and Viral's
 * connected submits), heard by the header's jobs tray, which reads the list
 * again at once instead of on its next turn. Carries nothing but the id; the
 * tray's read is still the truth.
 */
export const JOBS_EVENT = "particl:jobs";

export function announceJob(id: string) {
  if (typeof window === "undefined" || !id) return;
  try { window.dispatchEvent(new CustomEvent(JOBS_EVENT, { detail: { id } })); } catch { /* the tray's own turn still finds it */ }
}

export function onJobAnnounced(listener: (id: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id === "string" && id) listener(id);
  };
  window.addEventListener(JOBS_EVENT, handle);
  return () => window.removeEventListener(JOBS_EVENT, handle);
}
