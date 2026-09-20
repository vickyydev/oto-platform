import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { Gift, Check, X, Calendar, User } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { format } from "date-fns";

interface VoucherDetails {
  id: string;
  templateName: string;
  templateDescription: string | null;
  imageUrl: string;
  userName: string;
  remainingUses: number;
  maxUses: number;
  validFrom: string | null;
  validTo: string | null;
  isValid: boolean;
  reason: string;
}

export default function RedeemPage() {
  const params = useParams<{ token?: string }>();
  const token = params.token || "";
  const { toast } = useToast();
  const { user } = useAuth();
  const [redeemed, setRedeemed] = useState(false);
  const [newRemainingUses, setNewRemainingUses] = useState<number | null>(null);

  const { data: voucher, isLoading, error } = useQuery<VoucherDetails>({
    queryKey: ["/api/redeem", token],
    queryFn: async () => {
      const res = await fetch(`/api/redeem/${token}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Voucher not found");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const redeemMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/redeem/${token}`, {});
      return res.json();
    },
    onSuccess: (data) => {
      setRedeemed(true);
      setNewRemainingUses(data.remainingUses);
      toast({ title: "Voucher redeemed successfully" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to redeem",
        description: error.message || "Could not redeem voucher",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <LoadingScreen />
      </div>
    );
  }

  if (error || !voucher) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-sm w-full">
          <CardContent className="py-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-destructive/10 flex items-center justify-center">
              <X className="h-8 w-8 text-destructive" />
            </div>
            <h1 className="text-xl font-bold mb-2">Voucher Not Found</h1>
            <p className="text-muted-foreground">
              {(error as Error)?.message || "This voucher may have been removed or expired"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <CardContent className="py-6 space-y-6">
          {voucher.imageUrl && (
            <img
              src={voucher.imageUrl}
              alt={voucher.templateName}
              className="w-full h-40 rounded-md object-cover"
            />
          )}

          <div className="text-center">
            <h1 className="text-xl font-bold mb-2">{voucher.templateName}</h1>
            {voucher.templateDescription && (
              <p className="text-sm text-muted-foreground">{voucher.templateDescription}</p>
            )}
          </div>

          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <User className="h-4 w-4" />
            <span className="text-sm">For: <strong>{voucher.userName}</strong></span>
          </div>

          {redeemed ? (
            <div className="text-center space-y-4">
              <div className="w-20 h-20 mx-auto rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Check className="h-10 w-10 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-green-600 dark:text-green-400">Redeemed!</h2>
                <p className="text-sm text-muted-foreground">
                  {newRemainingUses !== null && newRemainingUses > 0
                    ? `${newRemainingUses} use${newRemainingUses > 1 ? "s" : ""} remaining`
                    : "Voucher fully used"}
                </p>
              </div>
            </div>
          ) : voucher.isValid ? (
            <>
              <div className="flex flex-wrap justify-center gap-2">
                <Badge variant="default" className="gap-1">
                  <Gift className="h-3 w-3" />
                  {voucher.remainingUses} / {voucher.maxUses} uses
                </Badge>
                {voucher.validTo && (
                  <Badge variant="outline" className="gap-1">
                    <Calendar className="h-3 w-3" />
                    Until {format(new Date(voucher.validTo), "MMM d, yyyy")}
                  </Badge>
                )}
              </div>

              {user ? (
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => redeemMutation.mutate()}
                  disabled={redeemMutation.isPending}
                  data-testid="button-redeem-voucher"
                >
                  {redeemMutation.isPending ? "Redeeming..." : "Redeem Voucher"}
                </Button>
              ) : (
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">Staff login required to redeem</p>
                  <Button variant="outline" asChild>
                    <a href="/login">Login to Redeem</a>
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                <X className="h-8 w-8 text-destructive" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-destructive">Cannot Redeem</h2>
                <p className="text-sm text-muted-foreground">{voucher.reason}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
