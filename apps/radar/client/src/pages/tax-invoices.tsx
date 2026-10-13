import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  Settings,
  Printer,
  Download,
  FileText,
  Loader2,
  AlertTriangle,
  Receipt,
  FileArchive,
} from "lucide-react";

type Terminal = "reception" | "restaurant";
type TerminalFilter = "all" | Terminal;

interface InvoiceItem {
  name: string;
  quantity: number;
  itemTotal: number;
}
interface InvoicePayment {
  method: string;
  amount: number;
}
interface InvoiceData {
  id: string;
  terminal: Terminal;
  receiptNumber: string;
  orderNumber: string;
  orderDate: string | null;
  channelName: string;
  channelType: string;
  customerName: string;
  posNo: string;
  items: InvoiceItem[];
  itemSubtotal: number;
  serviceCharge: number;
  totalBeforeTax: number;
  tax: number;
  total: number;
  billTotal: number;
  tipTotal: number;
  isTaxInclusive: boolean;
  payments: InvoicePayment[];
}

interface InvoiceSettings {
  header: {
    companyName: string;
    addressLines: string[];
    tel: string;
    legalEntity: string;
    taxId: string;
  };
  posTaxIds: { reception: string; restaurant: string };
}

const TERMINAL_LABEL: Record<Terminal, string> = {
  reception: "Reception",
  restaurant: "Café",
};

function fmtBkkToday(): string {
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  return `${bkk.getFullYear()}-${String(bkk.getMonth() + 1).padStart(2, "0")}-${String(bkk.getDate()).padStart(2, "0")}`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function applyPreset(
  preset: string,
): { from: string; to: string } {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (preset === "today") return { from: fmt(today), to: fmt(today) };
  if (preset === "yesterday") {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return { from: fmt(y), to: fmt(y) };
  }
  if (preset === "last7") {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { from: fmt(start), to: fmt(today) };
  }
  if (preset === "last30") {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { from: fmt(start), to: fmt(today) };
  }
  if (preset === "thisMonth") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: fmt(start), to: fmt(today) };
  }
  if (preset === "lastMonth") {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: fmt(start), to: fmt(end) };
  }
  return { from: fmt(today), to: fmt(today) };
}

// Receipt rendering helpers — produces lines for both screen and PDF.
const RECEIPT_COLS = 40; // characters wide for monospace receipt (normal 8pt Courier on 80mm page)
const RECEIPT_COLS_LARGE = 28; // characters wide for the larger 11pt header font

function padRight(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return " ".repeat(n - s.length) + s;
}
function divider(): string {
  return "-".repeat(RECEIPT_COLS);
}
function center(s: string, width = RECEIPT_COLS): string {
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s;
}
function wrapText(s: string, width = RECEIPT_COLS): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur.length) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface RenderLine {
  text: string;
  bold?: boolean;
  size?: "normal" | "large";
  align?: "left" | "center";
}

