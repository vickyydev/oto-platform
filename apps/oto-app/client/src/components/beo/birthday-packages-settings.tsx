import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
  Plus,
  Pencil,
  Trash2,
  ArrowLeft,
  Loader2,
  Copy,
  Package,
} from "lucide-react";

type BirthdayPackageTemplate = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  basePrice: number;
  pricingMode: string | null;
  includedSummary: string | null;
  excludedSummary: string | null;
  tags: string[] | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  lineItems?: PackageLineItemTemplate[];
};

type PackageLineItemTemplate = {
  id: string;
  packageTemplateId: string;
  category: string;
  label: string;
  description: string | null;
  qtyDefault: number;
  qtyEditable: boolean;
  unitLabel: string | null;
  included: boolean;
  defaultUnitPrice: number;
  billableByDefault: boolean;
  sortOrder: number;
  createdAt: Date;
};

type PackageFormData = {
  name: string;
  description: string;
  basePrice: string;
  pricingMode: string;
  tags: string;
};

type LineItemFormData = {
  category: string;
  label: string;
  description: string;
  qtyDefault: number;
  qtyEditable: boolean;
  unitLabel: string;
  included: boolean;
  defaultUnitPrice: string;
  billableByDefault: boolean;
};

const formatPrice = (satang: number) => `${(satang / 100).toFixed(2)}`;
const parsePriceToSatang = (thb: string) => Math.round(parseFloat(thb || "0") * 100);

const LINE_ITEM_CATEGORIES = [
  { value: "play", label: "Play" },
  { value: "food", label: "Food" },
  { value: "setup", label: "Setup" },
  { value: "cake", label: "Cake" },
  { value: "entertainment", label: "Entertainment" },
  { value: "other", label: "Other" },
];

const PRICING_MODES = [
  { value: "fixed", label: "Fixed" },
  { value: "per_guest", label: "Per Guest" },
  { value: "custom", label: "Custom" },
];

const emptyPackageForm: PackageFormData = {
  name: "",
  description: "",
  basePrice: "0",
  pricingMode: "fixed",
  tags: "",
};

const emptyLineItemForm: LineItemFormData = {
  category: "other",
  label: "",
  description: "",
  qtyDefault: 1,
  qtyEditable: false,
  unitLabel: "",
  included: true,
  defaultUnitPrice: "0",
  billableByDefault: false,
};

