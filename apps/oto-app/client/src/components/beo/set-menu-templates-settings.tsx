import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  X,
  ListChecks,
} from "lucide-react";

type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean };

type SetMenuTemplate = {
  id: string;
  name: string;
  items: SetMenuTemplateItem[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

function newItemId() {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function ItemEditor({
  item,
  onChange,
  onRemove,
}: {
  item: SetMenuTemplateItem;
  onChange: (updated: SetMenuTemplateItem) => void;
  onRemove: () => void;
}) {
  const [newOption, setNewOption] = useState("");

  return (
    <div className="border rounded-md p-3 space-y-2 bg-muted/30">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
            item.type === "always_included"
              ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
              : "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400"
          }`}
          onClick={() =>
            onChange(
              item.type === "always_included"
                ? { id: item.id, type: "choice_group", label: item.label, options: [], allowMultiple: false }
                : { id: item.id, type: "always_included", label: item.label }
            )
          }
        >
          {item.type === "always_included" ? "ALWAYS INCL" : "CHOICE"}
        </button>
        <Input
          className="flex-1 h-7 text-xs"
          value={item.label}
          onChange={(e) => onChange({ ...item, label: e.target.value } as SetMenuTemplateItem)}
          placeholder={item.type === "always_included" ? "Item name (e.g. Pasta)" : "Group name (e.g. Pizza Flavour)"}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onRemove}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      {item.type === "choice_group" && (
        <div className="pl-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <Switch
              checked={item.allowMultiple}
              onCheckedChange={(v) => onChange({ ...item, allowMultiple: v } as SetMenuTemplateItem)}
              id={`multi-${item.id}`}
            />
            <label htmlFor={`multi-${item.id}`} className="text-xs text-muted-foreground cursor-pointer">
              Allow multiple choices
            </label>
          </div>
          <div className="space-y-1">
            {item.options.map((opt, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground w-4 shrink-0">•</span>
                <Input
                  className="flex-1 h-6 text-xs"
                  value={opt}
                  onChange={(e) => {
                    const updated = [...item.options];
                    updated[i] = e.target.value;
                    onChange({ ...item, options: updated } as SetMenuTemplateItem);
                  }}
                  placeholder="Option..."
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground"
                  onClick={() => {
                    const updated = item.options.filter((_, idx) => idx !== i);
                    onChange({ ...item, options: updated } as SetMenuTemplateItem);
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Input
              className="flex-1 h-6 text-xs"
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newOption.trim()) {
                  onChange({ ...item, options: [...item.options, newOption.trim()] } as SetMenuTemplateItem);
                  setNewOption("");
                }
              }}
              placeholder="Add option, press Enter..."
            />
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              disabled={!newOption.trim()}
              onClick={() => {
                if (newOption.trim()) {
                  onChange({ ...item, options: [...item.options, newOption.trim()] } as SetMenuTemplateItem);
                  setNewOption("");
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SetMenuTemplatesSettings() {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SetMenuTemplate | null>(null);
  const [formName, setFormName] = useState("");
  const [formItems, setFormItems] = useState<SetMenuTemplateItem[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data: templates = [], isLoading } = useQuery<SetMenuTemplate[]>({
    queryKey: ["/api/beo/set-menu-templates"],
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; items: SetMenuTemplateItem[] }) =>
      apiRequest("POST", "/api/beo/set-menu-templates", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/set-menu-templates"] });
      setShowDialog(false);
      toast({ title: "Set menu template created" });
    },
    onError: () => toast({ title: "Failed to create template", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name: string; items: SetMenuTemplateItem[] } }) =>
      apiRequest("PUT", `/api/beo/set-menu-templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/set-menu-templates"] });
      setShowDialog(false);
      toast({ title: "Set menu template updated" });
    },
    onError: () => toast({ title: "Failed to update template", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/beo/set-menu-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/set-menu-templates"] });
      toast({ title: "Template deactivated" });
    },
    onError: () => toast({ title: "Failed to deactivate template", variant: "destructive" }),
  });

  const openNew = () => {
    setEditingTemplate(null);
    setFormName("");
    setFormItems([]);
    setShowDialog(true);
  };

  const openEdit = (t: SetMenuTemplate) => {
    setEditingTemplate(t);
    setFormName(t.name);
    setFormItems(t.items || []);
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!formName.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const payload = { name: formName.trim(), items: formItems };
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const addItem = (type: "always_included" | "choice_group") => {
    const newItem: SetMenuTemplateItem =
      type === "always_included"
        ? { id: newItemId(), type: "always_included", label: "" }
        : { id: newItemId(), type: "choice_group", label: "", options: [], allowMultiple: false };
    setFormItems((prev) => [...prev, newItem]);
  };

  const updateItem = (idx: number, updated: SetMenuTemplateItem) => {
    setFormItems((prev) => prev.map((item, i) => (i === idx ? updated : item)));
  };

  const removeItem = (idx: number) => {
    setFormItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Set Menu Templates</CardTitle>
            <CardDescription>
              Create reusable kids set menu templates with always-included items and choice groups (e.g. pick a pizza flavour).
            </CardDescription>
          </div>
          <Button onClick={openNew} data-testid="button-add-set-menu-template">
            <Plus className="h-4 w-4 mr-2" />
            Add Template
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No set menu templates yet. Create one to attach it to a BEO's kids menu.
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((tmpl) => {
                const isExpanded = expandedIds.has(tmpl.id);
                const items = (tmpl.items || []) as SetMenuTemplateItem[];
                return (
                  <div
                    key={tmpl.id}
                    className={`border rounded-md ${!tmpl.isActive ? "opacity-50" : ""}`}
                    data-testid={`set-menu-template-${tmpl.id}`}
                  >
                    <div className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <ListChecks className="h-4 w-4 text-emerald-500 shrink-0" />
                        <span className="font-medium text-sm truncate">{tmpl.name}</span>
                        {!tmpl.isActive && <Badge variant="secondary" className="text-xs">Inactive</Badge>}
                        <Badge variant="outline" className="text-xs shrink-0">
                          {items.length} item{items.length !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => toggleExpand(tmpl.id)}
                          data-testid={`toggle-template-${tmpl.id}`}
                        >
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(tmpl)}
                          data-testid={`edit-template-${tmpl.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => deleteMutation.mutate(tmpl.id)}
                          disabled={!tmpl.isActive}
                          data-testid={`delete-template-${tmpl.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {isExpanded && items.length > 0 && (
                      <div className="px-3 pb-3 border-t space-y-1 pt-2">
                        {items.map((item, i) => (
                          <div key={item.id || i} className="flex items-start gap-2 text-sm py-0.5">
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 shrink-0 mt-0.5 ${
                                item.type === "always_included"
                                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                                  : "bg-blue-500/10 text-blue-600 border-blue-500/30"
                              }`}
                            >
                              {item.type === "always_included" ? "ALWAYS" : "CHOICE"}
                            </Badge>
                            <div>
                              <span>{item.label}</span>
                              {item.type === "choice_group" && item.options.length > 0 && (
                                <span className="text-xs text-muted-foreground ml-1">
                                  ({item.options.join(" / ")})
                                  {item.allowMultiple && " — multi-select"}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={(open) => { if (!open) setShowDialog(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Set Menu Template" : "New Set Menu Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Template Name *</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Standard Birthday Package"
                data-testid="input-set-menu-template-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Items</Label>
              <div className="space-y-2">
                {formItems.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-3 border border-dashed rounded-md">
                    No items yet. Add always-included items or choice groups below.
                  </p>
                )}
                {formItems.map((item, idx) => (
                  <ItemEditor
                    key={item.id}
                    item={item}
                    onChange={(updated) => updateItem(idx, updated)}
                    onRemove={() => removeItem(idx)}
                  />
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => addItem("always_included")}
                  data-testid="button-add-always-included"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Always Included
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => addItem("choice_group")}
                  data-testid="button-add-choice-group"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Choice Group
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-set-menu-template"
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {editingTemplate ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
