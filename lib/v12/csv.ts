/** One CSV cell: quoted, with quotes doubled, and a cell that a spreadsheet would read as a formula quoted as text (the export's own rule, lib/workbench/studio-export.ts). */
export function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
