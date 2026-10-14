/**
 * The rail's icons: one 16 x 16 outline path per step, as design/particl-prototype-25 draws them (its `RAILICON`). A step with none gets the Elements one.
 * Keys are the prototype's step ids; the board screen maps its own stages onto them.
 */
export const RAIL_ICONS: Readonly<Record<string, string>> = {
  pitch: "M3 2h9l1 1v11H3zM6 2v12M8 6h3M8 9h3",
  pitchdeck: "M2 3h12v8H2zM8 11v3M5 14l3-3 3 3",
  brief: "M5 3h6v2H5zM4 4H3v10h10V4h-1M6 8h4M6 11h3",
  script: "M4 2h6l3 3v9H4zM10 2v3h3M6 8h4M6 11h4",
  cast: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5",
  locations: "M8 14s5-4.5 5-8.5a5 5 0 0 0-10 0C3 9.5 8 14 8 14zM8 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  elements: "M3 5l5-3 5 3v6l-5 3-5-3zM3 5l5 3 5-3M8 8v6",
  storyboard: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  shots: "M2 5h8v6H2zM10 7l4-2v6l-4-2",
  edit: "M2 4h12M2 8h6M9 8h5M2 12h9",
  deliver: "M2 8h10M8 4l4 4-4 4",
  animatic: "M2 3h12v10H2zM7 6v4l3-2z",
  ppm: "M3 5h10v8H3zM5 3h8M4 4h9",
  look: "M8 2a6 6 0 1 0 0 12c1 0 1.5-.5 1.5-1.2 0-.8-.7-1-.7-1.8 0-.5.4-1 1-1h1.2A3 3 0 0 0 14 7.2 5.5 5.5 0 0 0 8 2zM5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM11 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  formats: "M2 4h7v5H2zM10 2h4v12h-4z",
  variants: "M3 5h8v8H3zM5 3h8v8",
  hook: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z",
  voice: "M8 2a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0V4a2 2 0 0 1 2-2zM4 8a4 4 0 0 0 8 0M8 12v2",
  captions: "M2 4h12v8H2zM4 7.5h2.5M4 9.5h2.5M9 7.5h3M9 9.5h3",
  source: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 2v2M8 12v2M2 8h2M12 8h2",
  moments: "M2 12h12M8 3l1.2 2.5 2.8.4-2 2 .5 2.8L8 9.4l-2.5 1.3.5-2.8-2-2 2.8-.4z",
  clips: "M2 3h12v10H2zM5 3v10M11 3v10M5.5 8l5-3M5.5 8l5 3",
};

export const railIcon = (id: string): string => RAIL_ICONS[id] ?? RAIL_ICONS.elements;
