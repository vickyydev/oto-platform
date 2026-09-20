import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  DollarSign,
  FileText,
  Link2,
  Unlink,
  Loader2,
  RefreshCw,
  Building2,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";

interface XeroStatus {
  connected: boolean;
  xeroTenantName?: string;
  connectedAt?: string;
  expiresAt?: string;
  isExpired?: boolean;
}

interface ReportRow {
  RowType: string;
  Title?: string;
  Cells?: Array<{ Value: string; Attributes?: Array<{ Value: string; Id: string }> }>;
  Rows?: ReportRow[];
}

interface XeroReport {
  Reports?: Array<{
    ReportID: string;
    ReportName: string;
    ReportType: string;
    ReportTitles: string[];
    ReportDate: string;
    UpdatedDateUTC: string;
    Rows: ReportRow[];
  }>;
}

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: string;
  Contact: { Name: string };
  Status: string;
  Total: number;
  AmountDue: number;
  AmountPaid: number;
  CurrencyCode: string;
  Date: string;
  DueDate: string;
}

function formatCurrency(value: number | string, currency = "THB"): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(num);
}

function parseReportValue(val: string): number {
  if (!val) return 0;
  const cleaned = val.replace(/[^0-9.-]/g, "");
  return parseFloat(cleaned) || 0;
}

function XeroConnectCard({ status, onConnect, onDisconnect, isConnecting }: {
  status: XeroStatus | undefined;
  onConnect: () => void;
  onDisconnect: () => void;
  isConnecting: boolean;
}) {
  if (!status) return null;

  if (status.connected) {
    return (
      <Card className="border-green-500/30 bg-green-500/5">
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
              <Link2 className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="font-medium text-sm">Connected to Xero</p>
              <p className="text-xs text-muted-foreground">
                Organisation: <span className="font-medium">{status.xeroTenantName}</span>
                {status.connectedAt && (
                  <> · Connected {format(new Date(status.connectedAt), "MMM d, yyyy")}</>
                )}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onDisconnect} data-testid="button-xero-disconnect">
            <Unlink className="h-3.5 w-3.5 mr-1.5" />
            Disconnect
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-dashed">
      <CardContent className="p-8 flex flex-col items-center gap-4 text-center">
        <div className="h-14 w-14 rounded-2xl bg-blue-500/10 flex items-center justify-center">
          <BarChart3 className="h-7 w-7 text-blue-500" />
        </div>
        <div>
          <h3 className="font-semibold text-lg">Connect to Xero</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Link your Xero accounting to view financial reports, invoices, and business analytics directly in OTO Suite.
          </p>
        </div>
        <Button onClick={onConnect} disabled={isConnecting} data-testid="button-xero-connect">
          {isConnecting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Link2 className="h-4 w-4 mr-2" />
          )}
          Connect Xero Account
        </Button>
      </CardContent>
    </Card>
  );
}

