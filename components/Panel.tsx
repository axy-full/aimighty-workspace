/** A card: white, weightless, resting on shadow rather than an outline. */
export function Panel({
  title, right, children, className = "", bodyClass = "", rootRef,
}: {
  title?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string; bodyClass?: string;
  rootRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section ref={rootRef} className={`card flex min-h-0 flex-col overflow-hidden ${className}`}>
      {title && (
        <header className="flex h-[52px] shrink-0 items-center gap-2 px-5">
          <h2 className="ptitle text-[16px] text-bone">{title}</h2>
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** Settings row: label left, control right — the shape every iOS list uses. */
export function Row({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <label className="text-[15px] text-dim" title={hint ?? label}>{label}</label>
      <div className="ml-auto min-w-0">{children}</div>
    </div>
  );
}

export function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-hair py-2 last:border-0">
      <p className="lbl px-5 pb-1.5 pt-1">{label}</p>
      {children}
    </div>
  );
}

/** The iOS switch: a green pill with a white knob. */
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
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 ${
        disabled ? "cursor-not-allowed bg-panel3 opacity-50"
        : checked ? "bg-ok" : "bg-[#E9E9EA]"
      }`}
    >
      <span
        className={`absolute top-[2px] block h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,.2)] transition-transform duration-200 ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