function renderInvoiceLines(inv: InvoiceData, settings: InvoiceSettings): RenderLine[] {
  const lines: RenderLine[] = [];
  // Big header: company name (wrap using LARGE-font column count)
  for (const wl of wrapText(settings.header.companyName, RECEIPT_COLS_LARGE)) {
    lines.push({ text: wl, bold: true, size: "large", align: "center" });
  }
  lines.push({ text: "" });
  for (const al of settings.header.addressLines) {
    if (!al || !al.trim()) continue;
    for (const wl of wrapText(al.trim(), RECEIPT_COLS)) {
      lines.push({ text: wl, align: "center" });
    }
  }
  if (settings.header.tel)
    for (const wl of wrapText(`Tel: ${settings.header.tel}`, RECEIPT_COLS))
      lines.push({ text: wl, align: "center" });
  if (settings.header.legalEntity)
    for (const wl of wrapText(settings.header.legalEntity, RECEIPT_COLS))
      lines.push({ text: wl, align: "center" });
  if (settings.header.taxId)
    for (const wl of wrapText(`Tax ID: ${settings.header.taxId}`, RECEIPT_COLS))
      lines.push({ text: wl, align: "center" });
  lines.push({ text: "" });
  lines.push({ text: "Receipt / Tax Invoice", bold: true, size: "large", align: "center" });
  lines.push({ text: "(ABB)", bold: true, size: "large", align: "center" });
  lines.push({ text: "" });
  lines.push({ text: "VAT Included", align: "center" });
  lines.push({ text: "" });
  lines.push({ text: divider() });

  const posTax = settings.posTaxIds[inv.terminal] || "";
  const posLine = inv.posNo
    ? `POS No.: ${inv.posNo}  POS TAX ID: ${posTax}`
    : `POS TAX ID: ${posTax}`;
  const pushWrapped = (s: string) => {
    for (const wl of wrapText(s, RECEIPT_COLS)) lines.push({ text: wl });
  };
  pushWrapped(posLine);
  pushWrapped(`Receipt No.: ${inv.receiptNumber}`);
  pushWrapped(`Order ID: ${inv.id}`);
  if (inv.orderNumber) pushWrapped(`Order No.: ${inv.orderNumber}`);
  if (inv.orderDate) {
    const d = new Date(inv.orderDate);
    const bkk = new Date(d.getTime() + (d.getTimezoneOffset() + 7 * 60) * 60000);
    const datestr = `${bkk.getDate()} ${bkk.toLocaleString("en-US", { month: "short" })} ${bkk.getFullYear()} ${String(bkk.getHours()).padStart(2, "0")}:${String(bkk.getMinutes()).padStart(2, "0")}`;
    pushWrapped(`Date: ${datestr}`);
  }
  if (inv.customerName) pushWrapped(`Customer: ${inv.customerName}`);
  if (inv.channelName) pushWrapped(`Channel: ${inv.channelName}`);
  if (inv.channelType) pushWrapped(`Channel Type: ${inv.channelType}`);
  lines.push({ text: divider() });

  const amtCol = 12;
  const descCol = RECEIPT_COLS - amtCol;
  lines.push({ text: padRight("Description", descCol) + padLeft("Amount(THB)", amtCol) });
  lines.push({ text: divider() });
  for (const it of inv.items) {
    const left = `${it.quantity}x ${it.name}`;
    const right = fmtMoney(it.itemTotal);
    if (left.length <= descCol) {
      lines.push({ text: padRight(left, descCol) + padLeft(right, amtCol) });
    } else {
      const wrapped = wrapText(left, descCol);
      for (let i = 0; i < wrapped.length; i++) {
        if (i === wrapped.length - 1) {
          lines.push({ text: padRight(wrapped[i], descCol) + padLeft(right, amtCol) });
        } else {
          lines.push({ text: wrapped[i] });
        }
      }
    }
  }
  lines.push({ text: divider() });

  const row = (k: string, v: string, bold = false) =>
    lines.push({
      text: padRight(k, RECEIPT_COLS - amtCol) + padLeft(v, amtCol),
      bold,
    });

  row("Item Total:", fmtMoney(inv.itemSubtotal));
  row("Subtotal:", fmtMoney(inv.itemSubtotal));
  row("Service Charge:", fmtMoney(inv.serviceCharge));
  lines.push({ text: divider() });
  row("Total Before Tax:", fmtMoney(inv.totalBeforeTax));
  row("Tax 7.0%:", fmtMoney(inv.tax));
  lines.push({ text: divider() });
  row("Total:", fmtMoney(inv.total), true);
  lines.push({ text: divider() });
  row("Tips:", fmtMoney(inv.tipTotal));
  lines.push({ text: "" });
  for (const p of inv.payments) {
    row(`${p.method}:`, fmtMoney(p.amount));
  }
  lines.push({ text: "" });
  lines.push({ text: "Powered by papaya.co.th", align: "center" });
  return lines;
}

