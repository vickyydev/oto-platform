import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { User, Building2, Shield, Gift, Loader2, Link, UserX, Key, Clock, ExternalLink, AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import type { User as UserType, Branch, VoucherTemplate, UserVoucher } from "@shared/schema";
import { format } from "date-fns";

const HR_APP_URL = import.meta.env.VITE_HR_APP_URL || "https://oto-hr.replit.app";

type UserWithBranch = Omit<UserType, 'password'> & { 
  branch?: Branch;
  hrEmployee?: {
    fullName: string;
    preferredName?: string | null;
    employmentState: "ACTIVE" | "LEAVING" | "LEFT";
    homeBranchName: string;
  } | null;
};

const roleColors: Record<string, string> = {
  admin: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  manager: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  staff: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  LEAVING: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  LEFT: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const accessLevelColors: Record<string, string> = {
  ADMIN: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  MANAGER: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  STAFF: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

type UserVoucherWithTemplate = UserVoucher & { template: VoucherTemplate };

export default function StudioUsersPage() {
  const { toast } = useToast();
  const [vouchersDialogOpen, setVouchersDialogOpen] = useState(false);
  const [vouchersUser, setVouchersUser] = useState<UserWithBranch | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [voucherNotes, setVoucherNotes] = useState<string>("");

  const { data: users = [], isLoading: loadingUsers } = useQuery<UserWithBranch[]>({
    queryKey: ["/api/admin/users"],
  });

  const { data: voucherTemplates = [] } = useQuery<VoucherTemplate[]>({
    queryKey: ["/api/studio/voucher-templates"],
  });

  const { data: userVouchers = [], refetch: refetchUserVouchers } = useQuery<UserVoucherWithTemplate[]>({
    queryKey: ["/api/studio/users", vouchersUser?.id, "vouchers"],
    queryFn: async () => {
      if (!vouchersUser) return [];
      const res = await fetch(`/api/studio/users/${vouchersUser.id}/vouchers`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!vouchersUser,
  });

  const assignVoucherMutation = useMutation({
    mutationFn: async ({ userId, templateId, notes }: { userId: string; templateId?: string; notes?: string }) => {
      const res = await apiRequest("POST", `/api/studio/users/${userId}/vouchers`, { templateId, notes });
      return res.json();
    },
    onSuccess: () => {
      refetchUserVouchers();
      toast({ title: "Voucher assigned" });
      setSelectedTemplateId("");
      setVoucherNotes("");
    },
    onError: () => {
      toast({ title: "Failed to assign voucher", variant: "destructive" });
    },
  });

  const revokeVoucherMutation = useMutation({
    mutationFn: async (voucherId: string) => {
      const res = await apiRequest("PATCH", `/api/studio/vouchers/${voucherId}`, { status: "revoked" });
      return res.json();
    },
    onSuccess: () => {
      refetchUserVouchers();
      toast({ title: "Voucher revoked" });
    },
    onError: () => {
      toast({ title: "Failed to revoke voucher", variant: "destructive" });
    },
  });

  const openVouchersDialog = (user: UserWithBranch) => {
    setVouchersUser(user);
    setVouchersDialogOpen(true);
    setSelectedTemplateId("");
    setVoucherNotes("");
  };

  const getHRLink = (user: UserWithBranch) => {
    if (user.hrPersonId) {
      return `${HR_APP_URL}/people/${user.hrPersonId}`;
    }
    return null;
  };

  const getBranchScopeSummary = (user: UserWithBranch) => {
    if (user.branchScope === "ALL") return "All branches";
    if (user.branchIds && user.branchIds.length > 0) {
      return `${user.branchIds.length} branch${user.branchIds.length > 1 ? "es" : ""}`;
    }
    return "No branches";
  };

  return (
    <StudioLayout>
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Users</h1>
            <p className="text-sm text-muted-foreground">Staff directory - read-only view</p>
          </div>
        </div>

        <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <ExternalLink className="h-5 w-5 shrink-0" />
            <div>
              <span className="font-medium">Managed by HR</span>
              <span className="text-sm ml-2">User accounts are created and managed in OTO HR. Use the "Open in HR" link to manage user access.</span>
            </div>
          </div>
        </Card>

        {loadingUsers ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <Card key={i} className="p-4 animate-pulse">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 bg-muted rounded-full" />
                  <div className="flex-1">
                    <div className="h-5 bg-muted rounded w-1/3 mb-2" />
                    <div className="h-4 bg-muted rounded w-1/2" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : users.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            <p>No users found. Users are provisioned from OTO HR.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {users.map((user) => (
              <Card key={user.id} className="p-4" data-testid={`card-user-${user.id}`}>
                <div className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium">{user.name}</h3>
                      <Badge className={accessLevelColors[user.accessLevel || "STAFF"] || accessLevelColors.STAFF}>
                        <Shield className="h-3 w-3 mr-1" />
                        {user.accessLevel || user.role}
                      </Badge>
                      {user.isActive === false && (
                        <Badge variant="outline" className="text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800">
                          <UserX className="h-3 w-3 mr-1" />
                          Disabled
                        </Badge>
                      )}
                      {user.mustChangePassword && (
                        <Badge variant="outline" className="text-xs bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800">
                          <Key className="h-3 w-3 mr-1" />
                          Must Change Password
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                      <span>{user.email}</span>
                      {user.branch && (
                        <span className="flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {user.branch.name}
                        </span>
                      )}
                      <span className="text-xs bg-muted px-2 py-0.5 rounded">
                        {getBranchScopeSummary(user)}
                      </span>
                    </div>
                    
                    {user.hrPersonId ? (
                      <div className="mt-2 p-2 rounded bg-muted/50 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link className="h-3 w-3 text-green-600" />
                          <span className="font-medium">HR Linked:</span>
                          {user.hrEmployee ? (
                            <>
                              <span>{user.hrEmployee.fullName}</span>
                              <Badge className={statusColors[user.hrEmployee.employmentState]}>
                                {user.hrEmployee.employmentState}
                              </Badge>
                              <span className="text-muted-foreground">@ {user.hrEmployee.homeBranchName}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">ID: {user.hrPersonId}</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 p-2 rounded bg-yellow-50 dark:bg-yellow-900/20 text-sm">
                        <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-300">
                          <AlertTriangle className="h-3 w-3" />
                          <span>Not linked to HR</span>
                        </div>
                      </div>
                    )}
                    
                    {user.lastLoginAt && (
                      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Last login: {format(new Date(user.lastLoginAt), "d MMM yyyy h:mm a")}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => openVouchersDialog(user)}
                      title="Manage vouchers"
                      data-testid={`button-vouchers-user-${user.id}`}
                    >
                      <Gift className="h-4 w-4" />
                    </Button>
                    {getHRLink(user) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        asChild
                        data-testid={`button-open-hr-${user.id}`}
                      >
                        <a href={getHRLink(user)!} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-1" />
                          Open in HR
                        </a>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title="User not linked to HR"
                        data-testid={`button-open-hr-disabled-${user.id}`}
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Not linked
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={vouchersDialogOpen} onOpenChange={setVouchersDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Vouchers for {vouchersUser?.name}</DialogTitle>
            <DialogDescription>Assign and manage reward vouchers</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assign New Voucher</Label>
              <div className="flex gap-2">
                <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                  <SelectTrigger className="flex-1" data-testid="select-voucher-template">
                    <SelectValue placeholder="Select voucher type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {voucherTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => {
                    if (vouchersUser && selectedTemplateId) {
                      assignVoucherMutation.mutate({
                        userId: vouchersUser.id,
                        templateId: selectedTemplateId,
                        notes: voucherNotes || undefined,
                      });
                    }
                  }}
                  disabled={!selectedTemplateId || assignVoucherMutation.isPending}
                  data-testid="button-assign-voucher"
                >
                  {assignVoucherMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Assign"}
                </Button>
              </div>
              <Input
                placeholder="Optional note..."
                value={voucherNotes}
                onChange={(e) => setVoucherNotes(e.target.value)}
                data-testid="input-voucher-notes"
              />
            </div>

            <div className="space-y-2">
              <Label>Active Vouchers</Label>
              {userVouchers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active vouchers</p>
              ) : (
                <div className="space-y-2">
                  {userVouchers.filter(v => v.status === "active").map((v) => (
                    <Card key={v.id} className="p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{v.template?.name || "Unknown"}</p>
                          <p className="text-xs text-muted-foreground">
                            Expires: {v.validToOverride ? format(new Date(v.validToOverride), "d MMM yyyy") : "Never"}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => revokeVoucherMutation.mutate(v.id)}
                          disabled={revokeVoucherMutation.isPending}
                          data-testid={`button-revoke-voucher-${v.id}`}
                        >
                          Revoke
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
