import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { Gift, Calendar, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { format } from "date-fns";
import type { VoucherTemplate, UserVoucher } from "@shared/schema";

type UserVoucherWithTemplate = UserVoucher & { template: VoucherTemplate };

export default function VouchersPage() {
  const [selectedVoucher, setSelectedVoucher] = useState<UserVoucherWithTemplate | null>(null);

  const { data: vouchers = [], isLoading } = useQuery<UserVoucherWithTemplate[]>({
    queryKey: ["/api/vouchers/my"],
  });

  const getRedeemUrl = (token: string) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/redeem/${token}`;
  };

  const activeVouchers = vouchers.filter(v => v.status === "active");
  const usedVouchers = vouchers.filter(v => v.status !== "active");

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">My Vouchers</h1>
          <p className="text-sm text-muted-foreground">Rewards and benefits assigned to you</p>
        </div>

        {vouchers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Gift className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="font-medium">No vouchers yet</p>
              <p className="text-sm">Check back later for rewards</p>
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
                      className="hover-elevate active-elevate-2 cursor-pointer overflow-visible"
                      onClick={() => setSelectedVoucher(voucher)}
                      data-testid={`card-voucher-${voucher.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex gap-4">
                          {voucher.template.imageUrl ? (
                            <img
                              src={voucher.template.imageUrl}
                              alt={voucher.template.name}
                              className="w-16 h-16 rounded-md object-cover flex-shrink-0"
                            />
                          ) : (
                            <div className="w-16 h-16 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                              <Gift className="h-6 w-6 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold">{voucher.template.name}</h3>
                            {voucher.template.description && (
                              <p className="text-sm text-muted-foreground line-clamp-2">{voucher.template.description}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              <Badge variant="default">
                                {voucher.remainingUses} use{voucher.remainingUses > 1 ? "s" : ""} left
                              </Badge>
                              {(voucher.validToOverride || voucher.template.validTo) && (
                                <Badge variant="outline" className="gap-1">
                                  <Calendar className="h-3 w-3" />
                                  Until {format(new Date(voucher.validToOverride || voucher.template.validTo!), "MMM d")}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <QrCode className="h-5 w-5 text-muted-foreground flex-shrink-0" />
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
                          {voucher.template.imageUrl ? (
                            <img
                              src={voucher.template.imageUrl}
                              alt={voucher.template.name}
                              className="w-12 h-12 rounded-md object-cover flex-shrink-0 grayscale"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                              <Gift className="h-5 w-5 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium">{voucher.template.name}</h3>
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

      <Dialog open={!!selectedVoucher} onOpenChange={(open) => !open && setSelectedVoucher(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">{selectedVoucher?.template.name}</DialogTitle>
          </DialogHeader>
          
          {selectedVoucher && (
            <div className="space-y-4">
              {selectedVoucher.template.imageUrl && (
                <img
                  src={selectedVoucher.template.imageUrl}
                  alt={selectedVoucher.template.name}
                  className="w-full h-40 rounded-md object-cover"
                />
              )}
              
              {selectedVoucher.template.description && (
                <p className="text-sm text-muted-foreground text-center">{selectedVoucher.template.description}</p>
              )}

              <div className="flex justify-center">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG
                    value={getRedeemUrl(selectedVoucher.token)}
                    size={200}
                    level="H"
                    includeMargin={false}
                  />
                </div>
              </div>

              <div className="text-center space-y-1">
                <p className="text-sm text-muted-foreground">Show this QR code to staff to redeem</p>
                <Badge variant="default" className="text-sm">
                  {selectedVoucher.remainingUses} / {selectedVoucher.template.maxUses} uses remaining
                </Badge>
              </div>

              {(selectedVoucher.validToOverride || selectedVoucher.template.validTo) && (
                <p className="text-xs text-center text-muted-foreground">
                  Valid until {format(new Date(selectedVoucher.validToOverride || selectedVoucher.template.validTo!), "MMMM d, yyyy")}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
