type P = { className?: string };
const base = {
  width: 19, height: 19, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

export const IconCompose = (p: P) => (
  <svg {...base} {...p}><path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="9" /></svg>
);
export const IconBins = (p: P) => (
  <svg {...base} {...p}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" /></svg>
);
export const IconLibrary = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="7.5" height="7" rx="1" /><rect x="13.5" y="4" width="7.5" height="7" rx="1" />
    <rect x="3" y="13" width="7.5" height="7" rx="1" /><rect x="13.5" y="13" width="7.5" height="7" rx="1" />
  </svg>
);
export const IconMeter = (p: P) => (
  <svg {...base} {...p}><path d="M4 19a8 8 0 1 1 16 0" /><path d="M12 19l4.2-5.6" /><circle cx="12" cy="19" r="1.2" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p} width={14} height={14}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
);
export const IconDown = (p: P) => (
  <svg {...base} {...p} width={13} height={13}><path d="M12 4v12M7 12l5 5 5-5M4 20h16" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base} {...p} width={13} height={13}><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} {...p} width={13} height={13}><path d="M12 5v14M5 12h14" /></svg>
);

export const IconFilm = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M7 5v14M17 5v14M3 12h18M3 8.5h4M3 15.5h4M17 8.5h4M17 15.5h4" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base} {...p} width={12} height={12}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

export const IconTeam = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 4.8M17.5 13.6A5.5 5.5 0 0 1 20.5 19" />
  </svg>
);