export function BirthdayPackagesSettings() {
  const { toast } = useToast();
  const [view, setView] = useState<"list" | "builder">("list");
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [packageForm, setPackageForm] = useState<PackageFormData>(emptyPackageForm);
  const [showLineItemForm, setShowLineItemForm] = useState<"included" | "addon" | null>(null);
  const [editingLineItem, setEditingLineItem] = useState<PackageLineItemTemplate | null>(null);
  const [lineItemForm, setLineItemForm] = useState<LineItemFormData>(emptyLineItemForm);

  const { data: packages = [], isLoading: loadingPackages } = useQuery<BirthdayPackageTemplate[]>({
    queryKey: ["/api/beo/birthday-packages"],
  });

  const { data: selectedPackage, isLoading: loadingDetail } = useQuery<BirthdayPackageTemplate>({
    queryKey: ["/api/beo/birthday-packages", editingPackageId],
    enabled: !!editingPackageId,
  });

  const createPackageMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", "/api/beo/birthday-packages", data),
    onSuccess: async (res) => {
      const created = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages"] });
      setEditingPackageId(created.id);
      toast({ title: "Package created" });
    },
    onError: () => toast({ title: "Failed to create package", variant: "destructive" }),
  });

  const updatePackageMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/beo/birthday-packages/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages"] });
      if (editingPackageId) {
        queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages", editingPackageId] });
      }
      toast({ title: "Package updated" });
    },
    onError: () => toast({ title: "Failed to update package", variant: "destructive" }),
  });

  const deletePackageMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/beo/birthday-packages/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages"] });
      toast({ title: "Package archived" });
    },
    onError: () => toast({ title: "Failed to archive package", variant: "destructive" }),
  });

  const duplicatePackageMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/beo/birthday-packages/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages"] });
      toast({ title: "Package duplicated" });
    },
    onError: () => toast({ title: "Failed to duplicate package", variant: "destructive" }),
  });

  const createLineItemMutation = useMutation({
    mutationFn: ({ packageId, data }: { packageId: string; data: Record<string, unknown> }) =>
      apiRequest("POST", `/api/beo/birthday-packages/${packageId}/line-items`, data),
    onSuccess: () => {
      if (editingPackageId) {
        queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages", editingPackageId] });
      }
      setShowLineItemForm(null);
      setEditingLineItem(null);
      setLineItemForm(emptyLineItemForm);
      toast({ title: "Line item added" });
    },
    onError: () => toast({ title: "Failed to add line item", variant: "destructive" }),
  });

  const updateLineItemMutation = useMutation({
    mutationFn: ({ packageId, itemId, data }: { packageId: string; itemId: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/beo/birthday-packages/${packageId}/line-items/${itemId}`, data),
    onSuccess: () => {
      if (editingPackageId) {
        queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages", editingPackageId] });
      }
      setShowLineItemForm(null);
      setEditingLineItem(null);
      setLineItemForm(emptyLineItemForm);
      toast({ title: "Line item updated" });
    },
    onError: () => toast({ title: "Failed to update line item", variant: "destructive" }),
  });

  const deleteLineItemMutation = useMutation({
    mutationFn: ({ packageId, itemId }: { packageId: string; itemId: string }) =>
      apiRequest("DELETE", `/api/beo/birthday-packages/${packageId}/line-items/${itemId}`),
    onSuccess: () => {
      if (editingPackageId) {
        queryClient.invalidateQueries({ queryKey: ["/api/beo/birthday-packages", editingPackageId] });
      }
      toast({ title: "Line item removed" });
    },
    onError: () => toast({ title: "Failed to remove line item", variant: "destructive" }),
  });

  const openBuilder = (pkg?: BirthdayPackageTemplate) => {
    if (pkg) {
      setEditingPackageId(pkg.id);
      setPackageForm({
        name: pkg.name,
        description: pkg.description || "",
        basePrice: formatPrice(pkg.basePrice),
        pricingMode: pkg.pricingMode || "fixed",
        tags: (pkg.tags || []).join(", "),
      });
    } else {
      setEditingPackageId(null);
      setPackageForm(emptyPackageForm);
    }
    setView("builder");
  };

  const closeBuilder = () => {
    setView("list");
    setEditingPackageId(null);
    setPackageForm(emptyPackageForm);
  };

  const handleSavePackage = () => {
    if (!packageForm.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const payload = {
      name: packageForm.name.trim(),
      description: packageForm.description.trim() || null,
      basePrice: parsePriceToSatang(packageForm.basePrice),
      pricingMode: packageForm.pricingMode,
      includedSummary: null,
      excludedSummary: null,
      tags: packageForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    if (editingPackageId) {
      updatePackageMutation.mutate({ id: editingPackageId, data: payload });
    } else {
      createPackageMutation.mutate(payload);
    }
  };

  const openLineItemForm = (item?: PackageLineItemTemplate, defaultIncluded?: boolean) => {
    if (item) {
      setEditingLineItem(item);
      setLineItemForm({
        category: item.category,
        label: item.label,
        description: item.description || "",
        qtyDefault: item.qtyDefault,
        qtyEditable: item.qtyEditable,
        unitLabel: item.unitLabel || "",
        included: item.included,
        defaultUnitPrice: formatPrice(item.defaultUnitPrice),
        billableByDefault: item.billableByDefault,
      });
      setShowLineItemForm(item.included ? "included" : "addon");
    } else {
      setEditingLineItem(null);
      const isIncluded = defaultIncluded !== undefined ? defaultIncluded : true;
      setLineItemForm({
        ...emptyLineItemForm,
        included: isIncluded,
        billableByDefault: !isIncluded,
        qtyEditable: !isIncluded,
      });
      setShowLineItemForm(isIncluded ? "included" : "addon");
    }
  };

  const handleSaveLineItem = () => {
    if (!lineItemForm.label.trim()) {
      toast({ title: "Label is required", variant: "destructive" });
      return;
    }
    if (!editingPackageId) return;

    const payload = {
      category: lineItemForm.category,
      label: lineItemForm.label.trim(),
      description: lineItemForm.description.trim() || null,
      qtyDefault: lineItemForm.qtyDefault,
      qtyEditable: lineItemForm.qtyEditable,
      unitLabel: lineItemForm.unitLabel.trim() || null,
      included: lineItemForm.included,
      defaultUnitPrice: parsePriceToSatang(lineItemForm.defaultUnitPrice),
      billableByDefault: lineItemForm.billableByDefault,
    };

    if (editingLineItem) {
      updateLineItemMutation.mutate({ packageId: editingPackageId, itemId: editingLineItem.id, data: payload });
    } else {
      createLineItemMutation.mutate({ packageId: editingPackageId, data: payload });
    }
  };

  const lineItems = selectedPackage?.lineItems || [];
  const includedItems = useMemo(() => lineItems.filter((i) => i.included), [lineItems]);
  const addonItems = useMemo(() => lineItems.filter((i) => !i.included), [lineItems]);

  const includedTotal = useMemo(() =>
    includedItems.reduce((sum, i) => sum + i.qtyDefault * i.defaultUnitPrice, 0),
    [includedItems]
  );

  const tagsList = packageForm.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const renderInlineLineItemForm = (section: "included" | "addon") => {
    if (showLineItemForm !== section) return null;
    return (
      <div className="border rounded-md p-4 space-y-4 bg-muted/30" data-testid="inline-line-item-form">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Category</Label>
            <Select
              value={lineItemForm.category}
              onValueChange={(v) => setLineItemForm((p) => ({ ...p, category: v }))}
            >
              <SelectTrigger data-testid="select-line-item-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINE_ITEM_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Label <span className="text-destructive">*</span></Label>
            <Input
              value={lineItemForm.label}
              onChange={(e) => setLineItemForm((p) => ({ ...p, label: e.target.value }))}
              placeholder="e.g., Pizza"
              data-testid="input-line-item-label"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Description</Label>
          <Input
            value={lineItemForm.description}
            onChange={(e) => setLineItemForm((p) => ({ ...p, description: e.target.value }))}
            placeholder="Optional description"
            data-testid="input-line-item-description"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Default Qty</Label>
            <Input
              type="number"
              min="0"
              value={lineItemForm.qtyDefault}
              onChange={(e) => setLineItemForm((p) => ({ ...p, qtyDefault: parseInt(e.target.value) || 0 }))}
              data-testid="input-line-item-qty"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit Price (THB)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={lineItemForm.defaultUnitPrice}
              onChange={(e) => setLineItemForm((p) => ({ ...p, defaultUnitPrice: e.target.value }))}
              data-testid="input-line-item-price"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit Label</Label>
            <Input
              value={lineItemForm.unitLabel}
              onChange={(e) => setLineItemForm((p) => ({ ...p, unitLabel: e.target.value }))}
              placeholder="pcs"
              data-testid="input-line-item-unit-label"
            />
          </div>
        </div>
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <Switch
              checked={lineItemForm.qtyEditable}
              onCheckedChange={(v) => setLineItemForm((p) => ({ ...p, qtyEditable: v }))}
              data-testid="switch-line-item-qty-editable"
            />
            <Label className="text-xs">Qty Editable</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={lineItemForm.included}
              onCheckedChange={(v) => setLineItemForm((p) => ({ ...p, included: v }))}
              data-testid="switch-line-item-included"
            />
            <Label className="text-xs">Included</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={lineItemForm.billableByDefault}
              onCheckedChange={(v) => setLineItemForm((p) => ({ ...p, billableByDefault: v }))}
              data-testid="switch-line-item-billable"
            />
            <Label className="text-xs">Billable</Label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setShowLineItemForm(null); setEditingLineItem(null); setLineItemForm(emptyLineItemForm); }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSaveLineItem}
            disabled={createLineItemMutation.isPending || updateLineItemMutation.isPending}
            data-testid="button-save-line-item"
          >
            {(createLineItemMutation.isPending || updateLineItemMutation.isPending) && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            {editingLineItem ? "Update" : "Add"}
          </Button>
        </div>
      </div>
    );
  };

  const renderLineItemRow = (item: PackageLineItemTemplate) => (
    <div
      key={item.id}
      className="flex items-center justify-between gap-4 p-3 border rounded-md"
      data-testid={`line-item-${item.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{item.label}</span>
          <Badge variant="secondary">
            {LINE_ITEM_CATEGORIES.find((c) => c.value === item.category)?.label || item.category}
          </Badge>
          {item.qtyEditable && <Badge variant="outline">Qty editable</Badge>}
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          {item.qtyDefault} {item.unitLabel || "x"} @ THB {formatPrice(item.defaultUnitPrice)}
          {" = "}
          THB {formatPrice(item.qtyDefault * item.defaultUnitPrice)}
        </div>
        {item.description && (
          <p className="text-sm text-muted-foreground mt-1 truncate">{item.description}</p>
        )}
      </div>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openLineItemForm(item)}
          data-testid={`button-edit-line-item-${item.id}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => deleteLineItemMutation.mutate({ packageId: editingPackageId!, itemId: item.id })}
          disabled={deleteLineItemMutation.isPending}
          data-testid={`button-delete-line-item-${item.id}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  if (view === "builder") {
    const basePriceSatang = parsePriceToSatang(packageForm.basePrice);
    const priceDiff = basePriceSatang - includedTotal;

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={closeBuilder} data-testid="button-back-to-list">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold">
            {editingPackageId ? "Edit Package" : "New Package"}
          </h2>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Package Details</CardTitle>
            <CardDescription>Configure the package name, pricing, and descriptions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={packageForm.name}
                onChange={(e) => setPackageForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g., Gold Birthday Package"
                data-testid="input-package-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={packageForm.description}
                onChange={(e) => setPackageForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Brief description of this package"
                data-testid="input-package-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Base Price (THB)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={packageForm.basePrice}
                  onChange={(e) => setPackageForm((p) => ({ ...p, basePrice: e.target.value }))}
                  data-testid="input-package-base-price"
                />
              </div>
              <div className="space-y-2">
                <Label>Pricing Mode</Label>
                <Select
                  value={packageForm.pricingMode}
                  onValueChange={(v) => setPackageForm((p) => ({ ...p, pricingMode: v }))}
                >
                  <SelectTrigger data-testid="select-pricing-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRICING_MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Tags (comma-separated)</Label>
              <Input
                value={packageForm.tags}
                onChange={(e) => setPackageForm((p) => ({ ...p, tags: e.target.value }))}
                placeholder="e.g., premium, popular, weekend"
                data-testid="input-package-tags"
              />
              {tagsList.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {tagsList.map((tag, i) => (
                    <Badge key={i} variant="secondary">{tag}</Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={handleSavePackage}
                disabled={createPackageMutation.isPending || updatePackageMutation.isPending}
                data-testid="button-save-package"
              >
                {(createPackageMutation.isPending || updatePackageMutation.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {editingPackageId ? "Save Changes" : "Create Package"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {editingPackageId && (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle>Package Breakdown</CardTitle>
                  <CardDescription>
                    Items included in the base price. These should add up to the package price.
                  </CardDescription>
                </div>
                <Button onClick={() => openLineItemForm(undefined, true)} data-testid="button-add-included-item">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Item
                </Button>
              </CardHeader>
              <CardContent>
                {loadingDetail ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {includedItems.length === 0 && showLineItemForm !== "included" && (
                      <div className="text-center py-6 text-muted-foreground">
                        No included items yet. Add items that make up the package price.
                      </div>
                    )}
                    {includedItems.map(renderLineItemRow)}
                    {renderInlineLineItemForm("included")}
                    {includedItems.length > 0 && (
                    <div className="flex items-center justify-between pt-3 border-t">
                      <span className="text-sm font-medium">Included Items Total</span>
                      <div className="text-right">
                        <span className="text-sm font-medium" data-testid="text-included-total">
                          THB {formatPrice(includedTotal)}
                        </span>
                        {basePriceSatang > 0 && priceDiff !== 0 && (
                          <p className={`text-xs ${priceDiff > 0 ? "text-amber-600 dark:text-amber-400" : "text-destructive"}`}
                            data-testid="text-price-diff"
                          >
                            {priceDiff > 0
                              ? `THB ${formatPrice(priceDiff)} unallocated`
                              : `THB ${formatPrice(Math.abs(priceDiff))} over base price`}
                          </p>
                        )}
                        {basePriceSatang > 0 && priceDiff === 0 && (
                          <p className="text-xs text-green-600 dark:text-green-400" data-testid="text-price-match">
                            Matches base price
                          </p>
                        )}
                      </div>
                    </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle>Add-on Items</CardTitle>
                  <CardDescription>
                    Extra items not included in the base price (e.g., extra children, upgrades). These will be billed separately.
                  </CardDescription>
                </div>
                <Button onClick={() => openLineItemForm(undefined, false)} data-testid="button-add-addon-item">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Add-on
                </Button>
              </CardHeader>
              <CardContent>
                {loadingDetail ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {addonItems.length === 0 && showLineItemForm !== "addon" && (
                      <div className="text-center py-6 text-muted-foreground">
                        No add-on items yet. Add extras like "Extra Children", "Upgrade Cake", etc.
                      </div>
                    )}
                    {addonItems.map(renderLineItemRow)}
                    {renderInlineLineItemForm("addon")}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Birthday Packages</CardTitle>
          <CardDescription>Create reusable package templates for events</CardDescription>
        </div>
        <Button onClick={() => openBuilder()} data-testid="button-add-package">
          <Plus className="h-4 w-4 mr-2" />
          Add Package
        </Button>
      </CardHeader>
      <CardContent>
        {loadingPackages ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : packages.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No birthday packages configured</p>
            <p className="text-sm">Create your first package template to get started</p>
          </div>
        ) : (
          <div className="space-y-2">
            {packages.map((pkg) => (
              <div
                key={pkg.id}
                className={`flex items-start justify-between gap-4 p-3 border rounded-md ${!pkg.isActive ? "opacity-50" : ""}`}
                data-testid={`package-${pkg.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{pkg.name}</span>
                    <Badge variant="secondary">THB {formatPrice(pkg.basePrice)}</Badge>
                    {!pkg.isActive && <Badge variant="secondary">Inactive</Badge>}
                    {pkg.lineItems && (
                      <Badge variant="outline">{pkg.lineItems.length} items</Badge>
                    )}
                  </div>
                  {pkg.description && (
                    <p className="text-sm text-muted-foreground mt-1 truncate">{pkg.description}</p>
                  )}
                  {pkg.tags && pkg.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {pkg.tags.map((tag, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openBuilder(pkg)}
                    data-testid={`button-edit-package-${pkg.id}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => duplicatePackageMutation.mutate(pkg.id)}
                    disabled={duplicatePackageMutation.isPending}
                    data-testid={`button-duplicate-package-${pkg.id}`}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  {pkg.isActive && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deletePackageMutation.mutate(pkg.id)}
                      disabled={deletePackageMutation.isPending}
                      data-testid={`button-archive-package-${pkg.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
