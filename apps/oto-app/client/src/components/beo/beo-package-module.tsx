import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Package,
  Plus,
  Trash2,
  Loader2,
  Music,
  Sparkles,
  Check,
  RefreshCw,
} from "lucide-react";

interface BeoPackageModuleProps {
  eventId: string;
  readOnly?: boolean;
  section?: "package" | "entertainment" | "all";
}

interface PackageTemplate {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  includedSummary: string | null;
  excludedSummary: string | null;
  isActive: boolean;
  updatedAt: string;
}

interface SnapshotItem {
  id: string;
  snapshotId: string;
  category: string | null;
  label: string;
  description: string | null;
  qty: number;
  unitLabel: string | null;
  included: boolean;
  unitPrice: number;
  billable: boolean;
  notes: string | null;
  sortOrder: number;
}

interface PackageSnapshot {
  id: string;
  eventId: string;
  templateId: string | null;
  templateUpdatedAtAtApply: string | null;
  packageName: string;
  basePrice: number;
  includedSummary: string | null;
  excludedSummary: string | null;
  items: SnapshotItem[];
}

interface EntertainmentTemplate {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number | null;
  defaultPrice: number;
  billableByDefault: boolean;
  isActive: boolean;
}

interface EntertainmentSelection {
  id: string;
  eventId: string;
  templateId: string | null;
  name: string;
  description: string | null;
  durationMinutes: number | null;
  price: number;
  billable: boolean;
  notes: string | null;
}

const formatPrice = (satang: number) =>
  `฿${(satang / 100).toLocaleString("en", { minimumFractionDigits: 2 })}`;

const parsePriceToSatang = (thb: string) =>
  Math.round(parseFloat(thb || "0") * 100);

