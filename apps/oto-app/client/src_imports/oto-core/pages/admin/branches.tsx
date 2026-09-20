import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingScreen, LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowLeft, Building2, Phone, MessageCircle, QrCode, Download, Copy, ExternalLink, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Branch } from "@shared/schema";
import otoLogo from "@assets/IMG_5815_1767489429774-BCpKrIfC_1767700375991.png";

const HR_APP_URL = import.meta.env.VITE_HR_APP_URL || "https://oto-hr.replit.app";

export default function AdminBranchesPage() {
  const { toast } = useToast();
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [qrData, setQrData] = useState<{ qrDataUrl: string; formUrl: string } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const { data: branches, isLoading } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const handleShowQR = async (branch: Branch) => {
    setSelectedBranch(branch);
    setQrDialogOpen(true);
    setQrLoading(true);
    try {
      const res = await fetch(`/api/admin/branches/${branch.id}/qr`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to generate QR code");
      const data = await res.json();
      setQrData(data);
    } catch (error) {
      toast({ title: "Error", description: "Failed to generate QR code", variant: "destructive" });
    } finally {
      setQrLoading(false);
    }
  };

  const handleDownloadQR = () => {
    if (!qrData || !selectedBranch) return;
    const link = document.createElement("a");
    link.download = `qr-${selectedBranch.slug || selectedBranch.id}.png`;
    link.href = qrData.qrDataUrl;
    link.click();
  };

  const handleCopyUrl = () => {
    if (!qrData) return;
    navigator.clipboard.writeText(qrData.formUrl);
    toast({ title: "Copied", description: "Check-in URL copied to clipboard" });
  };

  if (isLoading) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center justify-between max-w-2xl mx-auto">
            <div className="flex items-center gap-3">
              <Link href="/admin">
                <Button size="icon" variant="ghost" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h1 className="text-lg font-semibold">Branches</h1>
            </div>
            <Button
              variant="outline"
              onClick={() => window.open(`${HR_APP_URL}/admin/branches`, "_blank")}
              data-testid="button-open-hr"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Open in HR
            </Button>
          </div>
        </div>

        <div className="px-4 pt-4 max-w-2xl mx-auto w-full">
          <Card className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800">
            <CardContent className="py-3 px-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    Branches are managed by OTO HR
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    To add or edit branches, use the HR app. Changes will sync automatically.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex-1 p-4 pb-8 max-w-2xl mx-auto w-full">
          {!branches || branches.length === 0 ? (
            <EmptyState icon={Building2} title="No branches" description="Branches will appear here once created in OTO HR" />
          ) : (
            <div className="space-y-3">
              {branches.map((branch) => (
                <Card key={branch.id} data-testid={`card-branch-${branch.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <p className="font-semibold mb-2">{branch.name}</p>
                        <div className="space-y-1 text-sm text-muted-foreground">
                          {branch.managerPhone && (
                            <div className="flex items-center gap-2">
                              <Phone className="h-3.5 w-3.5" />
                              <span>{branch.managerPhone}</span>
                            </div>
                          )}
                          {branch.managerWhatsapp && (
                            <div className="flex items-center gap-2">
                              <MessageCircle className="h-3.5 w-3.5" />
                              <span>{branch.managerWhatsapp}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleShowQR(branch)}
                        data-testid={`button-qr-${branch.id}`}
                      >
                        <QrCode className="h-4 w-4 mr-1" />
                        QR Code
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">{selectedBranch?.name} QR Code</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center space-y-4">
            {qrLoading ? (
              <div className="h-64 flex items-center justify-center">
                <LoadingSpinner />
              </div>
            ) : qrData ? (
              <>
                <div className="bg-white p-4 rounded-lg">
                  <img src={qrData.qrDataUrl} alt="QR Code" className="w-64 h-64" />
                </div>
                <div className="text-center">
                  <img src={otoLogo} alt="OTO" className="h-8 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground break-all">{qrData.formUrl}</p>
                </div>
                <div className="flex gap-2 w-full">
                  <Button onClick={handleDownloadQR} className="flex-1" data-testid="button-download-qr">
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </Button>
                  <Button variant="outline" onClick={handleCopyUrl} className="flex-1" data-testid="button-copy-url">
                    <Copy className="h-4 w-4 mr-1" />
                    Copy URL
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
