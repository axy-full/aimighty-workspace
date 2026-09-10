/**
 * One cell of a CSV, quoted for the format and defused for the spreadsheet.
 *
 * Quoting is not enough. A cell beginning `=`, `+`, `-`, `@` or a control
 * character is read by Excel, Numbers and Sheets as a FORMULA, and every
 * export here carries text a customer typed: a prompt, a shot title, a note.
 * `=HYPERLINK("https://…"&A1,"open")` in a shot title becomes a live link in
 * the producer's spreadsheet pointing at somebody else's server with the row
 * beside it appended, and older Excel will offer to run `=cmd|'…'!A1`.
 *
 * The person at risk is not the one who typed it. These files are the
 * handover — a producer bills a client from the shot list — so the
 * spreadsheet is opened by somebody outside the workspace entirely, who has
 * no reason to distrust it.
 *
 * A leading apostrophe is the fix every spreadsheet understands: it forces
 * the cell to text and is not displayed. It is added before quoting, so the
 * value still round-trips as data.
 */

/** Anything a spreadsheet may read as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  /* A negative number is not a formula, and quoting it as text would break
     the one column anybody sums. Only strings are defused. */
  if (typeof v !== "number" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