async function renderPdf(invoices: InvoiceData[], settings: InvoiceSettings): Promise<{ jsPDF: any; doc: any }> {
  const jsPDFmod: any = await import("jspdf");
  const JsPDF = jsPDFmod.jsPDF || jsPDFmod.default;

  // Receipt page: 80mm wide, height computed per invoice.
  const W_MM = 80;
  const MARGIN = 4;
  const FONT_NORMAL = 8;
  const FONT_LARGE = 11;
  const LINE_NORMAL = 3.6;
  const LINE_LARGE = 4.6;

  function heightFor(lines: RenderLine[]): number {
    let h = MARGIN * 2;
    for (const l of lines) {
      h += l.size === "large" ? LINE_LARGE : LINE_NORMAL;
    }
    return Math.max(h, 60);
  }

  const firstLines = renderInvoiceLines(invoices[0], settings);
  const doc = new JsPDF({ unit: "mm", format: [W_MM, heightFor(firstLines)] });

  function drawInvoice(d: any, lines: RenderLine[]) {
    let y = MARGIN + LINE_NORMAL;
    d.setFont("courier", "normal");
    for (const l of lines) {
      const size = l.size === "large" ? FONT_LARGE : FONT_NORMAL;
      d.setFontSize(size);
      d.setFont("courier", l.bold ? "bold" : "normal");
      const txt = l.text;
      if (l.align === "center") {
        d.text(txt, W_MM / 2, y, { align: "center" });
      } else {
        d.text(txt, MARGIN, y);
      }
      y += l.size === "large" ? LINE_LARGE : LINE_NORMAL;
    }
  }

  drawInvoice(doc, firstLines);
  for (let i = 1; i < invoices.length; i++) {
    const lines = renderInvoiceLines(invoices[i], settings);
    doc.addPage([W_MM, heightFor(lines)], "portrait");
    drawInvoice(doc, lines);
  }
  return { jsPDF: JsPDF, doc };
}

function InvoicePreview({ invoice, settings }: { invoice: InvoiceData; settings: InvoiceSettings }) {
  const lines = useMemo(() => renderInvoiceLines(invoice, settings), [invoice, settings]);
  return (
    <pre
      className="font-mono text-[11px] leading-[1.35] bg-white text-black p-4 rounded-md border whitespace-pre w-fit mx-auto"
      data-testid="invoice-preview"
    >
      {lines
        .map((l) => {
          const text = l.align === "center" ? center(l.text) : l.text;
          return text;
        })
        .join("\n")}
    </pre>
  );
}

function isInvoiceBlocked(inv: InvoiceData, settings: InvoiceSettings): boolean {
  return !settings.posTaxIds[inv.terminal];
}

