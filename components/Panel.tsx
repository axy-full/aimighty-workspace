export function Panel({
  title, right, children, className = "", bodyClass = "", rootRef,
}: {
  title?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string; bodyClass?: string;
  rootRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section ref={rootRef} className={`flex min-h-0 flex-col border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-2.5">
          <h2 className="ptitle text-[10.5px] tracking-[.1em] text-dim">{title}</h2>
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** Inspector row: micro-label left, control right — the shape every NLE uses. */
export function Row({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string;
}) {
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2 px-2.5 py-[5px]">
      <label className="lbl truncate" title={hint ?? label}>{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-hair py-1.5 last:border-0">
      <p className="lbl px-2.5 pb-1 pt-0.5 text-mute/70">{label}</p>
      {children}
    </div>
  );
}

/** Flat two-state switch, sized like a control not a web checkbox. */
export function Switch({ checked, onChange, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`h-[18px] w-[34px] shrink-0 rounded-full border transition-colors ${
        disabled
          ? "cursor-not-allowed border-hair bg-desk opacity-40"
          : checked
            ? "border-red bg-red"
            : "border-line bg-desk hover:border-[#34343f]"
      }`}
    >
      <span
        className={`block h-[12px] w-[12px] rounded-full bg-bone transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
