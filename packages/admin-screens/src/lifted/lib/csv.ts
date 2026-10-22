// Tiny CSV export helper shared by the manager Reports module. Pure
// browser-side download (Blob + object URL) — no backend involved.

/**
 * A cell a spreadsheet would run as a formula — one starting with `=`, `+`,
 * `-` or `@` (after any spaces), or with a tab or a line break — is written
 * with a leading apostrophe, so it opens as the text it is (S2-15b round 4, as
 * the settlement and voucher ledger exports guard theirs). A plain number is a
 * number, negative or not, and is written as it is: a negative margin is not
 * a formula.
 */
export function guardCsvFormula(value: string | number): string {
  if (typeof value === 'number') return String(value);
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^\s*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
}

function escapeCsvCell(value: string | number): string {
  const s = guardCsvFormula(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) =>
    row.map(escapeCsvCell).join(',')
  );
  return lines.join('\n');
}

/** Build a CSV string and trigger a browser download with the given filename. */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number)[][]
): void {
  const csv = toCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
