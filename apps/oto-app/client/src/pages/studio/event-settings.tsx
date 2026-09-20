import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useAuth } from "@/lib/auth";
import { Redirect } from "wouter";
import {
  MapPin,
  Music,
  Settings,
  Plus,
  Pencil,
  Trash2,
  ArrowLeft,
  Loader2,
  Receipt,
  Package,
  ListChecks,
} from "lucide-react";
import { Link } from "wouter";
import type { BeoLocation, BeoSetupItemOption } from "@shared/schema";
import { LineItemTemplatesSettings } from "@/components/beo/line-item-templates-settings";
import { BirthdayPackagesSettings } from "@/components/beo/birthday-packages-settings";
import { EntertainmentTemplatesSettings } from "@/components/beo/entertainment-templates-settings";
import { SetMenuTemplatesSettings } from "@/components/beo/set-menu-templates-settings";

type LocationFormData = {
  name: string;
  description: string;
  capacity: number | null;
  branchId: string;
  branchIds: string[];
  isActive: boolean;
};

type SetupItemFormData = {
  name: string;
  category: string;
  notes: string;
  defaultCost: string;
  isActive: boolean;
};

export default function EventSettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("tab") || "locations";
  });
  
  const [showLocationDialog, setShowLocationDialog] = useState(false);
  const [editingLocation, setEditingLocation] = useState<BeoLocation | null>(null);
  const [locationForm, setLocationForm] = useState<LocationFormData>({
    name: "",
    description: "",
    capacity: null,
    branchId: "",
    branchIds: [],
    isActive: true,
  });

  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [editingSetup, setEditingSetup] = useState<BeoSetupItemOption | null>(null);
  const [setupForm, setSetupForm] = useState<SetupItemFormData>({
    name: "",
    category: "",
    notes: "",
    defaultCost: "0",
    isActive: true,
  });

  if (user?.role !== "admin" && user?.role !== "manager" && user?.role !== "global_admin") {
    return <Redirect to="/studio" />;
  }

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["/api/branches"],
  });

  const { data: locations = [], isLoading: loadingLocations } = useQuery<BeoLocation[]>({
    queryKey: ["/api/beo/locations"],
  });

  const { data: setupOptions = [], isLoading: loadingSetup } = useQuery<BeoSetupItemOption[]>({
    queryKey: ["/api/beo/setup-item-options"],
  });

  const createLocationMutation = useMutation({
    mutationFn: (data: LocationFormData) => apiRequest("POST", "/api/beo/locations", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/locations"] });
      setShowLocationDialog(false);
      resetLocationForm();
      toast({ title: "Location created" });
    },
    onError: () => toast({ title: "Failed to create location", variant: "destructive" }),
  });

  const updateLocationMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<LocationFormData> }) =>
      apiRequest("PUT", `/api/beo/locations/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/locations"] });
      setShowLocationDialog(false);
      resetLocationForm();
      toast({ title: "Location updated" });
    },
    onError: () => toast({ title: "Failed to update location", variant: "destructive" }),
  });

  const deleteLocationMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/beo/locations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/locations"] });
      toast({ title: "Location deactivated" });
    },
    onError: () => toast({ title: "Failed to deactivate location", variant: "destructive" }),
  });

  const createSetupMutation = useMutation({
    mutationFn: (data: SetupItemFormData) => apiRequest("POST", "/api/beo/setup-item-options", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/setup-item-options"] });
      setShowSetupDialog(false);
      resetSetupForm();
      toast({ title: "Setup item created" });
    },
    onError: () => toast({ title: "Failed to create setup item", variant: "destructive" }),
  });

  const updateSetupMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SetupItemFormData> }) =>
      apiRequest("PUT", `/api/beo/setup-item-options/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/setup-item-options"] });
      setShowSetupDialog(false);
      resetSetupForm();
      toast({ title: "Setup item updated" });
    },
    onError: () => toast({ title: "Failed to update setup item", variant: "destructive" }),
  });

  const deleteSetupMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/beo/setup-item-options/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/beo/setup-item-options"] });
      toast({ title: "Setup item deactivated" });
    },
    onError: () => toast({ title: "Failed to deactivate setup item", variant: "destructive" }),
  });

  const resetLocationForm = () => {
    setEditingLocation(null);
    setLocationForm({ name: "", description: "", capacity: null, branchId: "", branchIds: [], isActive: true });
  };

  const resetSetupForm = () => {
    setEditingSetup(null);
    setSetupForm({ name: "", category: "", notes: "", defaultCost: "0", isActive: true });
  };

  const openEditLocation = (location: BeoLocation) => {
    setEditingLocation(location);
    setLocationForm({
      name: location.name,
      description: location.description || "",
      capacity: location.capacity,
      branchId: location.branchId,
      branchIds: location.branchIds || [],
      isActive: location.isActive,
    });
    setShowLocationDialog(true);
  };

  const openEditSetup = (option: BeoSetupItemOption) => {
    setEditingSetup(option);
    setSetupForm({
      name: option.name,
      category: option.category || "",
      notes: option.notes || "",
      defaultCost: String((option.defaultCost || 0) / 100),
      isActive: option.isActive,
    });
    setShowSetupDialog(true);
  };

  const handleSaveLocation = () => {
    if (!locationForm.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const allSelectedBranches = [locationForm.branchId, ...locationForm.branchIds].filter(Boolean);
    if (allSelectedBranches.length === 0) {
      toast({ title: "At least one branch is required", variant: "destructive" });
      return;
    }
    const primaryBranch = locationForm.branchId || allSelectedBranches[0];
    const additionalBranches = allSelectedBranches.filter(id => id !== primaryBranch);
    const payload = {
      ...locationForm,
      branchId: primaryBranch,
      branchIds: additionalBranches,
    };

    if (editingLocation) {
      updateLocationMutation.mutate({ id: editingLocation.id, data: payload });
    } else {
      createLocationMutation.mutate(payload);
    }
  };

  const handleSaveSetup = () => {
    if (!setupForm.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    const payload = {
      ...setupForm,
      defaultCost: Math.round(parseFloat(setupForm.defaultCost || "0") * 100),
    };

    if (editingSetup) {
      updateSetupMutation.mutate({ id: editingSetup.id, data: payload });
    } else {
      createSetupMutation.mutate(payload as any);
    }
  };

  const getBranchName = (branchId: string) => {
    const branch = branches.find((b: any) => b.id === branchId);
    return branch?.name || "Unknown";
  };

  const getAllBranchNames = (location: BeoLocation) => {
    const allIds = [location.branchId, ...(location.branchIds || [])].filter(Boolean);
    const unique = [...new Set(allIds)];
    return unique.map(id => getBranchName(id)).join(", ");
  };

  const getSelectedBranchIds = () => {
    return [...new Set([locationForm.branchId, ...locationForm.branchIds].filter(Boolean))];
  };

  const toggleBranch = (branchId: string) => {
    const current = getSelectedBranchIds();
    const updated = current.includes(branchId)
      ? current.filter(id => id !== branchId)
      : [...current, branchId];
    if (updated.length > 0) {
      setLocationForm(prev => ({
        ...prev,
        branchId: updated[0],
        branchIds: updated.slice(1),
      }));
    } else {
      setLocationForm(prev => ({
        ...prev,
        branchId: "",
        branchIds: [],
      }));
    }
  };

  return (
    <StudioLayout>
      <div className="p-4 max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link href="/studio/settings">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold">Event Settings</h1>
            <p className="text-sm text-muted-foreground">Manage locations, entertainment options, and setup items</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4 flex-wrap h-auto gap-1">
            <TabsTrigger value="locations" data-testid="tab-locations">
              <MapPin className="h-4 w-4 mr-2" />
              Locations
            </TabsTrigger>
            <TabsTrigger value="packages" data-testid="tab-packages">
              <Package className="h-4 w-4 mr-2" />
              Packages
            </TabsTrigger>
            <TabsTrigger value="entertainment" data-testid="tab-entertainment">
              <Music className="h-4 w-4 mr-2" />
              Entertainment
            </TabsTrigger>
            <TabsTrigger value="setup" data-testid="tab-setup">
              <Settings className="h-4 w-4 mr-2" />
              Setup Items
            </TabsTrigger>
            <TabsTrigger value="set-menus" data-testid="tab-set-menus">
              <ListChecks className="h-4 w-4 mr-2" />
              Set Menus
            </TabsTrigger>
            <TabsTrigger value="line-items" data-testid="tab-line-items">
              <Receipt className="h-4 w-4 mr-2" />
              Line Items
            </TabsTrigger>
          </TabsList>

          <TabsContent value="locations">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle>Event Locations</CardTitle>
                  <CardDescription>Manage venue locations for events</CardDescription>
                </div>
                <Button onClick={() => { resetLocationForm(); setShowLocationDialog(true); }} data-testid="button-add-location">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Location
                </Button>
              </CardHeader>
              <CardContent>
                {loadingLocations ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : locations.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No locations configured. Add your first location to get started.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {locations.map((location) => (
                      <div
                        key={location.id}
                        className={`flex items-center justify-between p-3 border rounded-md ${!location.isActive ? "opacity-50" : ""}`}
                        data-testid={`location-${location.id}`}
                      >
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {location.name}
                            {!location.isActive && <Badge variant="secondary">Inactive</Badge>}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {getAllBranchNames(location)}
                            {location.capacity && ` • Capacity: ${location.capacity}`}
                          </div>
                          {location.description && (
                            <div className="text-sm text-muted-foreground">{location.description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" onClick={() => openEditLocation(location)} data-testid={`edit-location-${location.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteLocationMutation.mutate(location.id)}
                            disabled={!location.isActive}
                            data-testid={`delete-location-${location.id}`}
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
          </TabsContent>

          <TabsContent value="entertainment">
            <EntertainmentTemplatesSettings />
          </TabsContent>

          <TabsContent value="setup">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle>Setup Item Options</CardTitle>
                  <CardDescription>Manage setup item templates for events</CardDescription>
                </div>
                <Button onClick={() => { resetSetupForm(); setShowSetupDialog(true); }} data-testid="button-add-setup">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Item
                </Button>
              </CardHeader>
              <CardContent>
                {loadingSetup ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : setupOptions.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No setup items configured. Add items like "Balloons", "Backdrop", "Table Layout", etc.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {setupOptions.map((option) => (
                      <div
                        key={option.id}
                        className={`flex items-center justify-between p-3 border rounded-md ${!option.isActive ? "opacity-50" : ""}`}
                        data-testid={`setup-${option.id}`}
                      >
                        <div>
                          <div className="font-medium flex items-center gap-2 flex-wrap">
                            {option.name}
                            {option.category && <Badge variant="outline">{option.category}</Badge>}
                            {(option.defaultCost || 0) > 0 && <Badge variant="secondary">THB {((option.defaultCost || 0) / 100).toLocaleString()}</Badge>}
                            {!option.isActive && <Badge variant="secondary">Inactive</Badge>}
                          </div>
                          {option.notes && (
                            <div className="text-sm text-muted-foreground">{option.notes}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" onClick={() => openEditSetup(option)} data-testid={`edit-setup-${option.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteSetupMutation.mutate(option.id)}
                            disabled={!option.isActive}
                            data-testid={`delete-setup-${option.id}`}
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
          </TabsContent>

          <TabsContent value="line-items">
            <Card>
              <CardHeader>
                <CardTitle>Line Items (POS Guide)</CardTitle>
                <CardDescription>
                  Manage reusable line items for event billing. These templates can be added to events to calculate totals with VAT.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineItemTemplatesSettings />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="packages">
            <BirthdayPackagesSettings />
          </TabsContent>

          <TabsContent value="set-menus">
            <SetMenuTemplatesSettings />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={showLocationDialog} onOpenChange={(open) => { if (!open) { resetLocationForm(); setShowLocationDialog(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingLocation ? "Edit Location" : "Add Location"}</DialogTitle>
            <DialogDescription>
              {editingLocation ? "Update location details" : "Add a new event location"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={locationForm.name}
                onChange={(e) => setLocationForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Main Hall"
                data-testid="input-location-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Branches *</Label>
              <div className="border rounded-md p-3 space-y-2 max-h-40 overflow-y-auto" data-testid="select-location-branches">
                {branches.map((branch: any) => (
                  <div key={branch.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`branch-${branch.id}`}
                      checked={getSelectedBranchIds().includes(branch.id)}
                      onCheckedChange={() => toggleBranch(branch.id)}
                      data-testid={`checkbox-branch-${branch.id}`}
                    />
                    <label htmlFor={`branch-${branch.id}`} className="text-sm cursor-pointer">
                      {branch.name}
                    </label>
                  </div>
                ))}
                {branches.length === 0 && (
                  <p className="text-sm text-muted-foreground">No branches available</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Capacity</Label>
              <Input
                type="number"
                value={locationForm.capacity ?? ""}
                onChange={(e) => setLocationForm((prev) => ({ ...prev, capacity: e.target.value ? parseInt(e.target.value) : null }))}
                placeholder="Maximum number of guests"
                data-testid="input-location-capacity"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={locationForm.description}
                onChange={(e) => setLocationForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of the location"
                data-testid="input-location-description"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={locationForm.isActive}
                onCheckedChange={(checked) => setLocationForm((prev) => ({ ...prev, isActive: checked }))}
                data-testid="switch-location-active"
              />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLocationDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSaveLocation}
              disabled={createLocationMutation.isPending || updateLocationMutation.isPending}
              data-testid="button-save-location"
            >
              {(createLocationMutation.isPending || updateLocationMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {editingLocation ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSetupDialog} onOpenChange={(open) => { if (!open) { resetSetupForm(); setShowSetupDialog(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSetup ? "Edit Setup Item" : "Add Setup Item"}</DialogTitle>
            <DialogDescription>
              {editingSetup ? "Update setup item details" : "Add a new setup item template"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={setupForm.name}
                onChange={(e) => setSetupForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Balloons, Backdrop"
                data-testid="input-setup-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Input
                value={setupForm.category}
                onChange={(e) => setSetupForm((prev) => ({ ...prev, category: e.target.value }))}
                placeholder="e.g., Decorations, Furniture"
                data-testid="input-setup-category"
              />
            </div>
            <div className="space-y-2">
              <Label>Default Cost (THB)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={setupForm.defaultCost}
                onChange={(e) => setSetupForm((prev) => ({ ...prev, defaultCost: e.target.value }))}
                placeholder="0"
                data-testid="input-setup-cost"
              />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={setupForm.notes}
                onChange={(e) => setSetupForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Additional notes about this setup item"
                data-testid="input-setup-notes"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={setupForm.isActive}
                onCheckedChange={(checked) => setSetupForm((prev) => ({ ...prev, isActive: checked }))}
                data-testid="switch-setup-active"
              />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSetupDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSaveSetup}
              disabled={createSetupMutation.isPending || updateSetupMutation.isPending}
              data-testid="button-save-setup"
            >
              {(createSetupMutation.isPending || updateSetupMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {editingSetup ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
