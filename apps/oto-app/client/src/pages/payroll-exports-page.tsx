import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  AlertTriangle,
  Download,
  FileText,
  Building2,
  Calculator,
  CheckCircle,
} from "lucide-react";

interface PayrollRun {
  id: string;
  payrollPeriodId: string;
  runNumber: number;
  status: string;
  totalEmployees: number;
  totalNet: string;
  createdAt: string;
  finalizedAt: string | null;
}

export default function PayrollExportsPage() {
  const { toast } = useToast();
  const [, params] = useRoute("/payroll/runs/:runId/exports");
  const runId = params?.runId;

  const [bankFormat, setBankFormat] = useState("SCB");
  const [journalFormat, setJournalFormat] = useState("CSV");

  const downloadExport = async (kind: string, body: Record<string, string> = {}) => {
    const generated = await fetch(`/api/payroll/runs/${runId}/export/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!generated.ok) throw new Error("Failed to generate export");
    const result = await generated.json();
    if (typeof result.filePath !== "string" || !/^\/api\/payroll\/exports\/(bank-transfers|journals|sso-filings|pit-filings)\/[^/]+\.csv$/.test(result.filePath)) {
      throw new Error("Export file was not returned");
    }
    const downloaded = await fetch(result.filePath);
    if (!downloaded.ok) throw new Error("Failed to download export");
    const url = URL.createObjectURL(await downloaded.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filePath.split("/").pop() || "payroll-export.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const { data: run, isLoading, error } = useQuery<PayrollRun>({
    queryKey: ["/api/payroll/runs", runId],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}`);
      if (!res.ok) throw new Error("Failed to fetch run");
      return res.json();
    },
    enabled: !!runId,
  });

  const bankExportMutation = useMutation({
    mutationFn: (format: string) => downloadExport("bank-transfer", { bankFormat: format }),
    onSuccess: () => {
      toast({ title: "Export generated", description: "Bank transfer file downloaded." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const journalExportMutation = useMutation({
    mutationFn: (format: string) => downloadExport("journal", { format }),
    onSuccess: () => {
      toast({ title: "Export generated", description: "Accounting journal file downloaded." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const ssoExportMutation = useMutation({
    mutationFn: () => downloadExport("sso-filing"),
    onSuccess: () => {
      toast({ title: "Export generated", description: "SSO filing report downloaded." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const pitExportMutation = useMutation({
    mutationFn: () => downloadExport("pit-filing"),
    onSuccess: () => {
      toast({ title: "Export generated", description: "PIT filing report downloaded." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const isFinalized = run?.status === "FINALIZED";

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load run details. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/payroll/runs/${runId}`}>
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Exports</h1>
          <p className="text-muted-foreground">
            Generate and download export files for Run #{run.runNumber}
          </p>
        </div>
      </div>

      {!isFinalized && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            This payroll run is not finalized. Exports may change if the run is recalculated.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Bank Transfer Export
            </CardTitle>
            <CardDescription>
              Generate CSV file for bank salary payments
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={bankFormat} onValueChange={setBankFormat}>
                <SelectTrigger className="w-[180px]" data-testid="select-bank-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SCB">SCB Format</SelectItem>
                  <SelectItem value="KBANK">KBANK Format</SelectItem>
                  <SelectItem value="BBL">BBL Format</SelectItem>
                  <SelectItem value="GENERIC">Generic CSV</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={() => bankExportMutation.mutate(bankFormat)}
                disabled={bankExportMutation.isPending}
                data-testid="button-download-bank"
              >
                <Download className="mr-2 h-4 w-4" />
                {bankExportMutation.isPending ? "Generating..." : "Download"}
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              <p>{run.totalEmployees} employees • Net total: ฿{Number(run.totalNet || 0).toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5" />
              Accounting Journal
            </CardTitle>
            <CardDescription>
              Generate journal entries for accounting software
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={journalFormat} onValueChange={setJournalFormat}>
                <SelectTrigger className="w-[180px]" data-testid="select-journal-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CSV">Generic CSV</SelectItem>
                  <SelectItem value="SAGE">Sage Format</SelectItem>
                  <SelectItem value="QUICKBOOKS">QuickBooks</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={() => journalExportMutation.mutate(journalFormat)}
                disabled={journalExportMutation.isPending}
                data-testid="button-download-journal"
              >
                <Download className="mr-2 h-4 w-4" />
                {journalExportMutation.isPending ? "Generating..." : "Download"}
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              <p>Includes wage expense, SSO payable, tax payable entries</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              SSO Filing Report
            </CardTitle>
            <CardDescription>
              Social Security contribution report for government filing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={() => ssoExportMutation.mutate()}
              disabled={ssoExportMutation.isPending}
              data-testid="button-download-sso"
            >
              <Download className="mr-2 h-4 w-4" />
              {ssoExportMutation.isPending ? "Generating..." : "Download SSO Report"}
            </Button>
            <div className="text-sm text-muted-foreground">
              <p>Employee SSO numbers, wages, and contribution amounts</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              PIT Filing Report
            </CardTitle>
            <CardDescription>
              Personal Income Tax withholding report for government filing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={() => pitExportMutation.mutate()}
              disabled={pitExportMutation.isPending}
              data-testid="button-download-pit"
            >
              <Download className="mr-2 h-4 w-4" />
              {pitExportMutation.isPending ? "Generating..." : "Download PIT Report"}
            </Button>
            <div className="text-sm text-muted-foreground">
              <p>Tax IDs, income, and withholding amounts</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payslips</CardTitle>
          <CardDescription>Generate and download payslips for employees</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isFinalized ? (
            <div className="flex items-center gap-3">
              <Badge variant="default">
                <CheckCircle className="w-3 h-3 mr-1" />
                Payslips Available
              </Badge>
              <Link href={`/payroll/runs/${runId}/employees`}>
                <Button variant="outline" data-testid="button-view-payslips">
                  View Employee Payslips
                </Button>
              </Link>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              <p>Payslips appear here when the run is finalized.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
