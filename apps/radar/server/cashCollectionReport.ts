import { pool } from "./db";

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_INDEX = new Map(MONTHS.map((month, index) => [month.toLowerCase(), index]));

export interface CashCollectionPaymentSource {
  id?: number | string | null;
  order_id: string;
  order_date?: string | null;
  pay_method?: string | null;
  pay_amount?: number | string | null;
  refund_amount?: number | string | null;
  payment_at?: string | null;
  synced_at?: string | Date | null;
  raw_json?: unknown;
}

export interface CashCollectionOrderSource {
  id?: number | string | null;
  order_id: string;
  order_code?: string | null;
  created_at?: string | null;
  payment_status?: string | null;
  synced_at?: string | Date | null;
  raw_json?: unknown;
}

export interface CashCollectionProductSource {
  id?: number | string | null;
  order_id: string;
  product_name?: string | null;
  quantity?: number | string | null;
  subtotal?: number | string | null;
  raw_json?: unknown;
}

export interface CashCollectionRow {
  unique_payment_id: string;
  unique_order_id: string;
  order_number: string;
  receipt_number: string;
  order_created_time: string;
  payment_time: string;
  sorting_time: number | null;
  pay_details: string;
  payment_received: number;
  refund_amount: number;
  net_collected: number;
  payment_method: string;
  payment_status: string;
  product_list: string;
}

export interface CashCollectionSummary {
  paymentReceived: number;
  refundAmount: number;
  netCollected: number;
}

function parseJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function money(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Pisell's "DD/Mon/YYYY HH:mm:ss" values are Bangkok wall-clock timestamps
 * without an offset. We represent that wall clock in UTC fields so formatting,
 * date filtering, and Excel serials stay stable regardless of server timezone.
 */
export function parsePisellLocalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const local = value.match(
    /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  if (local) {
    const month = MONTH_INDEX.get(local[2].toLowerCase());
    if (month == null) return null;
    const date = new Date(Date.UTC(
      Number(local[3]),
      month,
      Number(local[1]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
    ));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // Convert an offset/ISO instant to Bangkok wall-clock fields.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  ));
}

function formatDateKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatDateTime(date: Date): string {
  let hour = date.getUTCHours();
  const suffix = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) hour = 12;
  return [
    `${String(date.getUTCDate()).padStart(2, "0")}/${MONTHS[date.getUTCMonth()]}/${date.getUTCFullYear()}`,
    `${String(hour).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} ${suffix}`,
  ].join(" ");
}

function formatPayDetailTime(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function formatReceiptDate(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function numericSuffix(value: string): string {
  return value.match(/(\d+)\s*$/)?.[1] ?? "";
}

function dateToExcelSerial(date: Date): number {
  return Math.round(((date.getTime() - EXCEL_EPOCH_MS) / 86_400_000) * 100_000) / 100_000;
}

function paymentSourceKey(payment: CashCollectionPaymentSource): string {
  const raw = parseJson(payment.raw_json);
  const pisellId = raw.id ?? raw.payment_id;
  if (pisellId != null && String(pisellId).trim()) return `id:${String(pisellId)}`;
  if (payment.id != null && String(payment.id).trim()) return `db:${String(payment.id)}`;
  return [
    "fallback",
    payment.order_id,
    payment.payment_at ?? "",
    money(payment.pay_amount).toFixed(2),
    String(payment.pay_method ?? "").trim().toLowerCase(),
  ].join("|");
}

function sourceVersion(source: { id?: number | string | null; synced_at?: string | Date | null }): [number, number] {
  const synced = source.synced_at ? new Date(source.synced_at).getTime() : 0;
  const id = Number(source.id ?? 0);
  return [Number.isFinite(synced) ? synced : 0, Number.isFinite(id) ? id : 0];
}

function isNewer(
  candidate: { id?: number | string | null; synced_at?: string | Date | null },
  current: { id?: number | string | null; synced_at?: string | Date | null },
): boolean {
  const [candidateSync, candidateId] = sourceVersion(candidate);
  const [currentSync, currentId] = sourceVersion(current);
  return candidateSync > currentSync || (candidateSync === currentSync && candidateId > currentId);
}

function dedupePayments(payments: CashCollectionPaymentSource[]): CashCollectionPaymentSource[] {
  const latest = new Map<string, CashCollectionPaymentSource>();
  payments.forEach((payment, index) => {
    const raw = parseJson(payment.raw_json);
    const hasStableIdentity =
      (raw.id != null && String(raw.id).trim())
      || (raw.payment_id != null && String(raw.payment_id).trim())
      || (payment.id != null && String(payment.id).trim());
    const key = hasStableIdentity ? paymentSourceKey(payment) : `unkeyed:${index}`;
    const current = latest.get(key);
    if (!current || isNewer(payment, current)) latest.set(key, payment);
  });
  return [...latest.values()];
}

function latestOrdersById(orders: CashCollectionOrderSource[]): Map<string, CashCollectionOrderSource> {
  const latest = new Map<string, CashCollectionOrderSource>();
  for (const order of orders) {
    const current = latest.get(String(order.order_id));
    if (!current || isNewer(order, current)) latest.set(String(order.order_id), order);
  }
  return latest;
}

function productLinesByOrder(products: CashCollectionProductSource[]): Map<string, string> {
  const seen = new Set<string>();
  const lines = new Map<string, string[]>();
  for (const product of products) {
    const raw = parseJson(product.raw_json);
    const key = raw.id != null
      ? `id:${String(raw.id)}`
      : [
          product.order_id,
          raw.product_id ?? raw.id ?? "",
          raw.variant_id ?? "",
          product.product_name ?? raw.product_title ?? raw.name ?? "",
          product.quantity ?? raw.product_quantity ?? raw.quantity ?? 1,
          product.subtotal ?? raw.payment_price ?? "",
        ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const name = String(product.product_name ?? raw.product_title ?? raw.name ?? "Unknown");
    const quantity = Number.parseInt(String(product.quantity ?? raw.product_quantity ?? raw.quantity ?? 1)) || 1;
    const amount = money(raw.original_price ?? raw.payment_price ?? product.subtotal);
    const orderLines = lines.get(String(product.order_id)) ?? [];
    orderLines.push(`${name} * ${quantity} @ ฿${amount.toFixed(2)}`);
    lines.set(String(product.order_id), orderLines);
  }
  return new Map([...lines.entries()].map(([orderId, orderLines]) => [orderId, orderLines.join("\n")]));
}

export function buildCashCollectionRows(
  payments: CashCollectionPaymentSource[],
  orders: CashCollectionOrderSource[],
  products: CashCollectionProductSource[],
  fromDate: string,
  toDate: string,
): CashCollectionRow[] {
  const orderById = latestOrdersById(orders);
  const productLines = productLinesByOrder(products);
  const rows: CashCollectionRow[] = [];

  for (const payment of dedupePayments(payments)) {
    const paymentDate =
      parsePisellLocalDate(payment.payment_at) ??
      parsePisellLocalDate(payment.order_date);
    if (!paymentDate) continue;
    const paymentDateKey = formatDateKey(paymentDate);
    if (paymentDateKey < fromDate || paymentDateKey > toDate) continue;

    const orderId = String(payment.order_id);
    const order = orderById.get(orderId);
    const orderRaw = parseJson(order?.raw_json);
    const paymentRaw = parseJson(payment.raw_json);
    const orderCode = String(order?.order_code ?? orderRaw.order_code ?? "");
    const method = String(payment.pay_method ?? paymentRaw.pay_method ?? "").trim() || "Unknown";
    const status = String(
      paymentRaw.payment_status ?? order?.payment_status ?? orderRaw.payment_status ?? "",
    ).trim();
    const received = money(payment.pay_amount);
    const refunded = money(payment.refund_amount);
    const isVoided = status.toLowerCase() === "voided";
    const net = isVoided ? 0 : roundMoney(received - refunded);
    const orderCreatedDate = parsePisellLocalDate(order?.created_at);
    const suffix = numericSuffix(orderCode);
    const paymentId = paymentSourceKey(payment).replace(/^(id:|db:|fallback\|)/, "");

    rows.push({
      unique_payment_id: paymentId,
      unique_order_id: orderId,
      order_number: orderCode,
      receipt_number: suffix ? `${formatReceiptDate(paymentDate)}${suffix}` : "",
      order_created_time: orderCreatedDate ? formatDateTime(orderCreatedDate) : String(order?.created_at ?? ""),
      payment_time: formatDateTime(paymentDate),
      sorting_time: dateToExcelSerial(paymentDate),
      pay_details: `${formatPayDetailTime(paymentDate)} @ Terminal @ ${method} @ ฿${received.toFixed(2)}${status ? ` ${status}` : ""}`,
      payment_received: received,
      refund_amount: refunded,
      net_collected: net,
      payment_method: method,
      payment_status: status,
      product_list: productLines.get(orderId) ?? "",
    });
  }

  rows.sort((a, b) =>
    (a.sorting_time ?? 0) - (b.sorting_time ?? 0) ||
    a.unique_payment_id.localeCompare(b.unique_payment_id),
  );
  return rows;
}

export function summarizeCashCollectionRows(rows: CashCollectionRow[]): CashCollectionSummary {
  return rows.reduce<CashCollectionSummary>(
    (summary, row) => ({
      paymentReceived: roundMoney(summary.paymentReceived + row.payment_received),
      refundAmount: roundMoney(summary.refundAmount + row.refund_amount),
      netCollected: roundMoney(summary.netCollected + row.net_collected),
    }),
    { paymentReceived: 0, refundAmount: 0, netCollected: 0 },
  );
}

async function loadCashCollectionSources(
  fromDate: string,
  toDate: string,
): Promise<{
  payments: CashCollectionPaymentSource[];
  orders: CashCollectionOrderSource[];
  products: CashCollectionProductSource[];
}> {
  const paymentsResult = await pool.query(
    `WITH ranked_payments AS (
       SELECT p.*,
              ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(
                   NULLIF(COALESCE(p.raw_json->>'id', p.raw_json->>'payment_id'), ''),
                  p.order_id || '|' || COALESCE(p.payment_at, '') || '|' ||
                  p.pay_amount::text || '|' || COALESCE(p.pay_method, '')
                )
                ORDER BY p.synced_at DESC, p.id DESC
              ) AS version_rank
         FROM funtopia_raw_payments p
     )
     SELECT id, order_id, order_date, pay_method, pay_amount, refund_amount,
            payment_at, synced_at, raw_json
       FROM ranked_payments
      WHERE version_rank = 1
        AND (
          order_date BETWEEN $1 AND $2
          OR CASE
               WHEN payment_at ~ '^\\d{1,2}/[A-Za-z]{3}/\\d{4}\\s'
                 THEN to_char(to_date(split_part(payment_at, ' ', 1), 'DD/Mon/YYYY'), 'YYYY-MM-DD')
               WHEN payment_at ~ '^\\d{4}-\\d{2}-\\d{2}'
                 THEN substring(payment_at from 1 for 10)
               ELSE NULL
             END BETWEEN $1 AND $2
        )
      ORDER BY payment_at NULLS LAST, id ASC`,
    [fromDate, toDate],
  );

  const payments = paymentsResult.rows as CashCollectionPaymentSource[];
  const orderIds = [...new Set(payments.map((payment) => String(payment.order_id)).filter(Boolean))];
  if (orderIds.length === 0) return { payments, orders: [], products: [] };

  const [ordersResult, productsResult] = await Promise.all([
    pool.query(
      `SELECT id, order_id, order_code, created_at, payment_status, synced_at, raw_json
         FROM funtopia_raw_orders
        WHERE order_id = ANY($1::text[])
        ORDER BY order_id, synced_at DESC, id DESC`,
      [orderIds],
    ),
    pool.query(
      `SELECT id, order_id, product_name, quantity, subtotal, raw_json
         FROM funtopia_orders
        WHERE order_id = ANY($1::text[])
        ORDER BY order_id, id ASC`,
      [orderIds],
    ),
  ]);

  return {
    payments,
    orders: ordersResult.rows as CashCollectionOrderSource[],
    products: productsResult.rows as CashCollectionProductSource[],
  };
}

export async function getCashCollectionRows(
  fromDate: string,
  toDate: string,
): Promise<CashCollectionRow[]> {
  const sources = await loadCashCollectionSources(fromDate, toDate);
  return buildCashCollectionRows(
    sources.payments,
    sources.orders,
    sources.products,
    fromDate,
    toDate,
  );
}

export async function buildCashCollectionWorkbookBuffer(
  fromDate: string,
  toDate: string,
): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const rows = await getCashCollectionRows(fromDate, toDate);
  const summary = summarizeCashCollectionRows(rows);
  const headers = [
    "unique_payment_id",
    "unique_order_id",
    "order_number",
    "Receipt Number",
    "order_created_time",
    "payment_time",
    "sorting_time",
    "pay_details",
    "Payment Received",
    "refund_amount",
    "Net Payment",
    "payment_method",
    "payment_status",
    "product_list",
  ];
  const aoa: any[][] = [
    headers,
    ...rows.map((row) => [
      row.unique_payment_id,
      row.unique_order_id,
      row.order_number,
      row.receipt_number,
      row.order_created_time,
      row.payment_time,
      row.sorting_time,
      row.pay_details,
      row.payment_received,
      row.refund_amount,
      row.net_collected,
      row.payment_method,
      row.payment_status,
      row.product_list,
    ]),
    [],
    ["PERIOD TOTAL", "", "", "", "", "", "", "", summary.paymentReceived, summary.refundAmount, summary.netCollected],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const totalRowIndex = rows.length + 2;
  for (let rowIndex = 1; rowIndex <= totalRowIndex; rowIndex++) {
    for (const columnIndex of [8, 9, 10]) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = (worksheet as any)[address];
      if (cell && typeof cell.v === "number") {
        cell.t = "n";
        cell.z = "0.00";
      }
    }
    const sortingAddress = XLSX.utils.encode_cell({ r: rowIndex, c: 6 });
    const sortingCell = (worksheet as any)[sortingAddress];
    if (sortingCell && typeof sortingCell.v === "number") {
      sortingCell.t = "n";
      sortingCell.z = "0.00000";
    }
  }

  (worksheet as any)["!cols"] = [
    { wch: 18 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 23 },
    { wch: 23 },
    { wch: 14 },
    { wch: 58 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 34 },
    { wch: 20 },
    { wch: 80 },
  ];
  (worksheet as any)["!autofilter"] = { ref: `A1:N${Math.max(rows.length + 1, 1)}` };
  (worksheet as any)["!freeze"] = { xSplit: 0, ySplit: 1 };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Cash Collection Details");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
}