import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Gift, Calendar, Hash, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { format } from "date-fns";

interface VoucherWithTemplate {
  id: string;
  token: string;
  remainingUses: number;
  status: string;
  assignedAt: string;
  lastRedeemedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  customImageUrl: string | null;
  notes: string | null;
  imageUrl: string | null;
  name: string;
  template: {
    id: string;
    name: string;
    imageUrl: string;
    description: string | null;
  } | null;
}

export default function VouchersPage() {
  const [selectedVoucher, setSelectedVoucher] = useState<VoucherWithTemplate | null>(null);

  const { data: vouchers = [], isLoading, error } = useQuery<VoucherWithTemplate[]>({
    queryKey: ["/api/core/my-vouchers"],
  });

  const activeVouchers = vouchers.filter((v) => v.status === "active" && v.remainingUses > 0);
  const usedVouchers = vouchers.filter((v) => v.status !== "active" || v.remainingUses === 0);

  if (error) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-4">
        <Gift className="h-12 w-12 text-destructive mb-4" />
        <p className="text-destructive font-medium">Failed to load vouchers</p>
        <p className="text-sm text-muted-foreground">Please try again later</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold">My Vouchers</h1>
          <p className="text-sm text-muted-foreground">Tap a voucher to show the QR code</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : vouchers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Gift className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="font-medium">No vouchers available</p>
                <p className="text-sm">You don't have any active vouchers right now</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {activeVouchers.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground mb-3">ACTIVE</h2>
                  <div className="space-y-3">
                    {activeVouchers.map((voucher) => (
                      <Card
                        key={voucher.id}
                        className="overflow-hidden cursor-pointer hover-elevate active-elevate-2"
                        onClick={() => setSelectedVoucher(voucher)}
                        data-testid={`card-voucher-${voucher.id}`}
                      >
                        <CardContent className="p-0">
                          <div className="flex">
                            {voucher.imageUrl ? (
                              <img
                                src={voucher.imageUrl}
                                alt={voucher.name}
                                className="w-24 h-24 object-cover flex-shrink-0"
                              />
                            ) : (
                              <div className="w-24 h-24 bg-muted flex items-center justify-center flex-shrink-0">
                                <Gift className="h-8 w-8 text-muted-foreground" />
                              </div>
                            )}
                            <div className="flex-1 p-3 min-w-0">
                              <h3 className="font-semibold truncate">{voucher.name}</h3>
                              {voucher.template?.description && (
                                <p className="text-sm text-muted-foreground line-clamp-1">
                                  {voucher.template.description}
                                </p>
                              )}
                              <div className="flex flex-wrap items-center gap-2 mt-2">
                                <Badge variant="secondary" className="gap-1">
                                  <Hash className="h-3 w-3" />
                                  {voucher.remainingUses} left
                                </Badge>
                                {voucher.validTo && (
                                  <Badge variant="outline" className="gap-1">
                                    <Calendar className="h-3 w-3" />
                                    {format(new Date(voucher.validTo), "d MMM")}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {usedVouchers.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground mb-3">USED / EXPIRED</h2>
                  <div className="space-y-3">
                    {usedVouchers.map((voucher) => (
                      <Card key={voucher.id} className="opacity-60" data-testid={`card-voucher-used-${voucher.id}`}>
                        <CardContent className="p-4">
                          <div className="flex gap-4 items-center">
                            {voucher.imageUrl ? (
                              <img
                                src={voucher.imageUrl}
                                alt={voucher.name}
                                className="w-12 h-12 rounded-md object-cover flex-shrink-0 grayscale"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                                <Gift className="h-5 w-5 text-muted-foreground" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <h3 className="font-medium truncate">{voucher.name}</h3>
                            </div>
                            <Badge variant="secondary">{voucher.status}</Badge>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!selectedVoucher} onOpenChange={() => setSelectedVoucher(null)}>
        <DialogContent className="max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="text-center">{selectedVoucher?.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="bg-white p-4 rounded-lg">
              <QRCodeSVG
                value={selectedVoucher?.token || ""}
                size={200}
                level="H"
                includeMargin
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-muted-foreground font-mono break-all select-all">
                {selectedVoucher?.token}
              </p>
              <p className="text-sm text-muted-foreground mt-2">Show this QR code to redeem</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {selectedVoucher?.remainingUses} use{selectedVoucher?.remainingUses !== 1 ? "s" : ""} remaining
              </Badge>
            </div>
            <Button
              variant="outline"
              onClick={() => setSelectedVoucher(null)}
              className="w-full"
              data-testid="button-close-qr"
            >
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
