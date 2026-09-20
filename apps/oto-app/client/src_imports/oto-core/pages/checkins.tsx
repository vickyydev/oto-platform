import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Loader2, Search, Phone, Clock, AlertTriangle, User, Baby, CheckCircle, MessageCircle, LogOut, Pencil, Users, Camera, Image, UserCheck, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ServiceCheckin } from "@shared/schema";
import { format } from "date-fns";

type EditEntry = { timestamp: string; changes: Record<string, { from: string; to: string }> };

function EditHistorySection({ editLog }: { editLog: unknown }) {
  if (!Array.isArray(editLog) || editLog.length === 0) return null;
  const logs = editLog as EditEntry[];
  return (
    <div className="pt-4 border-t">
      <Label className="text-muted-foreground">Edit History</Label>
      <div className="mt-2 space-y-2">
        {logs.map((entry, idx) => (
          <div key={idx} className="text-xs p-2 bg-muted rounded-md">
            <div className="font-medium text-muted-foreground">
              {format(new Date(entry.timestamp), "MMM d, HH:mm")}
            </div>
            <div className="mt-1">
              {Object.keys(entry.changes).map((field) => {
                const change = entry.changes[field];
                return (
                  <div key={field}>
                    <span className="font-medium">{field}:</span>{" "}
                    <span className="text-destructive line-through">{String(change.from || "(empty)")}</span>{" "}
                    <span className="text-green-600">{String(change.to || "(empty)")}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CheckinsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCheckin, setSelectedCheckin] = useState<ServiceCheckin | null>(null);
  const [showMarkOutDialog, setShowMarkOutDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [fullscreenPhotoUrl, setFullscreenPhotoUrl] = useState<string | null>(null);
  const [assignForm, setAssignForm] = useState({
    serviceType: "" as "" | "nanny" | "dropoff",
    nannyAssigned: "",
  });
  const [outSignature, setOutSignature] = useState<string | null>(null);
  const [outSignedName, setOutSignedName] = useState("");
  const [outPhotoFile, setOutPhotoFile] = useState<File | null>(null);
  const [outPhotoPreview, setOutPhotoPreview] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("in");
  const [serviceFilter, setServiceFilter] = useState<"all" | "nanny" | "dropoff">("all");

  const [editForm, setEditForm] = useState({
    parentFullName: "",
    childFullName: "",
    whatsappPhoneRaw: "",
    allergiesMedicalDetails: "",
    foodNotesRestrictions: "",
    staffNotes: "",
    nannyAssigned: "",
  });

  const { data: checkins, isLoading } = useQuery<ServiceCheckin[]>({
    queryKey: ["/api/service-checkins", activeTab, serviceFilter],
    queryFn: async () => {
      let url = `/api/service-checkins?status=${activeTab}`;
      if (serviceFilter !== "all") {
        url += `&serviceType=${serviceFilter}`;
      }
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch check-ins");
      return res.json();
    },
  });

  const markOutMutation = useMutation({
    mutationFn: async (id: string) => {
      const formData = new FormData();
      formData.append("outSignedName", outSignedName);
      if (outSignature) {
        formData.append("signature", outSignature);
      }
      if (outPhotoFile) {
        formData.append("outPhoto", outPhotoFile);
      }
      
      const res = await fetch(`/api/service-checkins/${id}/out`, {
        method: "PATCH",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) throw new Error("Failed to mark out");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Child has been marked as picked up" });
      setShowMarkOutDialog(false);
      setSelectedCheckin(null);
      setOutSignature(null);
      setOutSignedName("");
      setOutPhotoFile(null);
      setOutPhotoPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/service-checkins"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const res = await fetch(`/api/service-checkins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update check-in");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Check-in updated successfully" });
      setShowEditDialog(false);
      setSelectedCheckin(null);
      queryClient.invalidateQueries({ queryKey: ["/api/service-checkins"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const res = await fetch(`/api/service-checkins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update check-in");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Assignment updated successfully" });
      setShowAssignDialog(false);
      setSelectedCheckin(null);
      queryClient.invalidateQueries({ queryKey: ["/api/service-checkins"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredCheckins = checkins?.filter((c) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      c.childFullName.toLowerCase().includes(query) ||
      c.parentFullName.toLowerCase().includes(query) ||
      c.whatsappPhoneRaw.includes(query)
    );
  });

  const getWhatsAppLink = (checkin: ServiceCheckin, messageType: "checkin" | "pickup") => {
    const phone = checkin.whatsappPhoneE164?.replace("+", "") || checkin.whatsappPhoneRaw.replace(/\D/g, "");
    const serviceName = checkin.serviceType === "nanny" ? "Nanny Service" : "Drop-Off Service";
    const message = messageType === "checkin"
      ? `Hi ${checkin.parentFullName}, this is OTO Play Park. Just confirming ${checkin.childFullName} is checked in for ${serviceName}. Reply here if you need anything.`
      : `Hi ${checkin.parentFullName}, ${checkin.childFullName} is ready for pickup at OTO Play Park.`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  };

  const handleMarkOut = (checkin: ServiceCheckin) => {
    setFullscreenPhotoUrl(null);
    setSelectedCheckin(checkin);
    setShowMarkOutDialog(true);
  };

  const handleEdit = (checkin: ServiceCheckin) => {
    setFullscreenPhotoUrl(null);
    setSelectedCheckin(checkin);
    setEditForm({
      parentFullName: checkin.parentFullName,
      childFullName: checkin.childFullName,
      whatsappPhoneRaw: checkin.whatsappPhoneRaw,
      allergiesMedicalDetails: checkin.allergiesMedicalDetails || "",
      foodNotesRestrictions: checkin.foodNotesRestrictions || "",
      staffNotes: checkin.staffNotes || "",
      nannyAssigned: checkin.nannyAssigned || "",
    });
    setShowEditDialog(true);
  };

  const handleViewPhoto = (checkin: ServiceCheckin) => {
    if (checkin.photoUrl) {
      setFullscreenPhotoUrl(checkin.photoUrl);
    }
  };

  const handleAssign = (checkin: ServiceCheckin) => {
    setFullscreenPhotoUrl(null);
    setSelectedCheckin(checkin);
    setAssignForm({
      serviceType: checkin.serviceType || "",
      nannyAssigned: checkin.nannyAssigned || "",
    });
    setShowAssignDialog(true);
  };

  const confirmAssign = () => {
    if (!selectedCheckin) return;
    const updates: Record<string, any> = {};
    if (assignForm.serviceType && assignForm.serviceType !== selectedCheckin.serviceType) {
      updates.serviceType = assignForm.serviceType;
    }
    if (assignForm.nannyAssigned !== (selectedCheckin.nannyAssigned || "")) {
      updates.nannyAssigned = assignForm.nannyAssigned;
    }
    if (Object.keys(updates).length === 0) {
      toast({ title: "No Changes", description: "No fields were modified" });
      return;
    }
    assignMutation.mutate({ id: selectedCheckin.id, updates });
  };

  const handleOutPhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setOutPhotoFile(file);
      setOutPhotoPreview(URL.createObjectURL(file));
    }
  };

  const confirmMarkOut = () => {
    if (!selectedCheckin) return;
    if (!outPhotoFile) {
      toast({ title: "Error", description: "Please take a photo of the family leaving", variant: "destructive" });
      return;
    }
    markOutMutation.mutate(selectedCheckin.id);
  };

  const confirmEdit = () => {
    if (!selectedCheckin) return;
    
    const originalData = {
      parentFullName: selectedCheckin.parentFullName,
      childFullName: selectedCheckin.childFullName,
      whatsappPhoneRaw: selectedCheckin.whatsappPhoneRaw,
      allergiesMedicalDetails: selectedCheckin.allergiesMedicalDetails || "",
      foodNotesRestrictions: selectedCheckin.foodNotesRestrictions || "",
      staffNotes: selectedCheckin.staffNotes || "",
      nannyAssigned: selectedCheckin.nannyAssigned || "",
    };
    
    const changedFields: Record<string, any> = {};
    for (const [key, value] of Object.entries(editForm)) {
      if (value !== originalData[key as keyof typeof originalData]) {
        changedFields[key] = value;
      }
    }
    
    if (Object.keys(changedFields).length === 0) {
      toast({ title: "No Changes", description: "No fields were modified" });
      return;
    }
    
    editMutation.mutate({ id: selectedCheckin.id, updates: changedFields });
  };

  return (
    <AppLayout>
      <div className="p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by child, parent, or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-checkins"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant={serviceFilter === "all" ? "default" : "outline"}
            onClick={() => setServiceFilter("all")}
            data-testid="filter-all"
          >
            All
          </Button>
          <Button
            size="sm"
            variant={serviceFilter === "nanny" ? "default" : "outline"}
            onClick={() => setServiceFilter("nanny")}
            data-testid="filter-nanny"
          >
            <Baby className="h-4 w-4 mr-1" />
            Nanny
          </Button>
          <Button
            size="sm"
            variant={serviceFilter === "dropoff" ? "default" : "outline"}
            onClick={() => setServiceFilter("dropoff")}
            data-testid="filter-dropoff"
          >
            <Users className="h-4 w-4 mr-1" />
            Drop-Off
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full">
            <TabsTrigger value="in" className="flex-1" data-testid="tab-checkins-in">
              Checked In
            </TabsTrigger>
            <TabsTrigger value="out" className="flex-1" data-testid="tab-checkins-out">
              Picked Up
            </TabsTrigger>
          </TabsList>

          <TabsContent value="in" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredCheckins?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No children currently checked in
              </div>
            ) : (
              filteredCheckins?.map((checkin) => (
                <CheckinCard
                  key={checkin.id}
                  checkin={checkin}
                  onPickUp={() => handleMarkOut(checkin)}
                  onEdit={() => handleEdit(checkin)}
                  onAssign={() => handleAssign(checkin)}
                  onViewPhoto={() => handleViewPhoto(checkin)}
                  getWhatsAppLink={getWhatsAppLink}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="out" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredCheckins?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No pick-ups today
              </div>
            ) : (
              filteredCheckins?.map((checkin) => (
                <CheckinCard
                  key={checkin.id}
                  checkin={checkin}
                  isPickedUp
                  onEdit={() => handleEdit(checkin)}
                  onViewPhoto={() => handleViewPhoto(checkin)}
                  getWhatsAppLink={getWhatsAppLink}
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={showMarkOutDialog} onOpenChange={setShowMarkOutDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as Picked Up</DialogTitle>
            <DialogDescription>
              {selectedCheckin && (
                <>
                  Confirm pickup for <strong>{selectedCheckin.childFullName}</strong> by{" "}
                  <strong>{selectedCheckin.parentFullName}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {selectedCheckin?.photoUrl && (
              <div>
                <label className="text-sm font-medium mb-2 block">Check-in Photo (for comparison) - tap to enlarge</label>
                <div 
                  className="rounded-lg overflow-hidden border cursor-pointer"
                  onClick={() => setFullscreenPhotoUrl(selectedCheckin.photoUrl!)}
                >
                  <img 
                    src={selectedCheckin.photoUrl} 
                    alt="Check-in photo" 
                    className="w-full h-40 object-cover"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-sm font-medium mb-2 block">Take Photo of Family Leaving *</label>
              {outPhotoPreview ? (
                <div className="relative">
                  <img 
                    src={outPhotoPreview} 
                    alt="Pickup photo" 
                    className="w-full h-40 object-cover rounded-lg border"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute top-2 right-2"
                    onClick={() => {
                      setOutPhotoFile(null);
                      setOutPhotoPreview(null);
                    }}
                  >
                    Retake
                  </Button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center h-40 border-2 border-dashed rounded-lg cursor-pointer hover:bg-muted/50">
                  <Camera className="h-8 w-8 text-muted-foreground mb-2" />
                  <span className="text-sm text-muted-foreground">Tap to take photo</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={handleOutPhotoChange}
                    data-testid="input-out-photo"
                  />
                </label>
              )}
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Collected By (optional)</label>
              <Input
                placeholder="Name of person picking up"
                value={outSignedName}
                onChange={(e) => setOutSignedName(e.target.value)}
                data-testid="input-out-signed-name"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMarkOutDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmMarkOut}
              disabled={markOutMutation.isPending}
              data-testid="button-confirm-markout"
            >
              {markOutMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Confirm Pick Up
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Check-in</DialogTitle>
            <DialogDescription>
              Update information for this check-in. Changes will be logged.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            <div>
              <Label>Parent Name</Label>
              <Input
                value={editForm.parentFullName}
                onChange={(e) => setEditForm({ ...editForm, parentFullName: e.target.value })}
                data-testid="edit-parent-name"
              />
            </div>

            <div>
              <Label>Child Name</Label>
              <Input
                value={editForm.childFullName}
                onChange={(e) => setEditForm({ ...editForm, childFullName: e.target.value })}
                data-testid="edit-child-name"
              />
            </div>

            <div>
              <Label>WhatsApp Number</Label>
              <Input
                value={editForm.whatsappPhoneRaw}
                onChange={(e) => setEditForm({ ...editForm, whatsappPhoneRaw: e.target.value })}
                data-testid="edit-phone"
              />
            </div>

            <div>
              <Label>Medical/Allergy Details</Label>
              <Textarea
                value={editForm.allergiesMedicalDetails}
                onChange={(e) => setEditForm({ ...editForm, allergiesMedicalDetails: e.target.value })}
                placeholder="Medical conditions, allergies..."
                data-testid="edit-allergies"
              />
            </div>

            <div>
              <Label>Food Restrictions</Label>
              <Textarea
                value={editForm.foodNotesRestrictions}
                onChange={(e) => setEditForm({ ...editForm, foodNotesRestrictions: e.target.value })}
                placeholder="Dietary restrictions..."
                data-testid="edit-food"
              />
            </div>

            <div>
              <Label>Staff Notes</Label>
              <Textarea
                value={editForm.staffNotes}
                onChange={(e) => setEditForm({ ...editForm, staffNotes: e.target.value })}
                placeholder="Internal notes..."
                data-testid="edit-notes"
              />
            </div>

            {selectedCheckin?.serviceType === "nanny" && (
              <div>
                <Label>Nanny Assigned</Label>
                <Input
                  value={editForm.nannyAssigned}
                  onChange={(e) => setEditForm({ ...editForm, nannyAssigned: e.target.value })}
                  placeholder="Enter nanny name..."
                  data-testid="edit-nanny"
                />
              </div>
            )}

            {selectedCheckin?.photoUrl && (
              <div>
                <Label>Check-in Photo</Label>
                <div className="rounded-lg overflow-hidden border mt-2">
                  <img 
                    src={selectedCheckin.photoUrl} 
                    alt="Check-in photo" 
                    className="w-full h-40 object-cover"
                  />
                </div>
              </div>
            )}

            {selectedCheckin?.editLog ? (
              <EditHistorySection editLog={selectedCheckin.editLog} />
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmEdit}
              disabled={editMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {editMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAssignDialog} onOpenChange={setShowAssignDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Service</DialogTitle>
            <DialogDescription>
              {selectedCheckin && (
                <>
                  Assign service type and nanny for <strong>{selectedCheckin.childFullName}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Service Type</Label>
              <Select
                value={assignForm.serviceType}
                onValueChange={(value: "nanny" | "dropoff") => setAssignForm({ ...assignForm, serviceType: value })}
              >
                <SelectTrigger data-testid="select-service-type">
                  <SelectValue placeholder="Select service type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nanny">
                    <span className="flex items-center gap-2">
                      <Baby className="h-4 w-4" />
                      Nanny
                    </span>
                  </SelectItem>
                  <SelectItem value="dropoff">
                    <span className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Drop-Off
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Nanny Assigned</Label>
              <Input
                value={assignForm.nannyAssigned}
                onChange={(e) => setAssignForm({ ...assignForm, nannyAssigned: e.target.value })}
                placeholder="Enter nanny name..."
                data-testid="input-assign-nanny"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssignDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmAssign}
              disabled={assignMutation.isPending}
              data-testid="button-confirm-assign"
            >
              {assignMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Assignment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {fullscreenPhotoUrl && fullscreenPhotoUrl.length > 0 && (
        <div 
          className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setFullscreenPhotoUrl(null)}
        >
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-4 right-4 text-white z-10"
            onClick={() => setFullscreenPhotoUrl(null)}
          >
            <X className="h-6 w-6" />
          </Button>
          <img 
            src={fullscreenPhotoUrl} 
            alt="Full screen photo" 
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
            onError={(e) => {
              (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpolyline points='21 15 16 10 5 21'/%3E%3C/svg%3E";
            }}
          />
          <p className="absolute bottom-4 text-white/70 text-sm">Tap anywhere to close</p>
        </div>
      )}
    </AppLayout>
  );
}

function CheckinCard({
  checkin,
  onPickUp,
  onEdit,
  onAssign,
  onViewPhoto,
  isPickedUp,
  getWhatsAppLink,
}: {
  checkin: ServiceCheckin;
  onPickUp?: () => void;
  onEdit?: () => void;
  onAssign?: () => void;
  onViewPhoto?: () => void;
  isPickedUp?: boolean;
  getWhatsAppLink: (checkin: ServiceCheckin, type: "checkin" | "pickup") => string;
}) {
  const serviceConfig = {
    nanny: {
      label: "Nanny",
      color: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
      icon: Baby,
    },
    dropoff: {
      label: "Drop-Off",
      color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      icon: Users,
    },
  };

  const config = serviceConfig[checkin.serviceType];
  const ServiceIcon = config.icon;

  return (
    <Card data-testid={`card-checkin-${checkin.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <ServiceIcon className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold">{checkin.childFullName}</h3>
              <Badge variant="secondary" className="text-xs">
                Age {checkin.childAge}
              </Badge>
              <Badge className={`text-xs ${config.color}`}>
                {config.label}
              </Badge>
              {checkin.hasAllergiesOrMedical && (
                <Badge variant="destructive" className="text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Medical
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
              <User className="h-3 w-3" />
              <span>{checkin.parentFullName}</span>
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>
                In: {checkin.inSignedAt ? format(new Date(checkin.inSignedAt), "HH:mm") : "N/A"}
                {isPickedUp && checkin.outSignedAt && (
                  <> | Out: {format(new Date(checkin.outSignedAt), "HH:mm")}</>
                )}
              </span>
            </div>
          </div>
        </div>

        {checkin.hasAllergiesOrMedical && checkin.allergiesMedicalDetails && (
          <div className="mt-3 p-2 bg-destructive/10 rounded-md text-sm">
            <strong>Medical/Allergies:</strong> {checkin.allergiesMedicalDetails}
          </div>
        )}

        {checkin.staffNotes && (
          <div className="mt-2 p-2 bg-muted rounded-md text-sm">
            <strong>Staff Notes:</strong> {checkin.staffNotes}
          </div>
        )}

        {checkin.nannyAssigned && (
          <div className="mt-2 p-2 bg-pink-50 dark:bg-pink-950/30 rounded-md text-sm">
            <strong>Nanny:</strong> {checkin.nannyAssigned}
          </div>
        )}

        
        {!isPickedUp && (
          <div className="flex gap-2 mt-3">
            {onAssign && (
              <Button size="sm" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white" onClick={onAssign} data-testid={`button-assign-${checkin.id}`}>
                <UserCheck className="h-4 w-4 mr-1" />
                Assign
              </Button>
            )}
            <a
              href={getWhatsAppLink(checkin, "checkin")}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1"
            >
              <Button size="sm" className="w-full bg-green-600 hover:bg-green-700 text-white" data-testid={`button-whatsapp-${checkin.id}`}>
                <MessageCircle className="h-4 w-4 mr-1" />
                WhatsApp
              </Button>
            </a>
            {onPickUp && (
              <Button size="sm" className="flex-1 bg-red-600 hover:bg-red-700 text-white" onClick={onPickUp} data-testid={`button-pickup-${checkin.id}`}>
                <LogOut className="h-4 w-4 mr-1" />
                Pick Up
              </Button>
            )}
          </div>
        )}
        
        <div className="flex gap-2 mt-2 flex-wrap">
          {checkin.photoUrl && onViewPhoto && (
            <Button size="sm" variant="outline" onClick={onViewPhoto} data-testid={`button-photo-${checkin.id}`}>
              <Image className="h-4 w-4 mr-1" />
              Photo
            </Button>
          )}
          <a href={`tel:${checkin.whatsappPhoneRaw}`}>
            <Button size="sm" variant="outline" data-testid={`button-call-${checkin.id}`}>
              <Phone className="h-4 w-4 mr-1" />
              Call
            </Button>
          </a>
          {onEdit && (
            <Button size="sm" variant="outline" onClick={onEdit} data-testid={`button-edit-${checkin.id}`}>
              <Pencil className="h-4 w-4 mr-1" />
              Edit
            </Button>
          )}
          {isPickedUp && (
            <a
              href={getWhatsAppLink(checkin, "pickup")}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" data-testid={`button-whatsapp-${checkin.id}`}>
                <MessageCircle className="h-4 w-4 mr-1" />
                WhatsApp
              </Button>
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
