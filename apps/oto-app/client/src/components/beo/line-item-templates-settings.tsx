import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Plus, Pencil, Trash2, Loader2, Receipt, Search } from "lucide-react";
import { calculateVatFromInclusive, formatThb } from "@shared/vat-utils";
import type { EventLineItemTemplate } from "@shared/schema";

type TemplateFormData = {
  name: string;
  defaultUnitPriceIncVat: number;
  defaultQty: number;
  category: "ENTERTAINMENT" | "FOOD" | "ADD_ON" | "PACKAGE" | "OTHER";
  isIncludedByDefault: boolean;
  isActive: boolean;
  description: string;
  internalNote: string;
};

const CATEGORIES = [
  { value: "ENTERTAINMENT", label: "Entertainment" },
  { value: "FOOD", label: "Food" },
  { value: "ADD_ON", label: "Add-on" },
  { value: "PACKAGE", label: "Package" },
  { value: "OTHER", label: "Other" },
];

export function LineItemTemplatesSettings() {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<EventLineItemTemplate | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<TemplateFormData>({
    name: "",
    defaultUnitPriceIncVat: 0,
    defaultQty: 1,
    category: "OTHER",
    isIncludedByDefault: false,
    isActive: true,
    description: "",
    internalNote: "",
  });

  const { data: templates = [], isLoading } = useQuery<EventLineItemTemplate[]>({
    queryKey: ["/api/settings/line-item-templates", { includeInactive: showInactive }],
  });

  const createMutation = useMutation({
    mutationFn: (data: TemplateFormData) => apiRequest("POST", "/api/settings/line-item-templates", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/line-item-templates"] });
      setShowDialog(false);
      resetForm();
      toast({ title: "Line item template created" });
    },
    onError: () => toast({ title: "Failed to create template", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<TemplateFormData> }) =>
      apiRequest("PUT", `/api/settings/line-item-templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/line-item-templates"] });
      setShowDialog(false);
      resetForm();
      toast({ title: "Line item template updated" });
    },
    onError: () => toast({ title: "Failed to update template", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/settings/line-item-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/line-item-templates"] });
      toast({ title: "Template deactivated" });
    },
    onError: () => toast({ title: "Failed to deactivate template", variant: "destructive" }),
  });

  const resetForm = () => {
    setForm({
      name: "",
      defaultUnitPriceIncVat: 0,
      defaultQty: 1,
      category: "OTHER",
      isIncludedByDefault: false,
      isActive: true,
      description: "",
      internalNote: "",
    });
    setEditing(null);
  };

  const handleEdit = (template: EventLineItemTemplate) => {
    setEditing(template);
    setForm({
      name: template.name,
      defaultUnitPriceIncVat: template.defaultUnitPriceIncVat,
      defaultQty: template.defaultQty,
      category: template.category as TemplateFormData["category"],
      isIncludedByDefault: template.isIncludedByDefault,
      isActive: template.isActive,
      description: template.description || "",
      internalNote: template.internalNote || "",
    });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (editing) {
      updateMutation.mutate({ id: editing.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const filteredTemplates = templates.filter((t) => {
    if (!showInactive && !t.isActive) return false;
    if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
    if (searchQuery && !t.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const vatBreakdown = calculateVatFromInclusive(form.defaultUnitPriceIncVat);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 justify-between">
        <div className="flex flex-1 gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-templates"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[140px]" data-testid="select-category-filter">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {CATEGORIES.map((cat) => (
                <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 items-center">
          <div className="flex items-center gap-2">
            <Switch
              checked={showInactive}
              onCheckedChange={setShowInactive}
              data-testid="switch-show-inactive"
            />
            <Label className="text-sm">Show inactive</Label>
          </div>
          <Button
            onClick={() => { resetForm(); setShowDialog(true); }}
            data-testid="button-add-template"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredTemplates.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Receipt className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No line item templates found</p>
            <p className="text-sm">Create templates to use in event billing</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredTemplates.map((template) => {
            const vat = calculateVatFromInclusive(template.defaultUnitPriceIncVat);
            return (
              <Card key={template.id} className={!template.isActive ? "opacity-60" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{template.name}</span>
                        <Badge variant="secondary" className="text-xs">
                          {CATEGORIES.find((c) => c.value === template.category)?.label || template.category}
                        </Badge>
                        {template.isIncludedByDefault && (
                          <Badge variant="outline" className="text-xs">Included</Badge>
                        )}
                        {!template.isActive && (
                          <Badge variant="secondary" className="text-xs bg-muted">Inactive</Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        <span className="font-medium">{formatThb(template.defaultUnitPriceIncVat)}</span>
                        <span className="mx-1">×</span>
                        <span>{template.defaultQty}</span>
                        <span className="text-xs ml-2">
                          (Ex VAT: {formatThb(vat.amountExVat)} + VAT: {formatThb(vat.vatAmount)})
                        </span>
                      </div>
                      {template.description && (
                        <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEdit(template)}
                        data-testid={`button-edit-template-${template.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {template.isActive && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteMutation.mutate(template.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-template-${template.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Line Item Template" : "Add Line Item Template"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update template details" : "Create a reusable line item for event billing"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Magic Show, Extra Child"
                data-testid="input-template-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((prev) => ({ ...prev, category: v as TemplateFormData["category"] }))}
              >
                <SelectTrigger data-testid="select-template-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Unit Price (Inc VAT) <span className="text-destructive">*</span></Label>
                <Input
                  type="number"
                  min="0"
                  value={form.defaultUnitPriceIncVat}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultUnitPriceIncVat: parseInt(e.target.value) || 0 }))}
                  data-testid="input-template-price"
                />
              </div>
              <div className="space-y-2">
                <Label>Default Qty</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.defaultQty}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultQty: parseInt(e.target.value) || 1 }))}
                  data-testid="input-template-qty"
                />
              </div>
            </div>
            <div className="bg-muted/50 p-3 rounded-md text-sm space-y-1">
              <p className="font-medium">VAT Breakdown (7%)</p>
              <div className="flex justify-between">
                <span>Price Ex VAT:</span>
                <span>{formatThb(vatBreakdown.amountExVat)}</span>
              </div>
              <div className="flex justify-between">
                <span>VAT Amount:</span>
                <span>{formatThb(vatBreakdown.vatAmount)}</span>
              </div>
              <div className="flex justify-between font-medium border-t pt-1 mt-1">
                <span>Price Inc VAT:</span>
                <span>{formatThb(vatBreakdown.amountIncVat)}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Optional description"
                data-testid="input-template-description"
              />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.isIncludedByDefault}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isIncludedByDefault: checked }))}
                  data-testid="switch-template-included"
                />
                <Label>Included by default</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.isActive}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked }))}
                  data-testid="switch-template-active"
                />
                <Label>Active</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-template"
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
