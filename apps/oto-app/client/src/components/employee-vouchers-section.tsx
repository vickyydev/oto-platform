import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Gift, ChevronDown, Plus, Hash, Calendar, Trash2, Image } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ObjectUploader } from "@/components/ObjectUploader";
import { format } from "date-fns";
import type { VoucherTemplate, UserVoucher } from "@shared/schema";

interface VoucherWithTemplate extends UserVoucher {
  template: VoucherTemplate | null;
}

interface EmployeeVouchersSectionProps {
  employeeId: string;
}

export function EmployeeVouchersSection({ employeeId }: EmployeeVouchersSectionProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [remainingUses, setRemainingUses] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [customImageUrl, setCustomImageUrl] = useState("");
  const [showImageUpload, setShowImageUpload] = useState(false);

  const { data: vouchers = [], isLoading, error } = useQuery<VoucherWithTemplate[]>({
    queryKey: ["/api/hr/employees", employeeId, "vouchers"],
    queryFn: async () => {
      const res = await fetch(`/api/hr/employees/${employeeId}/vouchers`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load vouchers");
      }
      return res.json();
    },
    enabled: isOpen,
  });

  const { data: templates = [] } = useQuery<VoucherTemplate[]>({
    queryKey: ["/api/studio/voucher-templates"],
    enabled: assignDialogOpen,
  });

  const assignMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/hr/employees/${employeeId}/vouchers`, {
        templateId: selectedTemplateId,
        remainingUses: remainingUses || undefined,
        customImageUrl: customImageUrl || null,
        notes: notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hr/employees", employeeId, "vouchers"] });
      toast({ title: "Voucher assigned" });
      setAssignDialogOpen(false);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to assign voucher", variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (voucherId: string) => {
      await apiRequest("DELETE", `/api/hr/vouchers/${voucherId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hr/employees", employeeId, "vouchers"] });
      toast({ title: "Voucher revoked" });
    },
    onError: () => {
      toast({ title: "Failed to revoke voucher", variant: "destructive" });
    },
  });

  const resetForm = () => {
    setSelectedTemplateId("");
    setRemainingUses("");
    setNotes("");
    setCustomImageUrl("");
    setShowImageUpload(false);
  };

  const handleAssign = () => {
    if (!selectedTemplateId) {
      toast({ title: "Select a template", variant: "destructive" });
      return;
    }
    assignMutation.mutate();
  };

  async function handleGetUploadParameters(file: { name: string; type?: string | null }) {
    const response = await fetch("/api/object-storage/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        isPublic: true,
      }),
    });
    const data = await response.json();
    return {
      method: "PUT" as const,
      url: data.uploadUrl as string,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    };
  }

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const activeVouchers = vouchers.filter((v) => v.status === "active");
  const usedVouchers = vouchers.filter((v) => v.status !== "active");

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="mt-6 border-l-4 border-l-rose-500 bg-rose-500/5">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate rounded-t-lg">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Gift className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-lg">Vouchers</CardTitle>
                  <CardDescription>Reward vouchers assigned to this employee</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeVouchers.length > 0 && (
                  <Badge variant="secondary">{activeVouchers.length} active</Badge>
                )}
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <div className="flex justify-end">
              <Button onClick={() => setAssignDialogOpen(true)} data-testid="button-assign-voucher">
                <Plus className="h-4 w-4 mr-2" />
                Assign Voucher
              </Button>
            </div>

            {isLoading ? (
              <div className="text-center py-4 text-muted-foreground">Loading...</div>
            ) : error ? (
              <div className="text-center py-4 text-destructive">Failed to load vouchers</div>
            ) : vouchers.length === 0 ? (
              <div className="text-center py-8 border rounded-md">
                <Gift className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                <p className="text-muted-foreground">No vouchers assigned</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activeVouchers.map((v) => (
                  <div key={v.id} className="flex items-center gap-3 p-3 border rounded-md" data-testid={`voucher-${v.id}`}>
                    {(v.customImageUrl || v.template?.imageUrl) ? (
                      <img
                        src={v.customImageUrl || v.template?.imageUrl || ""}
                        alt={v.template?.name || "Voucher"}
                        className="w-12 h-12 rounded-md object-cover"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center">
                        <Gift className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{v.template?.name || "Personal Voucher"}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <Badge variant="secondary" className="gap-1">
                          <Hash className="h-3 w-3" />
                          {v.remainingUses} left
                        </Badge>
                        {(v.validToOverride || v.template?.validTo) && (
                          <Badge variant="outline" className="gap-1">
                            <Calendar className="h-3 w-3" />
                            Until {format(new Date(v.validToOverride || v.template?.validTo || ""), "d MMM")}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => revokeMutation.mutate(v.id)}
                      data-testid={`button-revoke-voucher-${v.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}

                {usedVouchers.length > 0 && (
                  <>
                    <p className="text-sm text-muted-foreground font-medium pt-2">Used/Expired</p>
                    {usedVouchers.map((v) => (
                      <div key={v.id} className="flex items-center gap-3 p-3 border rounded-md opacity-60" data-testid={`voucher-${v.id}`}>
                        {(v.customImageUrl || v.template?.imageUrl) ? (
                          <img
                            src={v.customImageUrl || v.template?.imageUrl || ""}
                            alt={v.template?.name || "Voucher"}
                            className="w-12 h-12 rounded-md object-cover grayscale"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center">
                            <Gift className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{v.template?.name || "Personal Voucher"}</p>
                          <Badge variant="outline">{v.status}</Badge>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>

      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Voucher</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Template</Label>
              <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                <SelectTrigger data-testid="select-voucher-template">
                  <SelectValue placeholder="Select a voucher template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.filter((t) => t.isActive).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.maxUses} uses)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedTemplate && (
              <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/50">
                {selectedTemplate.imageUrl ? (
                  <img
                    src={selectedTemplate.imageUrl}
                    alt={selectedTemplate.name}
                    className="w-12 h-12 rounded-md object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center">
                    <Gift className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div>
                  <p className="font-medium">{selectedTemplate.name}</p>
                  <p className="text-sm text-muted-foreground">{selectedTemplate.description || "No description"}</p>
                </div>
              </div>
            )}

            <div>
              <Label>Remaining Uses (optional)</Label>
              <Input
                type="number"
                min={1}
                value={remainingUses}
                onChange={(e) => setRemainingUses(e.target.value ? parseInt(e.target.value) : "")}
                placeholder={selectedTemplate ? `Default: ${selectedTemplate.maxUses}` : "Uses"}
                data-testid="input-remaining-uses"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Personalized Image (optional)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowImageUpload(!showImageUpload)}
                >
                  <Image className="h-4 w-4 mr-1" />
                  {showImageUpload ? "Hide" : "Add"}
                </Button>
              </div>
              {showImageUpload && (
                <ObjectUploader
                  value={customImageUrl}
                  onUploadSuccess={(url) => setCustomImageUrl(url)}
                  getUploadParameters={handleGetUploadParameters}
                  accept="image/*"
                  maxSize={5 * 1024 * 1024}
                  label="Upload personalized image"
                />
              )}
            </div>

            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes about this voucher..."
                data-testid="textarea-voucher-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAssign}
              disabled={assignMutation.isPending || !selectedTemplateId}
              data-testid="button-confirm-assign"
            >
              {assignMutation.isPending ? "Assigning..." : "Assign Voucher"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Collapsible>
  );
}
