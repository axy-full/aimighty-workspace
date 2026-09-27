import { AtomikSpinner } from "@/components/AtomikMark";

/**
 * What an atomik screen shows while its bundle is on the way — each screen's
 * own loading.tsx (breakdown, ideas, shots, treatment). It is not the atomik
 * folder's loading.tsx on purpose: that would put /atomik itself inside a
 * Suspense boundary, and its switch to Suites (a server redirect) would then be
 * streamed as a meta refresh instead of answered as a 307.
 */
export default function AtomikLoading() {
  return (
    <div className="screen grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-dim">
        <AtomikSpinner size={26} />
        <p className="text-[14px]">Opening</p>
      </div>
    </div>
  );
}
