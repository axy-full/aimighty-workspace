/** "43 cr", or the honest alternative when a figure cannot be computed. */
export const cr = (n: number | null | undefined) => (n == null ? "Live quote" : `${n.toLocaleString("en-US")} cr`);

/** "$49", "$39.20": whole dollars stay whole. */
export const usd = (n: number) =>
  `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "1,600" */
export const count = (n: number) => n.toLocaleString("en-US");
