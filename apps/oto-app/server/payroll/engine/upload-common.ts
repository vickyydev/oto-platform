import * as XLSX from "xlsx";
import type { CompanyDownloadFile } from "./company-model";

export function binaryFile(group: CompanyDownloadFile["group"], filename: string, sheet: string, headers: string[], rows: (string | number)[][], total: number, biff = false, formats: Record<number, string> = {}): CompanyDownloadFile {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  rows.forEach((row, r) => row.forEach((_, c) => { const cell = ws[XLSX.utils.encode_cell({ r: r + 1, c })]; if (cell && formats[c]) cell.z = formats[c]; }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return { group, filename, encoding: "base64", mime: biff ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: XLSX.write(wb, { type: "base64", bookType: biff ? "biff8" : "xlsx" }), rows: rows.length, total, preview: { headers, rows } };
}
export function workbookFile(filename: string, sheet: string, matrix: (string | number)[][], rows: number, total: number, preview: CompanyDownloadFile["preview"]): CompanyDownloadFile {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), sheet);
  return { group: "Bank files", filename, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", encoding: "base64",
    content: XLSX.write(wb, { type: "base64", bookType: "xlsx" }), rows, total, preview };
}
export function thaiIdValid(id: string): boolean {
  if (!/^\d{13}$/.test(id) || /^(\d)\1{12}$/.test(id)) return false;
  const sum = id.slice(0, 12).split("").reduce((n, v, i) => n + Number(v) * (13 - i), 0);
  return (11 - sum % 11) % 10 === Number(id[12]);
}
export function fictionalThaiId(index: number): string {
  const prefix = `990${String(index).padStart(9, "0")}`;
  const sum = prefix.split("").reduce((n, v, i) => n + Number(v) * (13 - i), 0);
  return prefix + ((11 - sum % 11) % 10);
}
export function isoValueDate(month: string, value?: string): string {
  const date = value || `${month}-28`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw Error("Enter a valid value date.");
  return date;
}
export function buddhistDate(date: string): string { return String(Number(date.slice(0, 4)) + 543) + date.slice(5).replaceAll("-", ""); }
