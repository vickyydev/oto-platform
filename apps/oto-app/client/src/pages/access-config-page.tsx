import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Lock, Plus, Eye, EyeOff, Copy, Edit, Archive, Search, Filter, Check, Clock, User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface AccessItem {
  id: string;
  title: string;
  category: string | null;
  username: string | null;
  branchIds: string[];
  visibilityLevel: string;
  status: string;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
  passwordEncrypted?: string;
}

interface Branch {
  id: string;
  name: string;
}

interface ViewLog {
  id: string;
  viewedBy: string;
  viewerName: string;
  viewedAt: string;
}

const categoryOptions = [
  { value: "wifi", label: "Wi-Fi" },
  { value: "systems", label: "Systems" },
  { value: "door_lock", label: "Door / Lock" },
  { value: "vendor", label: "Vendor" },
  { value: "banking", label: "Banking" },
  { value: "other", label: "Other" },
];

const visibilityOptions = [
  { value: "admin_only", label: "Admin only" },
  { value: "admin_manager", label: "Admin + Manager" },
  { value: "all_staff", label: "All staff" },
];

export default function AccessConfigPage() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AccessItem | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    category: "",
    username: "",
    password: "",
    notes: "",
    branchIds: [] as string[],
    visibilityLevel: "admin_only",
    status: "active",
  });

  const { data: accessItems = [], isLoading } = useQuery<AccessItem[]>({
    queryKey: [`/api/access?status=${statusFilter}&adminMode=true`],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: itemDetail } = useQuery<AccessItem>({
    queryKey: ["/api/access", editingItem?.id],
    enabled: !!editingItem?.id,
  });

  const { data: viewLogs = [] } = useQuery<ViewLog[]>({
    queryKey: ["/api/access", editingItem?.id, "view-logs"],
    enabled: !!editingItem?.id,
  });

  const invalidateAccessQueries = () => {
    // Invalidate both active and archived queries
    queryClient.invalidateQueries({ queryKey: [`/api/access?status=active&adminMode=true`] });
    queryClient.invalidateQueries({ queryKey: [`/api/access?status=archived&adminMode=true`] });
  };

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return apiRequest("POST", "/api/access", data);
    },
    onSuccess: () => {
      invalidateAccessQueries();
      setEditDialogOpen(false);
      toast({ title: "Success", description: "Access item created" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof formData> }) => {
      return apiRequest("PATCH", `/api/access/${id}`, data);
    },
    onSuccess: () => {
      invalidateAccessQueries();
      setEditDialogOpen(false);
      toast({ title: "Success", description: "Access item updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredItems = accessItems.filter(item => 
    item.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreate = () => {
    setEditingItem(null);
    setFormData({
      title: "",
      category: "",
      username: "",
      password: "",
      notes: "",
      branchIds: [],
      visibilityLevel: "admin_only",
      status: "active",
    });
    setShowPassword(false);
    setEditDialogOpen(true);
  };

  const handleEdit = (item: AccessItem) => {
    setEditingItem(item);
    setFormData({
      title: item.title,
      category: item.category || "",
      username: item.username || "",
      password: "",
      notes: item.notes || "",
      branchIds: item.branchIds,
      visibilityLevel: item.visibilityLevel,
      status: item.status,
    });
    setShowPassword(false);
    setEditDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.title) {
      toast({ title: "Error", description: "Title is required", variant: "destructive" });
      return;
    }
    if (!editingItem && !formData.password) {
      toast({ title: "Error", description: "Password is required", variant: "destructive" });
      return;
    }

    if (editingItem) {
      const updates: Record<string, any> = {
        title: formData.title,
        category: formData.category || null,
        username: formData.username || null,
        notes: formData.notes || null,
        branchIds: formData.branchIds,
        visibilityLevel: formData.visibilityLevel,
        status: formData.status,
      };
      if (formData.password) {
        updates.password = formData.password;
      }
      updateMutation.mutate({ id: editingItem.id, data: updates });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleArchive = (item: AccessItem) => {
    updateMutation.mutate({ 
      id: item.id, 
      data: { status: item.status === "archived" ? "active" : "archived" } 
    });
  };

  const toggleBranch = (branchId: string) => {
    setFormData(prev => ({
      ...prev,
      branchIds: prev.branchIds.includes(branchId)
        ? prev.branchIds.filter(id => id !== branchId)
        : [...prev.branchIds, branchId]
    }));
  };

  const branchMap = new Map(branches.map(b => [b.id, b.name]));

  return (
    <div className="container mx-auto p-4 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Lock className="h-6 w-6" />
            Access Configuration
          </h1>
          <p className="text-muted-foreground">Manage shared passwords and access credentials</p>
        </div>
        <Button onClick={handleCreate} data-testid="button-create-access">
          <Plus className="h-4 w-4 mr-2" />
          Add Access Item
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search-access"
          />
        </div>
        <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-auto">
          <TabsList>
            <TabsTrigger value="active" data-testid="tab-active">Active</TabsTrigger>
            <TabsTrigger value="archived" data-testid="tab-archived">Archived</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : filteredItems.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Lock className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>No access items found</p>
            <Button variant="outline" className="mt-4" onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first access item
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredItems.map(item => (
            <Card key={item.id} data-testid={`card-access-item-${item.id}`}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{item.title}</div>
                    <div className="flex items-center gap-2 flex-wrap mt-2">
                      {item.category && (
                        <Badge variant="secondary">
                          {categoryOptions.find(c => c.value === item.category)?.label || item.category}
                        </Badge>
                      )}
                      <Badge variant={item.visibilityLevel === "all_staff" ? "default" : "outline"}>
                        {visibilityOptions.find(v => v.value === item.visibilityLevel)?.label}
                      </Badge>
                      {item.branchIds.map(bid => (
                        <Badge key={bid} variant="outline">
                          {branchMap.get(bid) || bid}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">
                      Updated: {new Date(item.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => handleEdit(item)} data-testid={`button-edit-${item.id}`}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleArchive(item)} data-testid={`button-archive-${item.id}`}>
                      <Archive className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              {editingItem ? "Edit Access Item" : "New Access Item"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Floresta Wi-Fi"
                data-testid="input-title"
              />
            </div>

            <div>
              <Label htmlFor="category">Category</Label>
              <Select value={formData.category} onValueChange={(v) => setFormData({ ...formData, category: v })}>
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="admin"
                data-testid="input-username"
              />
            </div>

            <div>
              <Label htmlFor="password">Password / Code {!editingItem && "*"}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder={editingItem ? "(unchanged)" : "Enter password"}
                    data-testid="input-password"
                  />
                </div>
                <Button 
                  type="button" 
                  size="icon" 
                  variant="ghost" 
                  onClick={() => setShowPassword(!showPassword)}
                  data-testid="button-toggle-password-visibility"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {editingItem && (
                <p className="text-xs text-muted-foreground mt-1">Leave blank to keep existing password</p>
              )}
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Additional notes..."
                rows={3}
                data-testid="input-notes"
              />
            </div>

            <div>
              <Label>Visibility Level *</Label>
              <Select value={formData.visibilityLevel} onValueChange={(v) => setFormData({ ...formData, visibilityLevel: v })}>
                <SelectTrigger data-testid="select-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {visibilityOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Branch Visibility</Label>
              <p className="text-xs text-muted-foreground mb-2">Leave empty for all branches</p>
              <div className="flex flex-wrap gap-2">
                {branches.map(branch => (
                  <Badge
                    key={branch.id}
                    variant={formData.branchIds.includes(branch.id) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleBranch(branch.id)}
                    data-testid={`badge-branch-${branch.id}`}
                  >
                    {formData.branchIds.includes(branch.id) && <Check className="h-3 w-3 mr-1" />}
                    {branch.name}
                  </Badge>
                ))}
              </div>
            </div>

            {editingItem && (
              <div>
                <Label>Status</Label>
                <Select value={formData.status} onValueChange={(v) => setFormData({ ...formData, status: v })}>
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {editingItem && viewLogs.length > 0 && (
              <div className="border-t pt-4">
                <Label className="flex items-center gap-2 mb-2">
                  <Clock className="h-4 w-4" />
                  Recent Views
                </Label>
                <div className="space-y-1 max-h-32 overflow-y-auto text-sm">
                  {viewLogs.slice(0, 10).map(log => (
                    <div key={log.id} className="flex items-center gap-2 text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span>{log.viewerName}</span>
                      <span>-</span>
                      <span>{new Date(log.viewedAt).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-access"
            >
              {editingItem ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
