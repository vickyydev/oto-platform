import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Plus, MapPin, Pencil, Trash2, ChevronRight, Building2 } from "lucide-react";
import type { Branch } from "@shared/schema";

type LocationWithBranches = {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  branchAccess: { id: string; locationId: string; branchId: string }[];
};

const AVAILABLE_TAGS = ["Birthday", "Workshop", "Training", "Meeting"] as const;

export default function LocationsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<LocationWithBranches | null>(null);
  const [formData, setFormData] = useState({ 
    name: "", 
    description: "", 
    parentId: "",
    branchIds: [] as string[],
    tags: [] as string[]
  });

  const isStaff = user?.role === "staff";
  const canEdit = !isStaff;

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: locations = [], isLoading } = useQuery<LocationWithBranches[]>({
    queryKey: ["/api/locations"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; parentId: string; branchIds: string[]; tags: string[] }) => {
      return apiRequest("POST", "/api/locations", { 
        name: data.name, 
        description: data.description || null,
        parentId: data.parentId || null,
        branchIds: data.branchIds,
        tags: data.tags
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      setCreateOpen(false);
      setFormData({ name: "", description: "", parentId: "", branchIds: [], tags: [] });
      toast({ title: "Location created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: string; name: string; description: string; parentId: string; branchIds: string[]; tags: string[] }) => {
      return apiRequest("PATCH", `/api/locations/${data.id}`, { 
        name: data.name, 
        description: data.description || null,
        parentId: data.parentId || null,
        branchIds: data.branchIds,
        tags: data.tags
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      setEditingLocation(null);
      setFormData({ name: "", description: "", parentId: "", branchIds: [], tags: [] });
      toast({ title: "Location updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/locations/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Location deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleCreate = () => {
    createMutation.mutate(formData);
  };

  const handleUpdate = () => {
    if (!editingLocation) return;
    updateMutation.mutate({ id: editingLocation.id, ...formData });
  };

  const openEdit = (location: LocationWithBranches) => {
    setEditingLocation(location);
    setFormData({
      name: location.name,
      description: location.description || "",
      parentId: location.parentId || "",
      branchIds: location.branchAccess.map(ba => ba.branchId),
      tags: location.tags || [],
    });
  };

  const toggleTag = (tag: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      tags: checked
        ? [...prev.tags, tag]
        : prev.tags.filter(t => t !== tag),
    }));
  };

  const toggleBranch = (branchId: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      branchIds: checked
        ? [...prev.branchIds, branchId]
        : prev.branchIds.filter(id => id !== branchId),
    }));
  };

  const parentLocations = locations.filter(l => !l.parentId);
  const getSublocations = (parentId: string) => locations.filter(l => l.parentId === parentId);
  const getParentName = (parentId: string | null) => {
    if (!parentId) return null;
    const parent = locations.find(l => l.id === parentId);
    return parent?.name;
  };

  const getBranchNames = (branchAccess: { branchId: string }[]) => {
    if (branchAccess.length === 0) return "All branches";
    return branchAccess.map(ba => {
      const branch = branches.find(b => b.id === ba.branchId);
      return branch?.name || "Unknown";
    }).join(", ");
  };

  const renderLocationForm = (isEdit = false) => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={isEdit ? "edit-name" : "create-name"}>Location Name</Label>
        <Input
          id={isEdit ? "edit-name" : "create-name"}
          value={formData.name}
          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
          placeholder="e.g., Kitchen, Reception, Play Area"
          data-testid="input-location-name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={isEdit ? "edit-description" : "create-description"}>Description</Label>
        <Textarea
          id={isEdit ? "edit-description" : "create-description"}
          value={formData.description}
          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
          placeholder="Optional description"
          data-testid="input-location-description"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={isEdit ? "edit-parentId" : "create-parentId"}>Parent Location (Optional)</Label>
        <Select
          value={formData.parentId}
          onValueChange={(value) => setFormData(prev => ({ ...prev, parentId: value === "none" ? "" : value }))}
        >
          <SelectTrigger data-testid="select-parent-location">
            <SelectValue placeholder="Select parent location (for sublocations)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No parent (top-level location)</SelectItem>
            {parentLocations
              .filter(l => !isEdit || l.id !== editingLocation?.id)
              .map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Branch Access</Label>
        <p className="text-sm text-muted-foreground">
          Leave unchecked for all branches, or select specific branches
        </p>
        <div className="grid gap-2 max-h-40 overflow-y-auto border rounded-md p-3">
          {branches.map((branch) => (
            <div key={branch.id} className="flex items-center space-x-2">
              <Checkbox
                id={isEdit ? `edit-branch-${branch.id}` : `create-branch-${branch.id}`}
                checked={formData.branchIds.includes(branch.id)}
                onCheckedChange={(checked) => toggleBranch(branch.id, !!checked)}
                data-testid={`checkbox-branch-${branch.id}`}
              />
              <Label htmlFor={isEdit ? `edit-branch-${branch.id}` : `create-branch-${branch.id}`} className="text-sm cursor-pointer">
                {branch.name}
              </Label>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label>Event Type Tags</Label>
        <p className="text-sm text-muted-foreground">
          Select tags to filter this location for specific event types
        </p>
        <div className="flex flex-wrap gap-2">
          {AVAILABLE_TAGS.map((tag) => (
            <div key={tag} className="flex items-center space-x-2">
              <Checkbox
                id={isEdit ? `edit-tag-${tag}` : `create-tag-${tag}`}
                checked={formData.tags.includes(tag)}
                onCheckedChange={(checked) => toggleTag(tag, !!checked)}
                data-testid={`checkbox-tag-${tag.toLowerCase()}`}
              />
              <Label htmlFor={isEdit ? `edit-tag-${tag}` : `create-tag-${tag}`} className="text-sm cursor-pointer">
                {tag}
              </Label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const LocationCard = ({ location, isChild = false }: { location: LocationWithBranches; isChild?: boolean }) => {
    const sublocations = getSublocations(location.id);
    
    return (
      <div className={isChild ? "ml-6 border-l-2 border-muted pl-4" : ""}>
        <Card className="mb-3" data-testid={`card-location-${location.id}`}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1">
                <div className="p-2 rounded-md bg-muted">
                  <MapPin className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-base">{location.name}</h3>
                    {location.parentId && (
                      <Badge variant="outline" className="text-xs">
                        Sub-location
                      </Badge>
                    )}
                  </div>
                  {location.description && (
                    <p className="text-sm text-muted-foreground mt-1">{location.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <Building2 className="h-3 w-3" />
                    <span>{getBranchNames(location.branchAccess)}</span>
                  </div>
                  {location.tags && location.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {location.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openEdit(location)}
                    data-testid={`button-edit-location-${location.id}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (confirm("Are you sure you want to delete this location?")) {
                        deleteMutation.mutate(location.id);
                      }
                    }}
                    disabled={sublocations.length > 0}
                    data-testid={`button-delete-location-${location.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        {sublocations.map((subloc) => (
          <LocationCard key={subloc.id} location={subloc} isChild />
        ))}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Locations</h1>
          <p className="text-muted-foreground">
            Manage location and sub-location tags for checklists and tasks
          </p>
        </div>
        {canEdit && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-location">
                <Plus className="mr-2 h-4 w-4" />
                Add Location
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="dialog-create-location">
              <DialogHeader>
                <DialogTitle>Create Location</DialogTitle>
                <DialogDescription>
                  Add a new location tag for organizing checklists and tasks
                </DialogDescription>
              </DialogHeader>
              {renderLocationForm(false)}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                  data-testid="button-cancel-create"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!formData.name || createMutation.isPending}
                  data-testid="button-save-location"
                >
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {locations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <MapPin className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No locations yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create locations to organize and tag your checklists and tasks
            </p>
            {canEdit && (
              <Button onClick={() => setCreateOpen(true)} data-testid="button-create-first-location">
                <Plus className="mr-2 h-4 w-4" />
                Add First Location
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {parentLocations.map((location) => (
            <LocationCard key={location.id} location={location} />
          ))}
        </div>
      )}

      <Dialog open={!!editingLocation} onOpenChange={(open) => !open && setEditingLocation(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="dialog-edit-location">
          <DialogHeader>
            <DialogTitle>Edit Location</DialogTitle>
            <DialogDescription>
              Update location details and branch access
            </DialogDescription>
          </DialogHeader>
          {renderLocationForm(true)}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingLocation(null)}
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={!formData.name || updateMutation.isPending}
              data-testid="button-update-location"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