function ProfitLossSection() {
  const now = new Date();
  const [period, setPeriod] = useState("current");

  const dateRange = useMemo(() => {
    if (period === "current") {
      return {
        fromDate: format(startOfMonth(now), "yyyy-MM-dd"),
        toDate: format(endOfMonth(now), "yyyy-MM-dd"),
      };
    } else if (period === "last3") {
      return {
        fromDate: format(startOfMonth(subMonths(now, 2)), "yyyy-MM-dd"),
        toDate: format(endOfMonth(now), "yyyy-MM-dd"),
        periods: "3",
        timeframe: "MONTH",
      };
    } else if (period === "last6") {
      return {
        fromDate: format(startOfMonth(subMonths(now, 5)), "yyyy-MM-dd"),
        toDate: format(endOfMonth(now), "yyyy-MM-dd"),
        periods: "6",
        timeframe: "MONTH",
      };
    } else {
      return {
        fromDate: format(new Date(now.getFullYear(), 0, 1), "yyyy-MM-dd"),
        toDate: format(endOfMonth(now), "yyyy-MM-dd"),
        periods: String(now.getMonth() + 1),
        timeframe: "MONTH",
      };
    }
  }, [period]);

  const params = new URLSearchParams(dateRange);
  const { data, isLoading, refetch } = useQuery<XeroReport>({
    queryKey: ["/api/auth/xero/profit-and-loss", dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/auth/xero/profit-and-loss?${params}`);
      if (!res.ok) throw new Error("Failed to load P&L");
      return res.json();
    },
  });

  const report = data?.Reports?.[0];

  const summaryNumbers = useMemo(() => {
    if (!report?.Rows) return null;
    let revenue = 0;
    let expenses = 0;
    let netProfit = 0;

    for (const section of report.Rows) {
      if (section.RowType === "Section" && section.Rows) {
        const title = (section.Title || "").toLowerCase();
        for (const row of section.Rows) {
          if (row.RowType === "SummaryRow" && row.Cells) {
            const val = parseReportValue(row.Cells[1]?.Value || "0");
            if (title.includes("income") || title.includes("revenue")) {
              revenue = val;
            } else if (title.includes("expense") || title.includes("cost") || title.includes("operating")) {
              expenses += Math.abs(val);
            }
          }
        }
      }
      if (section.RowType === "Section" && section.Title?.toLowerCase().includes("net profit")) {
        if (section.Rows?.[0]?.Cells) {
          netProfit = parseReportValue(section.Rows[0].Cells[1]?.Value || "0");
        }
      }
    }

    return { revenue, expenses, netProfit };
  }, [report]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold" data-testid="text-pnl-title">Profit & Loss</h2>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[160px]" data-testid="select-pnl-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">This Month</SelectItem>
              <SelectItem value="last3">Last 3 Months</SelectItem>
              <SelectItem value="last6">Last 6 Months</SelectItem>
              <SelectItem value="ytd">Year to Date</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" onClick={() => refetch()} data-testid="button-refresh-pnl">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : summaryNumbers ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <ArrowUpRight className="h-4 w-4 text-green-500" />
                  Revenue
                </div>
                <p className="text-2xl font-bold text-green-600" data-testid="text-revenue">
                  {formatCurrency(summaryNumbers.revenue)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <ArrowDownRight className="h-4 w-4 text-red-500" />
                  Expenses
                </div>
                <p className="text-2xl font-bold text-red-600" data-testid="text-expenses">
                  {formatCurrency(summaryNumbers.expenses)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  {summaryNumbers.netProfit >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-green-500" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-500" />
                  )}
                  Net Profit
                </div>
                <p
                  className={`text-2xl font-bold ${summaryNumbers.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                  data-testid="text-net-profit"
                >
                  {formatCurrency(summaryNumbers.netProfit)}
                </p>
              </CardContent>
            </Card>
          </div>

          {report && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {report.Rows.map((section, si) => {
                      if (section.RowType === "Header") {
                        return (
                          <TableRow key={si} className="bg-muted/50">
                            {section.Cells?.map((cell, ci) => (
                              <TableHead key={ci} className={ci > 0 ? "text-right" : ""}>
                                {cell.Value}
                              </TableHead>
                            ))}
                          </TableRow>
                        );
                      }
                      if (section.RowType === "Section") {
                        return (
                          <>{section.Title && (
                            <TableRow key={`title-${si}`} className="bg-muted/30">
                              <TableCell colSpan={10} className="font-semibold text-sm py-2">
                                {section.Title}
                              </TableCell>
                            </TableRow>
                          )}
                          {section.Rows?.map((row, ri) => (
                            <TableRow key={`${si}-${ri}`} className={row.RowType === "SummaryRow" ? "font-semibold bg-muted/20" : ""}>
                              {row.Cells?.map((cell, ci) => (
                                <TableCell key={ci} className={`py-1.5 text-sm ${ci > 0 ? "text-right" : ""}`}>
                                  {cell.Value}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                          </>
                        );
                      }
                      return null;
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No profit & loss data available for the selected period.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InvoicesSection() {
  const [statusFilter, setStatusFilter] = useState("all");
  const params = statusFilter !== "all" ? `?status=${statusFilter}` : "";

  const { data, isLoading, refetch } = useQuery<{ Invoices: XeroInvoice[] }>({
    queryKey: ["/api/auth/xero/invoices", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/auth/xero/invoices${params}`);
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
  });

  const invoices = data?.Invoices || [];

  const stats = useMemo(() => {
    const receivable = invoices.filter(i => i.Type === "ACCREC");
    const payable = invoices.filter(i => i.Type === "ACCPAY");
    return {
      totalReceivable: receivable.reduce((s, i) => s + (i.AmountDue || 0), 0),
      totalPayable: payable.reduce((s, i) => s + (i.AmountDue || 0), 0),
      overdue: invoices.filter(i => i.Status === "AUTHORISED" && new Date(i.DueDate) < new Date()).length,
    };
  }, [invoices]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold" data-testid="text-invoices-title">Invoices</h2>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]" data-testid="select-invoice-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="AUTHORISED">Outstanding</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" onClick={() => refetch()} data-testid="button-refresh-invoices">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <ArrowUpRight className="h-4 w-4 text-green-500" />
                  Receivable
                </div>
                <p className="text-xl font-bold" data-testid="text-receivable">{formatCurrency(stats.totalReceivable)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <ArrowDownRight className="h-4 w-4 text-red-500" />
                  Payable
                </div>
                <p className="text-xl font-bold" data-testid="text-payable">{formatCurrency(stats.totalPayable)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <FileText className="h-4 w-4 text-amber-500" />
                  Overdue
                </div>
                <p className="text-xl font-bold" data-testid="text-overdue">
                  {stats.overdue}
                  {stats.overdue > 0 && <span className="text-sm font-normal text-amber-500 ml-1">invoices</span>}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Due</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                          No invoices found
                        </TableCell>
                      </TableRow>
                    ) : (
                      invoices.slice(0, 50).map((inv) => {
                        const isOverdue = inv.Status === "AUTHORISED" && new Date(inv.DueDate) < new Date();
                        return (
                          <TableRow key={inv.InvoiceID} data-testid={`row-invoice-${inv.InvoiceID}`}>
                            <TableCell className="font-medium text-sm">{inv.InvoiceNumber || "-"}</TableCell>
                            <TableCell className="text-sm">{inv.Contact?.Name || "-"}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {inv.Type === "ACCREC" ? "Sales" : "Bill"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {inv.Date ? format(new Date(inv.Date), "dd MMM yyyy") : "-"}
                            </TableCell>
                            <TableCell className={`text-sm ${isOverdue ? "text-red-500 font-medium" : "text-muted-foreground"}`}>
                              {inv.DueDate ? format(new Date(inv.DueDate), "dd MMM yyyy") : "-"}
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium">
                              {formatCurrency(inv.Total, inv.CurrencyCode)}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {inv.AmountDue > 0 ? formatCurrency(inv.AmountDue, inv.CurrencyCode) : "-"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={inv.Status === "PAID" ? "default" : inv.Status === "AUTHORISED" ? "secondary" : "outline"}
                                className={`text-xs ${isOverdue ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" : ""}`}
                              >
                                {isOverdue ? "Overdue" : inv.Status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function BalanceSheetSection() {
  const { data, isLoading, refetch } = useQuery<XeroReport>({
    queryKey: ["/api/auth/xero/balance-sheet"],
    queryFn: async () => {
      const res = await fetch("/api/auth/xero/balance-sheet");
      if (!res.ok) throw new Error("Failed to load balance sheet");
      return res.json();
    },
  });

  const report = data?.Reports?.[0];

  const summaryNumbers = useMemo(() => {
    if (!report?.Rows) return null;
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;

    for (const section of report.Rows) {
      if (section.RowType === "Section" && section.Rows) {
        const title = (section.Title || "").toLowerCase();
        for (const row of section.Rows) {
          if (row.RowType === "SummaryRow" && row.Cells) {
            const val = parseReportValue(row.Cells[1]?.Value || "0");
            if (title.includes("asset")) totalAssets = val;
            else if (title.includes("liabilit")) totalLiabilities = val;
            else if (title.includes("equity")) totalEquity = val;
          }
        }
      }
    }

    return { totalAssets, totalLiabilities, totalEquity };
  }, [report]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold" data-testid="text-bs-title">Balance Sheet</h2>
        <Button variant="ghost" size="icon" onClick={() => refetch()} data-testid="button-refresh-bs">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : summaryNumbers ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <DollarSign className="h-4 w-4 text-blue-500" />
                  Total Assets
                </div>
                <p className="text-2xl font-bold" data-testid="text-total-assets">{formatCurrency(summaryNumbers.totalAssets)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <Minus className="h-4 w-4 text-red-500" />
                  Total Liabilities
                </div>
                <p className="text-2xl font-bold" data-testid="text-total-liabilities">{formatCurrency(summaryNumbers.totalLiabilities)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <Building2 className="h-4 w-4 text-green-500" />
                  Total Equity
                </div>
                <p className="text-2xl font-bold" data-testid="text-total-equity">{formatCurrency(summaryNumbers.totalEquity)}</p>
              </CardContent>
            </Card>
          </div>

          {report && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {report.Rows.map((section, si) => {
                      if (section.RowType === "Header") {
                        return (
                          <TableRow key={si} className="bg-muted/50">
                            {section.Cells?.map((cell, ci) => (
                              <TableHead key={ci} className={ci > 0 ? "text-right" : ""}>
                                {cell.Value}
                              </TableHead>
                            ))}
                          </TableRow>
                        );
                      }
                      if (section.RowType === "Section") {
                        return (
                          <>{section.Title && (
                            <TableRow key={`title-${si}`} className="bg-muted/30">
                              <TableCell colSpan={10} className="font-semibold text-sm py-2">
                                {section.Title}
                              </TableCell>
                            </TableRow>
                          )}
                          {section.Rows?.map((row, ri) => (
                            <TableRow key={`${si}-${ri}`} className={row.RowType === "SummaryRow" ? "font-semibold bg-muted/20" : ""}>
                              {row.Cells?.map((cell, ci) => (
                                <TableCell key={ci} className={`py-1.5 text-sm ${ci > 0 ? "text-right" : ""}`}>
                                  {cell.Value}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                          </>
                        );
                      }
                      return null;
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No balance sheet data available.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("pnl");

  const { data: xeroStatus, isLoading: statusLoading } = useQuery<XeroStatus>({
    queryKey: ["/api/auth/xero/status"],
  });

  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = () => {
    setIsConnecting(true);
    window.location.href = "/api/auth/xero/connect";
  };

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/xero/disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/xero/status"] });
      toast({ title: "Xero disconnected" });
    },
  });

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("xero") === "connected") {
    window.history.replaceState({}, "", "/analytics");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/xero/status"] });
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-analytics-title">Analytics</h1>
        <p className="text-sm text-muted-foreground">Financial insights from your Xero accounting data</p>
      </div>

      {statusLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <XeroConnectCard
            status={xeroStatus}
            onConnect={handleConnect}
            onDisconnect={() => disconnectMutation.mutate()}
            isConnecting={isConnecting}
          />

          {xeroStatus?.connected && (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList data-testid="tabs-analytics">
                <TabsTrigger value="pnl" data-testid="tab-pnl">
                  <TrendingUp className="h-4 w-4 mr-1.5" />
                  Profit & Loss
                </TabsTrigger>
                <TabsTrigger value="invoices" data-testid="tab-invoices">
                  <FileText className="h-4 w-4 mr-1.5" />
                  Invoices
                </TabsTrigger>
                <TabsTrigger value="balance" data-testid="tab-balance">
                  <DollarSign className="h-4 w-4 mr-1.5" />
                  Balance Sheet
                </TabsTrigger>
              </TabsList>

              <TabsContent value="pnl" className="mt-4">
                <ProfitLossSection />
              </TabsContent>

              <TabsContent value="invoices" className="mt-4">
                <InvoicesSection />
              </TabsContent>

              <TabsContent value="balance" className="mt-4">
                <BalanceSheetSection />
              </TabsContent>
            </Tabs>
          )}
        </>
      )}
    </div>
  );
}
