import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";

type EntertainmentPackageTemplate = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  durationMinutes: number | null;
  defaultPrice: number;
  included: boolean;
  billableByDefault: boolean;
  category: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
};

type FormData = {
  name: string;
  description: string;
  category: string;
  durationMinutes: string;
  defaultPrice: string;
  included: boolean;
  billableByDefault: boolean;
};

const emptyForm: FormData = {
  name: "",
  description: "",
  category: "",
  durationMinutes: "",
  defaultPrice: "0",
  included: false,
  billableByDefault: false,
};

const formatPrice = (satang: number) => `${(satang / 100).toFixed(2)}`;
const parsePriceToSatang = (thb: string) => Math.round(parseFloat(thb || "0") * 100);

export function EntertainmentTemplatesSettings() {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<EntertainmentPackageTemplate | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);

  const { data: templates = [], isLoading } = useQuery<EntertainmentPackageTemplate[]>({
    queryKey: ["/api/beo/entertainment-templates"],
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", "/api/beo/entertainment-templates", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/entertainment-templates"] });
      setShowDialog(false);
      resetForm();
      toast({ title: "Entertainment template created" });
    },
    onError: () => toast({ title: "Failed to create template", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/beo/entertainment-templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/entertainment-templates"] });
      setShowDialog(false);
      resetForm();
      toast({ title: "Entertainment template updated" });
    },
    onError: () => toast({ title: "Failed to update template", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/beo/entertainment-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/entertainment-templates"] });
      toast({ title: "Entertainment template archived" });
    },
    onError: () => toast({ title: "Failed to archive template", variant: "destructive" }),
  });

  const resetForm = () => {
    setEditing(null);
    setForm(emptyForm);
  };

  const openEdit = (template: EntertainmentPackageTemplate) => {
    setEditing(template);
    setForm({
      name: template.name,
      description: template.description || "",
      category: template.category || "",
      durationMinutes: template.durationMinutes != null ? String(template.durationMinutes) : "",
      defaultPrice: formatPrice(template.defaultPrice),
      included: template.included,
      billableByDefault: template.billableByDefault,
    });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      category: form.category.trim() || null,
      durationMinutes: form.durationMinutes ? parseInt(form.durationMinutes, 10) : null,
      defaultPrice: parsePriceToSatang(form.defaultPrice),
      included: form.included,
      billableByDefault: form.billableByDefault,
    };

    if (editing) {
      updateMutation.mutate({ id: editing.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Entertainment Templates</CardTitle>
            <CardDescription>Configure reusable entertainment options with pricing</CardDescription>
          </div>
          <Button
            onClick={() => { resetForm(); setShowDialog(true); }}
            data-testid="button-add-entertainment-template"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Entertainment
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-empty-entertainment-templates">
              No entertainment templates configured. Add your first template to get started.
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className={`flex items-center justify-between p-3 border rounded-md ${!template.isActive ? "opacity-50" : ""}`}
                  data-testid={`entertainment-template-${template.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium" data-testid={`text-template-name-${template.id}`}>
                        {template.name}
                      </span>
                      <span className="text-sm text-muted-foreground" data-testid={`text-template-price-${template.id}`}>
                        THB {formatPrice(template.defaultPrice)}
                      </span>
                    </div>
                    {template.description && (
                      <div className="text-sm text-muted-foreground mt-0.5" data-testid={`text-template-description-${template.id}`}>
                        {template.description}
                      </div>
                    )}
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      {template.durationMinutes != null && (
                        <Badge variant="secondary" data-testid={`badge-duration-${template.id}`}>
                          {template.durationMinutes} min
                        </Badge>
                      )}
                      {template.category && (
                        <Badge variant="secondary" data-testid={`badge-category-${template.id}`}>
                          {template.category}
                        </Badge>
                      )}
                      {template.included && (
                        <Badge variant="outline" className="border-green-500 text-green-600" data-testid={`badge-included-${template.id}`}>
                          Included
                        </Badge>
                      )}
                      <Badge variant={template.isActive ? "secondary" : "outline"} data-testid={`badge-status-${template.id}`}>
                        {template.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(template)}
                      data-testid={`button-edit-template-${template.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(template.id)}
                      disabled={!template.isActive || deleteMutation.isPending}
                      data-testid={`button-archive-template-${template.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={(open) => { if (!open) { resetForm(); setShowDialog(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Entertainment Template" : "Add Entertainment Template"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update the entertainment template details." : "Create a new reusable entertainment option with pricing."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g., DJ Set"
                data-testid="input-template-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Brief description"
                data-testid="input-template-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Input
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder="e.g., Music"
                  data-testid="input-template-category"
                />
              </div>
              <div className="space-y-2">
                <Label>Duration (minutes)</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.durationMinutes}
                  onChange={(e) => setForm((f) => ({ ...f, durationMinutes: e.target.value }))}
                  placeholder="e.g., 30"
                  data-testid="input-template-duration"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Default Price (THB)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.defaultPrice}
                onChange={(e) => setForm((f) => ({ ...f, defaultPrice: e.target.value }))}
                data-testid="input-template-price"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Included in Package</Label>
              <Switch
                checked={form.included}
                onCheckedChange={(v) => setForm((f) => ({ ...f, included: v }))}
                data-testid="switch-template-included"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Billable by Default</Label>
              <Switch
                checked={form.billableByDefault}
                onCheckedChange={(v) => setForm((f) => ({ ...f, billableByDefault: v }))}
                data-testid="switch-template-billable"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { resetForm(); setShowDialog(false); }}
              data-testid="button-cancel-template"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving}
              data-testid="button-save-template"
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
