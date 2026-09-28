import { creditsFigure } from "../creditTerms";
/** "43 cr", "2.4 cr", or a dash when a figure cannot be computed. */
export const cr = (n: number | null | undefined) => (n == null ? "—" : `${creditsFigure(n)} cr`);

/** "$49", "$39.20": whole dollars stay whole. */
export const usd = (n: number) =>
  `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "1,600" */
export const count = (n: number) => n.toLocaleString("en-US");
