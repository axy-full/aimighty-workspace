type P = { className?: string };
const base = {
  width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.6,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

/* Navigation — drawn light, in the SF idiom. */
export const IconProjects = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2h7.2A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);
export const IconGenerate = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.6l1.9 4.3 4.3 1.9-4.3 1.9L12 16l-1.9-4.3L5.8 9.8l4.3-1.9z" />
    <path d="M18.5 14.6l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8z" />
  </svg>
);
/* Studio — a clapper board: the place a shot is specified before it's shot. */
export const IconStudio = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3.5 9.5h17v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M3.9 6.2l15.6-1.7.6 3.4-15.6 1.7z" />
    <path d="M8.6 5.7l1.1 3.3M13.4 5.2l1.1 3.3" />
  </svg>
);
export const IconMeter = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 19v-6M12 19V6M19 19v-9" />
  </svg>
);
export const IconGear = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3.5a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3.5a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

/* Working icons */
export const IconCompose = IconGenerate;
export const IconBins = IconProjects;
export const IconLibrary = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="7.5" height="7" rx="1.8" /><rect x="13.5" y="4" width="7.5" height="7" rx="1.8" />
    <rect x="3" y="13" width="7.5" height="7" rx="1.8" /><rect x="13.5" y="13" width="7.5" height="7" rx="1.8" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p} width={17} height={17}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
);
export const IconDown = (p: P) => (
  <svg {...base} {...p} width={16} height={16}><path d="M12 4v12M7 12l5 5 5-5M4 20h16" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base} {...p} width={16} height={16}><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} {...p} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconFilm = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <path d="M7 5v14M17 5v14M3 12h18M3 8.5h4M3 15.5h4M17 8.5h4M17 15.5h4" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base} {...p} width={14} height={14}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconTeam = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 4.8M17.5 13.6A5.5 5.5 0 0 1 20.5 19" />
  </svg>
);
export const IconChevron = (p: P) => (
  <svg {...base} {...p} width={16} height={16} strokeWidth={2}><path d="M9 5l7 7-7 7" /></svg>
);
export const IconArrowUp = (p: P) => (
  <svg {...base} {...p} width={18} height={18} strokeWidth={2.1}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
);
export const IconSparkle = (p: P) => (
  <svg {...base} {...p} width={17} height={17}>
    <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z" />
  </svg>
);

/* The island and the theatre */
export const IconCaret = (p: P) => (
  <svg {...base} {...p} width={12} height={12} strokeWidth={2.2}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconArrowLeft = (p: P) => (
  <svg {...base} {...p} width={18} height={18} strokeWidth={2}><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
);
export const IconArrowRight = (p: P) => (
  <svg {...base} {...p} width={18} height={18} strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconSliders = (p: P) => (
  <svg {...base} {...p} width={15} height={15}>
    <path d="M4 7h9M19 7h1M4 17h3M13 17h7" /><circle cx="15.5" cy="7" r="2.2" /><circle cx="9.5" cy="17" r="2.2" />
  </svg>
);
export const IconAttach = (p: P) => (
  <svg {...base} {...p} width={15} height={15}>
    <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.6 1.6 0 0 1-2.3-2.3L15 7.3" />
  </svg>
);
export const IconExpand = (p: P) => (
  <svg {...base} {...p} width={15} height={15}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
);
export const IconCopy = (p: P) => (
  <svg {...base} {...p} width={15} height={15}>
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);
