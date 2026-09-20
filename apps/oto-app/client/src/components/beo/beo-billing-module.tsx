import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  Copy,
  Check,
  ClipboardList,
  RefreshCw,
  Zap,
  AlertTriangle,
} from "lucide-react";
import {
  calculateLineItemVat,
  calculateBillingTotals,
  formatThb,
  type BillingTotals,
} from "@shared/vat-utils";
import { DatePicker } from "@/components/ui/date-picker";
import type { EventLineItem, EventLineItemTemplate, BeoEventBilling } from "@shared/schema";

interface BeoBillingModuleProps {
  eventId: string;
  billing: BeoEventBilling | null;
  onBillingChange: (billing: Partial<BeoEventBilling>) => void;
  isManager: boolean;
}

const CATEGORIES = [
  { value: "ENTERTAINMENT", label: "Entertainment" },
  { value: "FOOD", label: "Food" },
  { value: "SERVICE", label: "Service" },
  { value: "ADD_ON", label: "Add-on" },
  { value: "PACKAGE", label: "Package" },
  { value: "OTHER", label: "Other" },
];

type LineItemFormData = {
  name: string;
  category: "ENTERTAINMENT" | "FOOD" | "SERVICE" | "ADD_ON" | "PACKAGE" | "OTHER";
  qty: number;
  unitPriceIncVat: number;
  isIncluded: boolean;
  notes: string;
  overrideReason: string;
};