export default function TaxInvoicesPage() {
  const { toast } = useToast();
  const todayStr = fmtBkkToday();
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [terminal, setTerminal] = useState<TerminalFilter>("all");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  type SortKey = "receipt" | "date" | "device" | "total";
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "total" ? "desc" : "asc"); }
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("settings") === "open") setSettingsOpen(true);
    }
  }, []);

  const settingsQuery = useQuery<InvoiceSettings>({
    queryKey: ["/api/papaya/invoice-settings"],
  });

  const invoicesQuery = useQuery<{ invoices: InvoiceData[] }>({
    queryKey: ["/api/papaya/invoices", from, to, terminal],
    queryFn: async () => {
      const params = new URLSearchParams({ from, to });
      if (terminal !== "all") params.set("terminal", terminal);
      const r = await fetch(`/api/papaya/invoices?${params.toString()}`);
      if (!r.ok) throw new Error("Failed to load invoices");
      return r.json();
    },
  });

  const invoices = invoicesQuery.data?.invoices || [];
  const settings = settingsQuery.data;

  const totalSum = invoices.reduce((a, x) => a + x.total, 0);
  const sortedInvoices = [...invoices].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortKey) {
      case "receipt": return (a.receiptNumber || "").localeCompare(b.receiptNumber || "") * dir;
      case "device": return TERMINAL_LABEL[a.terminal].localeCompare(TERMINAL_LABEL[b.terminal]) * dir;
      case "total": return (a.total - b.total) * dir;
      case "date":
      default: {
        const da = a.orderDate ? new Date(a.orderDate).getTime() : 0;
        const db = b.orderDate ? new Date(b.orderDate).getTime() : 0;
        return (da - db) * dir;
      }
    }
  });
  const previewInvoice = invoices.find((i) => `${i.terminal}:${i.id}` === previewKey) || null;

  async function handleDownloadOne(inv: InvoiceData) {
    if (!settings) return;
    if (isInvoiceBlocked(inv, settings)) {
      toast({
        title: "Missing POS Tax ID",
        description: `Set the ${TERMINAL_LABEL[inv.terminal]} POS Tax ID in Settings before downloading.`,
        variant: "destructive",
      });
      return;
    }
    setBulkBusy("one");
    try {
      const { doc } = await renderPdf([inv], settings);
      doc.save(`${inv.receiptNumber || inv.id}.pdf`);
    } finally {
      setBulkBusy(null);
    }
  }

  async function handleBulkPdf() {
    if (!settings) return;
    const blocked = invoices.filter((i) => isInvoiceBlocked(i, settings));
    if (blocked.length > 0) {
      toast({
        title: "Some terminals missing POS Tax ID",
        description: `${blocked.length} invoice(s) cannot be generated. Update Settings first.`,
        variant: "destructive",
      });
      return;
    }
    if (!invoices.length) return;
    setBulkBusy("pdf");
    try {
      const { doc } = await renderPdf(invoices, settings);
      doc.save(`papaya-invoices-${from}_to_${to}.pdf`);
    } finally {
      setBulkBusy(null);
    }
  }

  async function handleBulkZip() {
    if (!settings) return;
    const blocked = invoices.filter((i) => isInvoiceBlocked(i, settings));
    if (blocked.length > 0) {
      toast({
        title: "Some terminals missing POS Tax ID",
        description: `${blocked.length} invoice(s) cannot be generated. Update Settings first.`,
        variant: "destructive",
      });
      return;
    }
    if (!invoices.length) return;
    setBulkBusy("zip");
    try {
      const JSZipMod: any = await import("jszip");
      const JSZip = JSZipMod.default || JSZipMod;
      const zip = new JSZip();
      for (const inv of invoices) {
        const { doc } = await renderPdf([inv], settings);
        const blob = doc.output("arraybuffer");
        const safeReceipt = (inv.receiptNumber || "invoice").replace(/[^A-Za-z0-9_-]/g, "_");
        const shortId = inv.id.slice(-6);
        zip.file(`${safeReceipt}-${inv.terminal}-${shortId}.pdf`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `papaya-invoices-${from}_to_${to}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBulkBusy(null);
    }
  }

  function handlePrint() {
    if (!previewInvoice || !settings) return;
    const lines = renderInvoiceLines(previewInvoice, settings).map((l) =>
      l.align === "center" ? center(l.text) : l.text,
    );
    const html = `<!doctype html><html><head><title>${previewInvoice.receiptNumber}</title>
      <style>
        @page { size: 80mm auto; margin: 4mm; }
        body { font-family: 'Courier New', Courier, monospace; font-size: 11px; line-height: 1.35; white-space: pre; margin: 0; }
      </style></head><body>${lines
        .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
        .join("\n")}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),250);}<\/script></body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  const blockedCount = settings ? invoices.filter((i) => isInvoiceBlocked(i, settings)).length : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-background/85 border-b border-border/40 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1" data-testid="link-back-dashboard">
                <ArrowLeft className="h-4 w-4" />
                Dashboard
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-orange-500" />
              <h1 className="text-base font-semibold">Tax Invoices (ABB)</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setSettingsOpen(true)}
              data-testid="button-open-settings"
            >
              <Settings className="h-4 w-4" />
              Settings
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 space-y-4">
        <div className="neu-card p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Date range</Label>
              <DateRangePicker
                from={from}
                to={to}
                onChange={(r) => {
                  if (r.from) setFrom(r.from);
                  if (r.to) setTo(r.to);
                }}
                data-testid="picker-date-range"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">POS Device</Label>
              <Select value={terminal} onValueChange={(v) => setTerminal(v as TerminalFilter)}>
                <SelectTrigger className="w-[160px]" data-testid="select-terminal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All devices</SelectItem>
                  <SelectItem value="reception">Reception</SelectItem>
                  <SelectItem value="restaurant">Café</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-1">
              {[
                { key: "today", label: "Today" },
                { key: "yesterday", label: "Yesterday" },
                { key: "last7", label: "Last 7d" },
                { key: "last30", label: "Last 30d" },
                { key: "thisMonth", label: "This month" },
                { key: "lastMonth", label: "Last month" },
                { key: "custom", label: "Custom…" },
              ].map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (p.key === "custom") {
                      const trigger = document.querySelector<HTMLButtonElement>(
                        '[data-testid="picker-date-range"]',
                      );
                      trigger?.click();
                      return;
                    }
                    const r = applyPreset(p.key);
                    setFrom(r.from);
                    setTo(r.to);
                  }}
                  data-testid={`preset-${p.key}`}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div data-testid="text-invoice-summary" className="text-muted-foreground">
              {invoicesQuery.isLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading invoices…
                </span>
              ) : (
                <>
                  <span className="font-medium text-foreground">{invoices.length}</span> invoices,{" "}
                  <span className="font-medium text-foreground">฿{fmtMoney(totalSum)}</span> total
                  {blockedCount > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> {blockedCount} blocked (missing POS Tax ID)
                      <button
                        type="button"
                        className="underline ml-1 hover:text-amber-700 dark:hover:text-amber-300"
                        onClick={() => setSettingsOpen(true)}
                        data-testid="link-open-settings-summary"
                      >
                        Open Settings
                      </button>
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleBulkPdf}
                disabled={!invoices.length || bulkBusy !== null}
                data-testid="button-bulk-pdf"
              >
                {bulkBusy === "pdf" ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-1" />
                )}
                Download all as PDF
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleBulkZip}
                disabled={!invoices.length || bulkBusy !== null}
                data-testid="button-bulk-zip"
              >
                {bulkBusy === "zip" ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <FileArchive className="h-4 w-4 mr-1" />
                )}
                Download all as ZIP
              </Button>
            </div>
          </div>
        </div>

        <div className="neu-card overflow-hidden">
          {invoicesQuery.isError ? (
            <div className="p-6 text-center text-sm text-destructive" data-testid="text-error">
              Failed to load invoices.
            </div>
          ) : !invoicesQuery.isLoading && invoices.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground" data-testid="text-empty">
              No completed Papaya orders in this range.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("receipt")} data-testid="sort-receipt">
                      Receipt No.{sortKey === "receipt" && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("date")} data-testid="sort-date">
                      Date / Time{sortKey === "date" && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>
                    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("device")} data-testid="sort-device">
                      Device{sortKey === "device" && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button className="inline-flex items-center gap-1 hover:text-foreground ml-auto" onClick={() => toggleSort("total")} data-testid="sort-total">
                      Total{sortKey === "total" && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedInvoices.map((inv) => {
                  const blocked = settings ? isInvoiceBlocked(inv, settings) : false;
                  return (
                    <TableRow
                      key={`${inv.terminal}:${inv.id}`}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setPreviewKey(`${inv.terminal}:${inv.id}`)}
                      data-testid={`row-invoice-${inv.id}`}
                    >
                      <TableCell className="font-mono text-xs" data-testid={`text-receipt-${inv.id}`}>
                        {inv.receiptNumber}
                      </TableCell>
                      <TableCell className="text-xs">
                        {inv.orderDate
                          ? format(new Date(inv.orderDate), "yyyy-MM-dd HH:mm")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs">{inv.channelName || "—"}</TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1">
                          {TERMINAL_LABEL[inv.terminal]}
                          {blocked && (
                            <AlertTriangle
                              className="h-3 w-3 text-amber-500"
                              aria-label="Missing POS Tax ID"
                            />
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ฿{fmtMoney(inv.total)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {inv.payments.map((p) => p.method).join(", ") || "—"}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDownloadOne(inv)}
                          disabled={bulkBusy !== null || blocked}
                          data-testid={`button-download-${inv.id}`}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </main>

      <Dialog open={!!previewInvoice} onOpenChange={(o) => !o && setPreviewKey(null)}>
        <DialogContent className="w-auto max-w-[92vw] sm:max-w-fit">
          <DialogHeader>
            <DialogTitle>Invoice Preview</DialogTitle>
            <DialogDescription>
              {previewInvoice?.receiptNumber} · {previewInvoice ? TERMINAL_LABEL[previewInvoice.terminal] : ""}
            </DialogDescription>
          </DialogHeader>
          {previewInvoice && settings && (
            <InvoicePreview invoice={previewInvoice} settings={settings} />
          )}
          {previewInvoice && settings && isInvoiceBlocked(previewInvoice, settings) && (
            <div className="text-xs text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Missing POS Tax ID for this device.
              <button
                type="button"
                className="underline ml-1 hover:text-amber-700 dark:hover:text-amber-300"
                onClick={() => setSettingsOpen(true)}
                data-testid="link-open-settings-preview"
              >
                Open Settings
              </button>
              to enable downloads.
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            Note: Papaya does not store cash tendered. The invoice shows the actual payment method
            and amount paid; the Change line is omitted.
          </p>
          <DialogFooter className="flex-row gap-2 justify-end">
            <Button variant="outline" onClick={handlePrint} data-testid="button-print">
              <Printer className="h-4 w-4 mr-1" /> Print
            </Button>
            <Button
              onClick={() => previewInvoice && handleDownloadOne(previewInvoice)}
              disabled={!previewInvoice || (settings ? isInvoiceBlocked(previewInvoice, settings) : false)}
              data-testid="button-download-pdf"
            >
              <Download className="h-4 w-4 mr-1" /> Download PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
      />
    </div>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  settings,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: InvoiceSettings | undefined;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<InvoiceSettings | null>(null);

  useEffect(() => {
    if (open && settings) {
      setDraft(JSON.parse(JSON.stringify(settings)));
    }
  }, [open, settings]);

  const saveMutation = useMutation({
    mutationFn: async (s: InvoiceSettings) => {
      const r = await apiRequest("PUT", "/api/papaya/invoice-settings", s);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/papaya/invoice-settings"] });
      toast({ title: "Settings saved" });
      onOpenChange(false);
    },
    onError: (e: any) => {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    },
  });

  if (!draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tax Invoice Settings</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">Loading…</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Tax Invoice Settings</DialogTitle>
          <DialogDescription>
            Header text appears on every invoice. POS Tax IDs are per device.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Company name</Label>
            <Input
              value={draft.header.companyName}
              onChange={(e) =>
                setDraft({ ...draft, header: { ...draft.header, companyName: e.target.value } })
              }
              data-testid="input-company-name"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Address (one line per row)</Label>
            <Textarea
              value={draft.header.addressLines.join("\n")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  header: {
                    ...draft.header,
                    addressLines: e.target.value.split("\n"),
                  },
                })
              }
              rows={2}
              data-testid="input-address"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tel</Label>
              <Input
                value={draft.header.tel}
                onChange={(e) =>
                  setDraft({ ...draft, header: { ...draft.header, tel: e.target.value } })
                }
                data-testid="input-tel"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Legal entity</Label>
              <Input
                value={draft.header.legalEntity}
                onChange={(e) =>
                  setDraft({ ...draft, header: { ...draft.header, legalEntity: e.target.value } })
                }
                data-testid="input-legal-entity"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">T&T Tax ID</Label>
            <Input
              value={draft.header.taxId}
              onChange={(e) =>
                setDraft({ ...draft, header: { ...draft.header, taxId: e.target.value } })
              }
              data-testid="input-tax-id"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Reception POS Tax ID</Label>
              <Input
                value={draft.posTaxIds.reception}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    posTaxIds: { ...draft.posTaxIds, reception: e.target.value },
                  })
                }
                placeholder="(not set)"
                data-testid="input-pos-reception"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Café POS Tax ID</Label>
              <Input
                value={draft.posTaxIds.restaurant}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    posTaxIds: { ...draft.posTaxIds, restaurant: e.target.value },
                  })
                }
                data-testid="input-pos-restaurant"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground border-l-2 border-amber-500 pl-2">
            Note: Papaya does not record the cash amount tendered, so generated invoices show the
            actual payment method and amount paid (e.g. "Cash: 43.20") and omit the Change line.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate(draft)}
            disabled={saveMutation.isPending}
            data-testid="button-save-settings"
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