export function BeoPackageModule({ eventId, readOnly, section = "all" }: BeoPackageModuleProps) {
  const { toast } = useToast();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [showEntertainmentDialog, setShowEntertainmentDialog] = useState(false);
  const [entertainmentTab, setEntertainmentTab] = useState<"template" | "custom">("template");
  const [customEntertainment, setCustomEntertainment] = useState({
    name: "",
    price: "",
    durationMinutes: "",
    notes: "",
  });

  const { data: packageTemplates = [], isLoading: loadingTemplates } = useQuery<PackageTemplate[]>({
    queryKey: ["/api/beo/birthday-packages"],
  });

  const { data: snapshot, isLoading: loadingSnapshot } = useQuery<PackageSnapshot | null>({
    queryKey: ["/api/beo/events", eventId, "package-snapshot"],
  });

  const { data: entertainmentTemplates = [] } = useQuery<EntertainmentTemplate[]>({
    queryKey: ["/api/beo/entertainment-templates"],
  });

  const { data: entertainmentSelections = [], isLoading: loadingEntertainment } = useQuery<EntertainmentSelection[]>({
    queryKey: ["/api/beo/events", eventId, "entertainment-selections"],
  });

  const applyPackageMutation = useMutation({
    mutationFn: (templateId: string) =>
      apiRequest("POST", `/api/beo/events/${eventId}/package-snapshot`, { templateId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "package-snapshot"] });
      setSelectedTemplateId("");
      toast({ title: "Package applied" });
    },
    onError: () => toast({ title: "Failed to apply package", variant: "destructive" }),
  });

  const removePackageMutation = useMutation({
    mutationFn: () =>
      apiRequest("DELETE", `/api/beo/events/${eventId}/package-snapshot`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "package-snapshot"] });
      toast({ title: "Package removed" });
    },
    onError: () => toast({ title: "Failed to remove package", variant: "destructive" }),
  });

  const updateSnapshotItemMutation = useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/beo/events/${eventId}/package-snapshot/items/${itemId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "package-snapshot"] });
    },
    onError: () => toast({ title: "Failed to update item", variant: "destructive" }),
  });

  const addEntertainmentMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", `/api/beo/events/${eventId}/entertainment-selections`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "entertainment-selections"] });
      setShowEntertainmentDialog(false);
      setCustomEntertainment({ name: "", price: "", durationMinutes: "", notes: "" });
      toast({ title: "Entertainment added" });
    },
    onError: () => toast({ title: "Failed to add entertainment", variant: "destructive" }),
  });

  const updateEntertainmentMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/beo/events/${eventId}/entertainment-selections/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "entertainment-selections"] });
    },
    onError: () => toast({ title: "Failed to update entertainment", variant: "destructive" }),
  });

  const deleteEntertainmentMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/beo/events/${eventId}/entertainment-selections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/events", eventId, "entertainment-selections"] });
      toast({ title: "Entertainment removed" });
    },
    onError: () => toast({ title: "Failed to remove entertainment", variant: "destructive" }),
  });

  const includedItems = useMemo(() =>
    (snapshot?.items || []).filter((item) => item.included),
    [snapshot]
  );

  const addonItems = useMemo(() =>
    (snapshot?.items || []).filter((item) => !item.included),
    [snapshot]
  );

  const includedTotal = useMemo(() =>
    includedItems.reduce((sum, item) => sum + item.qty * item.unitPrice, 0),
    [includedItems]
  );

  const addonTotal = useMemo(() =>
    addonItems
      .filter((item) => item.billable)
      .reduce((sum, item) => sum + item.qty * item.unitPrice, 0),
    [addonItems]
  );

  const packageTotal = useMemo(() => {
    if (!snapshot?.items) return 0;
    return snapshot.items
      .filter((item) => item.billable)
      .reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  }, [snapshot]);

  const entertainmentTotal = useMemo(() => {
    return entertainmentSelections
      .filter((s) => s.billable)
      .reduce((sum, s) => sum + s.price, 0);
  }, [entertainmentSelections]);

  const grandTotal = packageTotal + entertainmentTotal;

  const activeTemplates = packageTemplates.filter((t) => t.isActive);
  const activeEntTemplates = entertainmentTemplates.filter((t) => t.isActive);

  const templateUpdateAvailable = useMemo(() => {
    if (!snapshot?.templateId || !snapshot?.templateUpdatedAtAtApply) return false;
    const sourceTemplate = packageTemplates.find((t) => t.id === snapshot.templateId);
    if (!sourceTemplate) return false;
    return new Date(sourceTemplate.updatedAt) > new Date(snapshot.templateUpdatedAtAtApply);
  }, [snapshot, packageTemplates]);

  if (loadingSnapshot || loadingTemplates) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const packageContent = (
    <div className="space-y-4">
      {!snapshot ? (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm text-muted-foreground" data-testid="text-no-package">
              No package selected
            </p>
            {!readOnly && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Label className="text-xs">Choose a package</Label>
                  <Select
                    value={selectedTemplateId}
                    onValueChange={setSelectedTemplateId}
                  >
                    <SelectTrigger data-testid="select-package-template">
                      <SelectValue placeholder="Select package..." />
                    </SelectTrigger>
                    <SelectContent>
                      {activeTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id} data-testid={`select-package-${t.id}`}>
                          {t.name} — {formatPrice(t.basePrice)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={() => {
                    if (selectedTemplateId) applyPackageMutation.mutate(selectedTemplateId);
                  }}
                  disabled={!selectedTemplateId || applyPackageMutation.isPending}
                  data-testid="button-apply-package"
                >
                  {applyPackageMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Apply Package
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm" data-testid="text-package-name">
                {snapshot.packageName}
              </span>
              <Badge variant="secondary" data-testid="badge-package-applied">
                <Check className="h-3 w-3 mr-1" /> Applied
              </Badge>
              {templateUpdateAvailable && (
                <Badge variant="outline" className="text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-600" data-testid="badge-template-update-available">
                  <RefreshCw className="h-3 w-3 mr-1" /> Update Available
                </Badge>
              )}
            </div>
            {!readOnly && (
              <div className="flex items-center gap-2">
                <Select
                  value=""
                  onValueChange={(templateId) => {
                    if (templateId) applyPackageMutation.mutate(templateId);
                  }}
                >
                  <SelectTrigger className="w-auto" data-testid="select-change-package">
                    <SelectValue placeholder="Change Package" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id} data-testid={`select-change-pkg-${t.id}`}>
                        {t.name} — {formatPrice(t.basePrice)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {templateUpdateAvailable && snapshot.templateId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => applyPackageMutation.mutate(snapshot.templateId!)}
                    disabled={applyPackageMutation.isPending}
                    data-testid="button-reapply-package"
                    className="text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-600"
                  >
                    {applyPackageMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1" />
                    )}
                    Re-apply
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => removePackageMutation.mutate()}
                  disabled={removePackageMutation.isPending}
                  data-testid="button-remove-package"
                >
                  {removePackageMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
          </div>

          {snapshot.items.length > 0 && (
            <div className="space-y-4">
              {includedItems.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Package Breakdown</span>
                    <Badge variant="secondary" className="text-[10px]">{includedItems.length} items</Badge>
                  </div>
                  {includedItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col gap-1 p-2 rounded-md bg-muted/30"
                      data-testid={`snapshot-item-${item.id}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {item.category && (
                          <Badge variant="outline" className="text-[10px]" data-testid={`badge-category-${item.id}`}>
                            {item.category}
                          </Badge>
                        )}
                        <span className="text-sm font-medium flex-1" data-testid={`text-item-label-${item.id}`}>
                          {item.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Qty</Label>
                          <Input
                            type="number"
                            min={0}
                            value={item.qty}
                            onChange={(e) => {
                              if (readOnly) return;
                              const qty = parseInt(e.target.value) || 0;
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { qty } });
                            }}
                            className="w-16 h-7 text-xs"
                            disabled={readOnly}
                            data-testid={`input-qty-${item.id}`}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Price</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={(item.unitPrice / 100).toFixed(2)}
                            onChange={(e) => {
                              if (readOnly) return;
                              const unitPrice = parsePriceToSatang(e.target.value);
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { unitPrice } });
                            }}
                            className="w-24 h-7 text-xs"
                            disabled={readOnly}
                            data-testid={`input-price-${item.id}`}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Billable</Label>
                          <Switch
                            checked={item.billable}
                            onCheckedChange={(billable) => {
                              if (readOnly) return;
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { billable } });
                            }}
                            disabled={readOnly}
                            data-testid={`switch-billable-${item.id}`}
                          />
                        </div>
                      </div>
                      <Input
                        placeholder="Notes..."
                        value={item.notes || ""}
                        onChange={(e) => {
                          if (readOnly) return;
                          updateSnapshotItemMutation.mutate({ itemId: item.id, data: { notes: e.target.value } });
                        }}
                        className="h-7 text-xs"
                        disabled={readOnly}
                        data-testid={`input-notes-${item.id}`}
                      />
                    </div>
                  ))}
                  <div className="flex justify-end pt-1">
                    <span className="text-xs text-muted-foreground" data-testid="text-included-subtotal">
                      Subtotal: {formatPrice(includedTotal)}
                    </span>
                  </div>
                </div>
              )}

              {addonItems.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add-ons</span>
                    <Badge variant="secondary" className="text-[10px]">{addonItems.length} items</Badge>
                  </div>
                  {addonItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col gap-1 p-2 rounded-md bg-muted/30"
                      data-testid={`snapshot-item-${item.id}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {item.category && (
                          <Badge variant="outline" className="text-[10px]" data-testid={`badge-category-${item.id}`}>
                            {item.category}
                          </Badge>
                        )}
                        <span className="text-sm font-medium flex-1" data-testid={`text-item-label-${item.id}`}>
                          {item.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Qty</Label>
                          <Input
                            type="number"
                            min={0}
                            value={item.qty}
                            onChange={(e) => {
                              if (readOnly) return;
                              const qty = parseInt(e.target.value) || 0;
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { qty } });
                            }}
                            className="w-16 h-7 text-xs"
                            disabled={readOnly}
                            data-testid={`input-qty-${item.id}`}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Price</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={(item.unitPrice / 100).toFixed(2)}
                            onChange={(e) => {
                              if (readOnly) return;
                              const unitPrice = parsePriceToSatang(e.target.value);
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { unitPrice } });
                            }}
                            className="w-24 h-7 text-xs"
                            disabled={readOnly}
                            data-testid={`input-price-${item.id}`}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">Billable</Label>
                          <Switch
                            checked={item.billable}
                            onCheckedChange={(billable) => {
                              if (readOnly) return;
                              updateSnapshotItemMutation.mutate({ itemId: item.id, data: { billable } });
                            }}
                            disabled={readOnly}
                            data-testid={`switch-billable-${item.id}`}
                          />
                        </div>
                      </div>
                      <Input
                        placeholder="Notes..."
                        value={item.notes || ""}
                        onChange={(e) => {
                          if (readOnly) return;
                          updateSnapshotItemMutation.mutate({ itemId: item.id, data: { notes: e.target.value } });
                        }}
                        className="h-7 text-xs"
                        disabled={readOnly}
                        data-testid={`input-notes-${item.id}`}
                      />
                    </div>
                  ))}
                  <div className="flex justify-end pt-1">
                    <span className="text-xs text-muted-foreground" data-testid="text-addon-subtotal">
                      Add-ons Subtotal: {formatPrice(addonTotal)}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2 border-t">
                <span className="text-sm font-medium" data-testid="text-package-total">
                  Package Total: {formatPrice(packageTotal)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const entertainmentContent = (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Badge variant="secondary" className="text-xs" data-testid="badge-entertainment-count">
          {entertainmentSelections.length}
        </Badge>
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowEntertainmentDialog(true)}
            data-testid="button-add-entertainment"
          >
            <Plus className="h-4 w-4 mr-1" /> Add Entertainment
          </Button>
        )}
      </div>

      {loadingEntertainment ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : entertainmentSelections.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2" data-testid="text-no-entertainment">
          No entertainment add-ons yet
        </p>
      ) : (
        <div className="space-y-2">
          {entertainmentSelections.map((sel) => (
            <div
              key={sel.id}
              className="border rounded-md p-3 space-y-2"
              data-testid={`entertainment-item-${sel.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                  <span className="text-sm font-medium truncate" data-testid={`text-ent-name-${sel.id}`}>
                    {sel.name}
                  </span>
                  {sel.durationMinutes != null && (
                    <Badge variant="outline" className="text-[10px] shrink-0" data-testid={`text-ent-duration-${sel.id}`}>
                      {sel.durationMinutes} min
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-medium" data-testid={`text-ent-price-display-${sel.id}`}>
                    {formatPrice(sel.price)}
                  </span>
                  {!readOnly && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteEntertainmentMutation.mutate(sel.id)}
                      disabled={deleteEntertainmentMutation.isPending}
                      data-testid={`button-delete-ent-${sel.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Price (THB)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={(sel.price / 100).toFixed(2)}
                    onChange={(e) => {
                      if (readOnly) return;
                      const price = parsePriceToSatang(e.target.value);
                      updateEntertainmentMutation.mutate({ id: sel.id, data: { price } });
                    }}
                    className="h-8 text-xs"
                    disabled={readOnly}
                    data-testid={`input-ent-price-${sel.id}`}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Notes</Label>
                  <Input
                    placeholder="Optional notes..."
                    value={sel.notes || ""}
                    onChange={(e) => {
                      if (readOnly) return;
                      updateEntertainmentMutation.mutate({ id: sel.id, data: { notes: e.target.value } });
                    }}
                    className="h-8 text-xs"
                    disabled={readOnly}
                    data-testid={`input-ent-notes-${sel.id}`}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={sel.billable}
                  onCheckedChange={(billable) => {
                    if (readOnly) return;
                    updateEntertainmentMutation.mutate({ id: sel.id, data: { billable } });
                  }}
                  disabled={readOnly}
                  data-testid={`switch-ent-billable-${sel.id}`}
                />
                <Label className="text-xs text-muted-foreground">Billable</Label>
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-2">
            <span className="text-sm font-medium" data-testid="text-entertainment-total">
              Entertainment Total: {formatPrice(entertainmentTotal)}
            </span>
          </div>
        </div>
      )}

      <Dialog open={showEntertainmentDialog} onOpenChange={setShowEntertainmentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Entertainment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={entertainmentTab === "template" ? "default" : "outline"}
                onClick={() => setEntertainmentTab("template")}
                data-testid="button-ent-tab-template"
              >
                From Templates
              </Button>
              <Button
                size="sm"
                variant={entertainmentTab === "custom" ? "default" : "outline"}
                onClick={() => setEntertainmentTab("custom")}
                data-testid="button-ent-tab-custom"
              >
                Custom Entry
              </Button>
            </div>

            {entertainmentTab === "template" ? (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {activeEntTemplates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No entertainment templates available</p>
                ) : (
                  activeEntTemplates.map((t) => (
                    <button
                      key={t.id}
                      className="w-full text-left p-3 rounded-md border hover-elevate flex items-center justify-between gap-2"
                      onClick={() => {
                        addEntertainmentMutation.mutate({ templateId: t.id });
                      }}
                      disabled={addEntertainmentMutation.isPending}
                      data-testid={`button-add-ent-template-${t.id}`}
                    >
                      <div>
                        <div className="text-sm font-medium">{t.name}</div>
                        {t.description && (
                          <div className="text-xs text-muted-foreground">{t.description}</div>
                        )}
                        {t.durationMinutes != null && (
                          <div className="text-xs text-muted-foreground">{t.durationMinutes} min</div>
                        )}
                      </div>
                      <span className="text-sm font-medium whitespace-nowrap">
                        {formatPrice(t.defaultPrice)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={customEntertainment.name}
                    onChange={(e) => setCustomEntertainment((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Entertainment name"
                    data-testid="input-custom-ent-name"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Label className="text-xs">Price (THB)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={customEntertainment.price}
                      onChange={(e) => setCustomEntertainment((prev) => ({ ...prev, price: e.target.value }))}
                      placeholder="0.00"
                      data-testid="input-custom-ent-price"
                    />
                  </div>
                  <div className="flex-1">
                    <Label className="text-xs">Duration (min)</Label>
                    <Input
                      type="number"
                      value={customEntertainment.durationMinutes}
                      onChange={(e) => setCustomEntertainment((prev) => ({ ...prev, durationMinutes: e.target.value }))}
                      placeholder="30"
                      data-testid="input-custom-ent-duration"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Notes</Label>
                  <Input
                    value={customEntertainment.notes}
                    onChange={(e) => setCustomEntertainment((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Optional notes"
                    data-testid="input-custom-ent-notes"
                  />
                </div>
              </div>
            )}
          </div>
          {entertainmentTab === "custom" && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowEntertainmentDialog(false)}
                data-testid="button-cancel-ent"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!customEntertainment.name.trim()) {
                    toast({ title: "Name is required", variant: "destructive" });
                    return;
                  }
                  addEntertainmentMutation.mutate({
                    name: customEntertainment.name.trim(),
                    price: parsePriceToSatang(customEntertainment.price),
                    durationMinutes: customEntertainment.durationMinutes
                      ? parseInt(customEntertainment.durationMinutes)
                      : null,
                    notes: customEntertainment.notes || null,
                    billable: true,
                  });
                }}
                disabled={addEntertainmentMutation.isPending}
                data-testid="button-save-custom-ent"
              >
                {addEntertainmentMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Add
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );

  if (section === "package") return packageContent;
  if (section === "entertainment") return entertainmentContent;

  return (
    <div className="space-y-6">
      {packageContent}
      <Separator />
      {entertainmentContent}
    </div>
  );
}
