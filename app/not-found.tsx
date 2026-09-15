import Link from "next/link";

/**
 * A link to nothing. Usually an old bookmark, or a project or render that has
 * since been deleted — both of which are ordinary here, so this says so
 * plainly rather than treating it as a fault.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-page p-6 text-ink">
      <div className="max-w-[44ch] text-center">
        <p className="text-[20px] font-semibold tracking-[-0.02em]">Nothing here</p>
        <p className="mt-2.5 text-[15px] leading-relaxed text-dim">
          The link may be old, or whatever it pointed at has been deleted.
          Deleted renders keep their cost on the ledger, so the numbers still add up.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link href="/" className="btn-render inline-flex h-[38px] items-center px-5 text-[14px]">
            Go to Video
          </Link>
          <Link href="/productions" className="chip">Projects</Link>
          <Link href="/all" className="chip">All takes</Link>
        </div>
      </div>
    </main>
  );
}