export function BeoBillingModule({
  eventId,
  billing,
  onBillingChange,
  isManager,
}: BeoBillingModuleProps) {
  const { toast } = useToast();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<EventLineItem | null>(null);
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
  const [copiedChecklist, setCopiedChecklist] = useState(false);
  const [copiedDetails, setCopiedDetails] = useState(false);
  const [posHelperOpen, setPosHelperOpen] = useState(true);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [generateMode, setGenerateMode] = useState<"merge" | "replace">("merge");
  const [form, setForm] = useState<LineItemFormData>({
    name: "",
    category: "OTHER",
    qty: 1,
    unitPriceIncVat: 0,
    isIncluded: false,
    notes: "",
    overrideReason: "",
  });

  const { data: lineItems = [], isLoading: loadingItems, refetch: refetchItems } = useQuery<EventLineItem[]>({
    queryKey: ["/api/events", eventId, "line-items"],
  });

  const { data: templates = [] } = useQuery<EventLineItemTemplate[]>({
    queryKey: ["/api/settings/line-item-templates"],
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<EventLineItem>) =>
      apiRequest("POST", `/api/events/${eventId}/line-items`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "line-items"] });
      setShowAddDialog(false);
      resetForm();
      toast({ title: "Line item added" });
    },
    onError: () => toast({ title: "Failed to add line item", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EventLineItem> }) =>
      apiRequest("PUT", `/api/events/${eventId}/line-items/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "line-items"] });
      setShowAddDialog(false);
      setEditingItem(null);
      resetForm();
      toast({ title: "Line item updated" });
    },
    onError: () => toast({ title: "Failed to update line item", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/events/${eventId}/line-items/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "line-items"] });
      toast({ title: "Line item removed" });
    },
    onError: () => toast({ title: "Failed to remove line item", variant: "destructive" }),
  });

  const addFromTemplatesMutation = useMutation({
    mutationFn: (templateIds: string[]) =>
      apiRequest("POST", `/api/events/${eventId}/line-items/from-templates`, { templateIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "line-items"] });
      setShowTemplateDialog(false);
      setSelectedTemplates([]);
      toast({ title: "Line items added from templates" });
    },
    onError: () => toast({ title: "Failed to add line items", variant: "destructive" }),
  });

  const generateFromBeoMutation = useMutation({
    mutationFn: (mode: "merge" | "replace") =>
      apiRequest("POST", `/api/events/${eventId}/line-items/generate-from-beo`, { mode }),
    onSuccess: async (response) => {
      const data = await response.json();
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "line-items"] });
      setShowGenerateDialog(false);
      toast({ title: `Generated ${data.count} line item${data.count !== 1 ? "s" : ""} from BEO` });
    },
    onError: () => toast({ title: "Failed to generate from BEO", variant: "destructive" }),
  });

  const resetForm = () => {
    setForm({
      name: "",
      category: "OTHER",
      qty: 1,
      unitPriceIncVat: 0,
      isIncluded: false,
      notes: "",
      overrideReason: "",
    });
    setEditingItem(null);
  };

  const handleEdit = (item: EventLineItem) => {
    setEditingItem(item);
    setForm({
      name: item.name,
      category: item.category as LineItemFormData["category"],
      qty: item.qty,
      unitPriceIncVat: item.unitPriceIncVat,
      isIncluded: item.isIncluded,
      notes: item.notes || "",
      overrideReason: item.overrideReason || "",
    });
    setShowAddDialog(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.id, data: { ...form, isManual: editingItem.isManual } });
    } else {
      createMutation.mutate({ ...form, isManual: true });
    }
  };

  const toggleTemplate = (id: string) => {
    setSelectedTemplates((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const billingTotals: BillingTotals = useMemo(() => {
    const items = lineItems.map((item) => ({
      qty: item.qty,
      unitPriceIncVat: item.unitPriceIncVat,
      isIncluded: item.isIncluded,
    }));
    return calculateBillingTotals(items, billing?.depositPaidAmount || 0);
  }, [lineItems, billing?.depositPaidAmount]);

  const payableItems = lineItems.filter((item) => !item.isIncluded && item.qty * item.unitPriceIncVat > 0);
  const includedItems = lineItems.filter((item) => item.isIncluded);

  const generatePosChecklist = () => {
    const lines: string[] = [];
    lines.push("=== POS Entry Checklist ===");
    lines.push("");
    payableItems.forEach((item) => {
      const subtotal = item.qty * item.unitPriceIncVat;
      lines.push(`Add: ${item.name} — ${formatThb(subtotal)}`);
    });
    if (includedItems.length > 0) {
      lines.push("");
      includedItems.forEach((item) => {
        lines.push(`Do NOT add (Included): ${item.name}`);
      });
    }
    lines.push("");
    lines.push(`Collect Outstanding: ${formatThb(billingTotals.outstandingAmount)}`);
    return lines.join("\n");
  };

  const generateDetailedBreakdown = () => {
    const lines: string[] = [];
    lines.push("=== Line Item Breakdown ===");
    lines.push("Name | Qty | Unit (Inc) | Subtotal (Inc) | Subtotal (Ex) | VAT");
    lines.push("-".repeat(70));
    lineItems.forEach((item) => {
      const calc = calculateLineItemVat(item.qty, item.unitPriceIncVat, item.isIncluded);
      const status = item.isIncluded ? " [INCLUDED]" : "";
      lines.push(
        `${item.name}${status} | ${item.qty} | ${formatThb(item.unitPriceIncVat)} | ${formatThb(calc.subtotalIncVat)} | ${formatThb(calc.subtotalExVat)} | ${formatThb(calc.vatAmount)}`
      );
    });
    lines.push("-".repeat(70));
    lines.push(`Total (Inc VAT): ${formatThb(billingTotals.totalIncVat)}`);
    lines.push(`Total (Ex VAT): ${formatThb(billingTotals.totalExVat)}`);
    lines.push(`Total VAT (7%): ${formatThb(billingTotals.totalVat)}`);
    lines.push(`Deposit Paid: ${formatThb(billingTotals.depositAmount)}`);
    lines.push(`Outstanding: ${formatThb(billingTotals.outstandingAmount)}`);
    return lines.join("\n");
  };

  const copyToClipboard = async (text: string, type: "checklist" | "details") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "checklist") {
        setCopiedChecklist(true);
        setTimeout(() => setCopiedChecklist(false), 2000);
      } else {
        setCopiedDetails(true);
        setTimeout(() => setCopiedDetails(false), 2000);
      }
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };

  const getPaymentStatusBadge = () => {
    switch (billingTotals.paymentStatus) {
      case "PAID":
        return <Badge className="bg-green-600">PAID</Badge>;
      case "PART_PAID":
        return <Badge className="bg-yellow-600">PART PAID</Badge>;
      default:
        return <Badge variant="destructive">NOT PAID</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Financial Summary */}
      <Card className="border-2 border-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center justify-between">
            <span>Financial Summary</span>
            {getPaymentStatusBadge()}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground">Total (Inc VAT)</p>
              <p className="text-xl font-bold">{formatThb(billingTotals.totalIncVat)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Total (Ex VAT)</p>
              <p className="text-lg font-medium">{formatThb(billingTotals.totalExVat)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">VAT (7%)</p>
              <p className="text-lg font-medium">{formatThb(billingTotals.totalVat)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Outstanding</p>
              <p className={`text-xl font-bold ${billingTotals.outstandingAmount > 0 ? "text-destructive" : "text-green-600"}`}>
                {formatThb(billingTotals.outstandingAmount)}
              </p>
              {billingTotals.overpaidAmount > 0 && (
                <p className="text-xs text-green-600">Overpaid: {formatThb(billingTotals.overpaidAmount)}</p>
              )}
            </div>
          </div>

          {isManager && (
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <Label>Deposit Paid:</Label>
                  <Input
                    type="number"
                    min="0"
                    className="w-32"
                    value={billing?.depositPaidAmount || 0}
                    onChange={(e) => onBillingChange({ depositPaidAmount: parseInt(e.target.value) || 0, depositPaid: parseInt(e.target.value) > 0 })}
                    data-testid="input-deposit-amount"
                  />
                  <span className="text-sm text-muted-foreground">THB</span>
                </div>
                <div className="flex items-center gap-2">
                  <Label>Date Paid:</Label>
                  <DatePicker
                    value={billing?.depositPaidAt ? billing.depositPaidAt.slice(0, 10) : undefined}
                    onChange={(dateStr) => onBillingChange({ depositPaidAt: dateStr ? `${dateStr}T00:00:00.000Z` : null })}
                    placeholder="Select date"
                    className="w-44"
                    data-testid="datepicker-deposit-paid-at"
                  />
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Line Items Table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-lg">Line Items</CardTitle>
            {isManager && (
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowGenerateDialog(true)}
                  data-testid="button-generate-from-beo"
                >
                  <Zap className="h-4 w-4 mr-1" />
                  From BEO
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTemplateDialog(true)}
                  data-testid="button-add-from-templates"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  From Templates
                </Button>
                <Button
                  size="sm"
                  onClick={() => { resetForm(); setShowAddDialog(true); }}
                  data-testid="button-add-manual-item"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Manual
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loadingItems ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : lineItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No line items yet</p>
              {isManager && <p className="text-sm">Add items from templates or manually</p>}
            </div>
          ) : (
            <div className="space-y-2">
              {/* Header for larger screens */}
              <div className="hidden md:grid md:grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-2">
                <div className="col-span-3">Item</div>
                <div className="col-span-1 text-right">Qty</div>
                <div className="col-span-2 text-right">Unit (Inc)</div>
                <div className="col-span-2 text-right">Subtotal (Inc)</div>
                <div className="col-span-2 text-right">VAT</div>
                <div className="col-span-2 text-right">Actions</div>
              </div>

              {lineItems.map((item) => {
                const calc = calculateLineItemVat(item.qty, item.unitPriceIncVat, item.isIncluded);
                return (
                  <div
                    key={item.id}
                    className={`border rounded-md p-3 ${item.isIncluded ? "bg-muted/50" : ""}`}
                    data-testid={`line-item-${item.id}`}
                  >
                    {/* Mobile layout */}
                    <div className="md:hidden space-y-2">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium flex items-center gap-2 flex-wrap">
                            {item.name}
                            {item.isIncluded && <Badge variant="outline" className="text-xs">Included</Badge>}
                          </div>
                        </div>
                        {isManager && (
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={() => handleEdit(item)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteMutation.mutate(item.id)}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <span className="text-muted-foreground">Qty:</span> {item.qty}
                        </div>
                        <div>
                          <span className="text-muted-foreground">Unit:</span> {formatThb(item.unitPriceIncVat)}
                        </div>
                        <div>
                          <span className="text-muted-foreground">Subtotal:</span>{" "}
                          {item.isIncluded ? (
                            <span className="line-through text-muted-foreground">{formatThb(calc.referenceValueIncVat)}</span>
                          ) : (
                            formatThb(calc.subtotalIncVat)
                          )}
                        </div>
                        <div>
                          <span className="text-muted-foreground">VAT:</span> {formatThb(calc.vatAmount)}
                        </div>
                      </div>
                      {item.notes && <p className="text-xs text-muted-foreground">{item.notes}</p>}
                    </div>

                    {/* Desktop layout */}
                    <div className="hidden md:grid md:grid-cols-12 gap-2 items-center">
                      <div className="col-span-3">
                        <div className="font-medium flex items-center gap-2 flex-wrap">
                          {item.name}
                          {item.isIncluded && <Badge variant="outline" className="text-xs">Included</Badge>}
                        </div>
                      </div>
                      <div className="col-span-1 text-right">{item.qty}</div>
                      <div className="col-span-2 text-right">{formatThb(item.unitPriceIncVat)}</div>
                      <div className="col-span-2 text-right">
                        {item.isIncluded ? (
                          <span className="line-through text-muted-foreground">{formatThb(calc.referenceValueIncVat)}</span>
                        ) : (
                          formatThb(calc.subtotalIncVat)
                        )}
                      </div>
                      <div className="col-span-2 text-right">{formatThb(calc.vatAmount)}</div>
                      <div className="col-span-2 text-right">
                        {isManager && (
                          <div className="flex gap-1 justify-end">
                            <Button variant="ghost" size="icon" onClick={() => handleEdit(item)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteMutation.mutate(item.id)}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Totals row */}
              <div className="border-t pt-3 mt-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm font-medium">
                  <div>
                    <span className="text-muted-foreground">Total (Inc VAT):</span>
                    <span className="ml-2">{formatThb(billingTotals.totalIncVat)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total (Ex VAT):</span>
                    <span className="ml-2">{formatThb(billingTotals.totalExVat)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">VAT:</span>
                    <span className="ml-2">{formatThb(billingTotals.totalVat)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Outstanding:</span>
                    <span className={`ml-2 ${billingTotals.outstandingAmount > 0 ? "text-destructive" : "text-green-600"}`}>
                      {formatThb(billingTotals.outstandingAmount)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* POS Entry Helper */}
      <Collapsible open={posHelperOpen} onOpenChange={setPosHelperOpen}>
        <Card>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <ClipboardList className="h-5 w-5" />
                  POS Entry Checklist
                </CardTitle>
                <ChevronDown className={`h-5 w-5 transition-transform ${posHelperOpen ? "rotate-180" : ""}`} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              {payableItems.length === 0 && includedItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add line items to generate POS checklist</p>
              ) : (
                <div className="space-y-3">
                  {payableItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-green-700 dark:text-green-400">Add to POS:</p>
                      {payableItems.map((item) => {
                        const inclVat = item.qty * item.unitPriceIncVat;
                        const exclVat = Math.round((inclVat / 1.07) * 100) / 100;
                        return (
                          <div key={item.id} className="flex justify-between text-sm bg-green-50 dark:bg-green-900/20 p-2 rounded">
                            <span>{item.name}</span>
                            <span className="font-medium">{formatThb(exclVat)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {includedItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-muted-foreground">Do NOT add (Included):</p>
                      {includedItems.map((item) => {
                        const inclVat = item.qty * item.unitPriceIncVat;
                        const exclVat = Math.round((inclVat / 1.07) * 100) / 100;
                        return (
                          <div key={item.id} className="flex justify-between text-sm text-muted-foreground p-2 rounded bg-muted/30">
                            <span className="line-through">{item.name}</span>
                            <span className="line-through">{formatThb(exclVat)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(() => {
                    const payableInclTotal = payableItems.reduce((sum, item) => sum + item.qty * item.unitPriceIncVat, 0);
                    const payableExclTotal = Math.round((payableInclTotal / 1.07) * 100) / 100;
                    const payableVat = Math.round((payableInclTotal - payableExclTotal) * 100) / 100;
                    return (
                      <div className="border-t pt-3 mt-3 space-y-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Subtotal (excl. VAT)</span>
                          <span>{formatThb(payableExclTotal)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">VAT 7%</span>
                          <span>{formatThb(payableVat)}</span>
                        </div>
                        <div className="flex justify-between items-center text-lg font-bold pt-1">
                          <span>Grand Total</span>
                          <span>{formatThb(payableInclTotal)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Add/Edit Line Item Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => { if (!open) resetForm(); setShowAddDialog(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Line Item" : "Add Manual Line Item"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Extra decorations"
                data-testid="input-item-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((prev) => ({ ...prev, category: v as LineItemFormData["category"] }))}
              >
                <SelectTrigger data-testid="select-item-category">
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
                <Label>Qty</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.qty}
                  onChange={(e) => setForm((prev) => ({ ...prev, qty: parseInt(e.target.value) || 1 }))}
                  data-testid="input-item-qty"
                />
              </div>
              <div className="space-y-2">
                <Label>Unit Price (Inc VAT)</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.unitPriceIncVat}
                  onChange={(e) => setForm((prev) => ({ ...prev, unitPriceIncVat: parseInt(e.target.value) || 0 }))}
                  data-testid="input-item-price"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.isIncluded}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isIncluded: checked }))}
                data-testid="switch-item-included"
              />
              <Label>Included (no charge)</Label>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Optional notes"
                data-testid="input-item-notes"
              />
            </div>
            {editingItem && editingItem.templateId && (
              <div className="space-y-2">
                <Label>Override Reason</Label>
                <Input
                  value={form.overrideReason}
                  onChange={(e) => setForm((prev) => ({ ...prev, overrideReason: e.target.value }))}
                  placeholder="Why is this price different?"
                  data-testid="input-item-override-reason"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-item"
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {editingItem ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generate from BEO Dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Generate Billing from BEO
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This will create billing line items from the BEO setup plan, entertainment, and kitchen data.
            </p>

            {lineItems.some(i => i.autoGenerated) && (
              <div className="space-y-3">
                <Label>Existing auto-generated items found</Label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="generateMode"
                      value="merge"
                      checked={generateMode === "merge"}
                      onChange={() => setGenerateMode("merge")}
                      className="accent-primary"
                    />
                    <span className="text-sm">Merge - Add only new items (skip duplicates)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="generateMode"
                      value="replace"
                      checked={generateMode === "replace"}
                      onChange={() => setGenerateMode("replace")}
                      className="accent-primary"
                    />
                    <span className="text-sm">Replace - Remove existing auto items and regenerate</span>
                  </label>
                </div>
                {generateMode === "replace" && (
                  <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-2 rounded-md">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>This will remove all auto-generated items and create new ones. Manual items will not be affected.</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>Cancel</Button>
            <Button
              onClick={() => generateFromBeoMutation.mutate(generateMode)}
              disabled={generateFromBeoMutation.isPending}
              data-testid="button-confirm-generate-beo"
            >
              {generateFromBeoMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add from Templates Dialog */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add from Templates</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {templates.filter((t) => t.isActive).length === 0 ? (
              <p className="text-muted-foreground text-center py-4">
                No templates available. Create templates in Event Settings.
              </p>
            ) : (
              templates.filter((t) => t.isActive).map((template) => (
                <div
                  key={template.id}
                  className={`p-3 border rounded-md cursor-pointer transition-colors ${
                    selectedTemplates.includes(template.id)
                      ? "bg-primary/10 border-primary"
                      : "hover:bg-muted/50"
                  }`}
                  onClick={() => toggleTemplate(template.id)}
                  data-testid={`template-option-${template.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{template.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {formatThb(template.defaultUnitPriceIncVat)} × {template.defaultQty}
                      </div>
                    </div>
                    <Badge variant="secondary">
                      {CATEGORIES.find((c) => c.value === template.category)?.label || template.category}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowTemplateDialog(false); setSelectedTemplates([]); }}>
              Cancel
            </Button>
            <Button
              onClick={() => addFromTemplatesMutation.mutate(selectedTemplates)}
              disabled={selectedTemplates.length === 0 || addFromTemplatesMutation.isPending}
              data-testid="button-add-selected-templates"
            >
              {addFromTemplatesMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add {selectedTemplates.length} Item{selectedTemplates.length !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
