/** Floating card surface — rounded, bordered, titled in the design's
 *  650-weight sentence case. */
export function Panel({
  title, right, children, className = "", bodyClass = "", rootRef,
}: {
  title?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string; bodyClass?: string;
  rootRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section ref={rootRef} className={`flex min-h-0 flex-col overflow-hidden rounded-[var(--r)] border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-hair px-4">
          <h2 className="ptitle text-[13px] text-bone">{title}</h2>
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}
