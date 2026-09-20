import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { format, parseISO } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Download, Banknote, Calendar } from "lucide-react";

type PayslipSummary = {
  id: string;
  payrollRunId: string;
  employeeId: string;
  grossPay: string;
  taxableIncome: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  currency: string;
  status: string;
  periodStart?: string;
  periodEnd?: string;
  pdfDownloadUrl?: string | null;
};

function formatCurrency(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

export default function MyPayslipsPage() {
  const { user } = useAuth();

  const { data: payslips = [], isLoading } = useQuery<PayslipSummary[]>({
    queryKey: ["/api/payroll/my-payslips"],
  });

  const handleDownload = (url: string) => {
    window.open(url, "_blank");
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My Payslips</h1>
          <p className="text-muted-foreground">View and download your payslips</p>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-8">
            <div className="space-y-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </CardContent>
        </Card>
      ) : payslips.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No payslips available yet</p>
            <p className="text-sm mt-2">Your payslips will appear here after payroll is processed</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {payslips.map((payslip) => (
            <Card key={payslip.id} className="hover-elevate" data-testid={`payslip-card-${payslip.id.slice(0, 8)}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <Banknote className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">
                        {payslip.periodStart
                          ? format(parseISO(payslip.periodStart), "MMMM yyyy")
                          : "Payslip"}
                      </CardTitle>
                      {payslip.periodStart && payslip.periodEnd && (
                        <CardDescription className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {format(parseISO(payslip.periodStart), "dd MMM")} - {format(parseISO(payslip.periodEnd), "dd MMM yyyy")}
                        </CardDescription>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={payslip.status === "FINALIZED" ? "default" : "secondary"}>
                      {payslip.status}
                    </Badge>
                    {payslip.pdfDownloadUrl && (
                      <Button
                        size="sm"
                        onClick={() => handleDownload(payslip.pdfDownloadUrl!)}
                        data-testid={`download-payslip-${payslip.id.slice(0, 8)}`}
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download PDF
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="text-sm text-muted-foreground">Gross Pay</p>
                    <p className="text-lg font-semibold">{formatCurrency(payslip.grossPay)}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="text-sm text-muted-foreground">Deductions</p>
                    <p className="text-lg font-semibold text-destructive">
                      -{formatCurrency(payslip.totalDeductions)}
                    </p>
                  </div>
                  <div className="p-3 bg-primary/10 rounded-lg">
                    <p className="text-sm text-muted-foreground">Net Pay</p>
                    <p className="text-lg font-bold text-primary">{formatCurrency(payslip.netPay)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
