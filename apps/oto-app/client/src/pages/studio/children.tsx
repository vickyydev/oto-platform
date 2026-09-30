import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Baby,
  Search,
  Phone,
  User,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Tent,
  Calendar,
  AlertTriangle,
  Info,
  MapPin,
  UserPlus,
  Check,
  Merge,
  X,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { ChildProfileEditor, type ChildProfileFormValues } from "@/components/camp/child-profile-editor";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format, parseISO, differenceInYears } from "date-fns";

// ─── helpers ─────────────────────────────────────────────────────────────────

function calcAge(dob: string | null | undefined): number | null {
  if (!dob) return null;
  try {
    return differenceInYears(new Date(), parseISO(dob));
  } catch {
    return null;
  }
}

function PhotoAvatar({ url, name }: { url?: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        className="h-10 w-10 rounded-full object-cover flex-shrink-0 border border-border"
      />
    );
  }
  return (
    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0 border border-border">
      <Baby className="h-5 w-5 text-muted-foreground" />
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default function ChildrenDatabasePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // list state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const { data: listData, isLoading: listLoading } = useQuery<{
    children: any[];
    total: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: ["/api/admin/children", debouncedSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const res = await fetch(`/api/admin/children?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load children");
      return res.json();
    },
  });

  const children = listData?.children ?? [];
  const total = listData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // profile sheet state
  const [selectedChild, setSelectedChild] = useState<any | null>(null);
  const [profileForm, setProfileForm] = useState<ChildProfileFormValues>({
    childFullName: "",
    dateOfBirth: "",
    primaryLanguage: "",
    allergies: "",
    foodRestrictions: "",
    behavioralNotes: "",
    specialNotes: "",
    authorizedPickupPersons: "",
    parentContacts: [{ name: "", phone: "" }],
    childPhotoUrl: "",
  });
  const [profilePhotoUploading, setProfilePhotoUploading] = useState(false);

  // camp history
  const { data: historyData, isLoading: historyLoading } = useQuery<{ history: any[] }>({
    queryKey: ["/api/admin/children", selectedChild?.id, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/children/${selectedChild.id}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    enabled: !!selectedChild,
  });

  // Enroll in camp dialog
  const [showEnrollDialog, setShowEnrollDialog] = useState(false);
  const [selectedCampId, setSelectedCampId] = useState<string>("");

  const { data: openCamps = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/events", "camps-open"],
    queryFn: async () => {
      const res = await fetch("/api/admin/events?type=camp", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const camps = Array.isArray(data) ? data : (data.events ?? []);
      return camps.filter((e: any) => e.eventType === "camp" && e.status !== "cancelled");
    },
    enabled: showEnrollDialog,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["/api/branches"],
    queryFn: async () => {
      const res = await fetch("/api/branches", { credentials: "include" });
      return res.json();
    },
  });

  const branchName = (branchId?: string | null) =>
    branches.find((b: any) => b.id === branchId)?.name || "";

  const openChildProfile = (child: any) => {
    setSelectedChild(child);
    // Build parentContacts: prefer stored array, fall back to legacy single fields
    const parentContacts: Array<{name: string; phone: string}> =
      Array.isArray(child.parentContacts) && child.parentContacts.length > 0
        ? child.parentContacts
        : [{ name: child.parentGuardianName || "", phone: child.emergencyContactNumber || "" }];
    setProfileForm({
      childFullName: child.childFullName || "",
      dateOfBirth: child.dateOfBirth || "",
      primaryLanguage: child.primaryLanguage || "",
      allergies: child.allergies || "",
      foodRestrictions: child.foodRestrictions || "",
      behavioralNotes: child.behavioralNotes || "",
      specialNotes: child.specialNotes || "",
      authorizedPickupPersons: child.authorizedPickupPersons || "",
      parentContacts,
      childPhotoUrl: child.childPhotoUrl || "",
    });
  };

  const handleProfilePhotoUpload = async (file: File) => {
    setProfilePhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      if (selectedChild?.id) fd.append("registrationId", selectedChild.id);
      const res = await fetch("/api/admin/camp-photos", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      setProfileForm((p) => ({ ...p, childPhotoUrl: url }));
    } catch {
      toast({ title: "Photo upload failed", variant: "destructive" });
    } finally {
      setProfilePhotoUploading(false);
    }
  };

  const updateProfileMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Record<string, any> }) => {
      const res = await apiRequest("PATCH", `/api/admin/children/${id}`, payload);
      return res.json();
    },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/children"] });
      // Update selected child in state so the form reflects new values
      setSelectedChild((prev: any) => prev ? { ...prev, ...updated } : prev);
      setProfileForm((prev) => ({ ...prev, childPhotoUrl: updated.childPhotoUrl || "" }));
      toast({ title: "Profile saved", description: "Changes synced across all camps." });
    },
    onError: () => {
      toast({ title: "Failed to save profile", variant: "destructive" });
    },
  });

  const enrollMutation = useMutation({
    mutationFn: async ({ campId, child }: { campId: string; child: any }) => {
      const payload = {
        mode: "existing",
        childFullName: child.childFullName,
        dateOfBirth: child.dateOfBirth || "",
        primaryLanguage: child.primaryLanguage || null,
        childPhotoUrl: child.childPhotoUrl || null,
        allergies: child.allergies || null,
        foodRestrictions: child.foodRestrictions || null,
        behavioralNotes: child.behavioralNotes || null,
        specialNotes: child.specialNotes || null,
        authorizedPickupPersons: child.authorizedPickupPersons || null,
        parentGuardianName: Array.isArray(child.parentContacts) && child.parentContacts[0]?.name
          ? child.parentContacts[0].name
          : child.parentGuardianName,
        emergencyContactNumber: Array.isArray(child.parentContacts) && child.parentContacts[0]?.phone
          ? child.parentContacts[0].phone
          : child.emergencyContactNumber,
        parentContacts: Array.isArray(child.parentContacts) && child.parentContacts.length > 0
          ? child.parentContacts
          : [{ name: child.parentGuardianName, phone: child.emergencyContactNumber }],
        attendanceDays: [],
      };
      const res = await apiRequest("POST", `/api/admin/events/${campId}/camp-registrations/manager`, payload);
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/children", selectedChild?.id, "history"] });
      setShowEnrollDialog(false);
      setSelectedCampId("");
      toast({
        title: data.merged ? "Days added to existing registration" : "Child enrolled in camp",
        description: data.registration?.childFullName || selectedChild?.childFullName || "",
      });
    },
    onError: () => {
      toast({ title: "Failed to enroll child", variant: "destructive" });
    },
  });

  const closeSheet = () => {
    setSelectedChild(null);
  };

  // ── Merge mode ────────────────────────────────────────────────────────────
  const [isMergeMode, setIsMergeMode] = useState(false);
  const [mergeSelected, setMergeSelected] = useState<string[]>([]); // up to 2 child IDs
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [mergePrimaryId, setMergePrimaryId] = useState<string>(""); // which one to keep
  const [mergeChild1, setMergeChild1] = useState<any | null>(null);
  const [mergeChild2, setMergeChild2] = useState<any | null>(null);

  const toggleMergeMode = () => {
    setIsMergeMode((v) => !v);
    setMergeSelected([]);
    setMergeChild1(null);
    setMergeChild2(null);
    setShowMergeDialog(false);
  };

  const toggleMergeSelect = (childId: string) => {
    setMergeSelected((prev) => {
      if (prev.includes(childId)) return prev.filter((id) => id !== childId);
      if (prev.length >= 2) return prev; // max 2
      return [...prev, childId];
    });
  };

  const openMergeDialog = () => {
    if (mergeSelected.length !== 2) return;
    const c1 = children.find((c) => c.id === mergeSelected[0]);
    const c2 = children.find((c) => c.id === mergeSelected[1]);
    if (!c1 || !c2) return;
    setMergeChild1(c1);
    setMergeChild2(c2);
    setMergePrimaryId(mergeSelected[0]); // default: first selected is primary
    setShowMergeDialog(true);
  };

  // ── Find Duplicates ───────────────────────────────────────────────────────
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [duplicatesEnabled, setDuplicatesEnabled] = useState(false);

  const { data: duplicatesData, isLoading: duplicatesLoading, isError: duplicatesError } = useQuery<{
    pairs: Array<{ a: any; b: any; similarity: number }>;
    total: number;
  }>({
    queryKey: ["/api/admin/children/duplicates"],
    queryFn: async () => {
      const res = await fetch("/api/admin/children/duplicates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to scan for duplicates");
      return res.json();
    },
    enabled: duplicatesEnabled,
    staleTime: 60_000,
  });

  const openDuplicatesDialog = () => {
    setDuplicatesEnabled(true);
    setShowDuplicatesDialog(true);
  };

  const openMergeFromPair = (childA: any, childB: any) => {
    setShowDuplicatesDialog(false);
    setMergeChild1(childA);
    setMergeChild2(childB);
    setMergePrimaryId(childA.id);
    setShowMergeDialog(true);
  };

  // Fetch camp history for both profiles when the merge dialog is open
  const { data: mergeChild1HistoryData, isLoading: mergeChild1HistoryLoading } = useQuery<{ history: any[] }>({
    queryKey: ["/api/admin/children", mergeChild1?.id, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/children/${mergeChild1!.id}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    enabled: showMergeDialog && !!mergeChild1,
  });

  const { data: mergeChild2HistoryData, isLoading: mergeChild2HistoryLoading } = useQuery<{ history: any[] }>({
    queryKey: ["/api/admin/children", mergeChild2?.id, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/children/${mergeChild2!.id}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    enabled: showMergeDialog && !!mergeChild2,
  });

  const mergeHistoryMap: Record<string, any[]> = {
    [mergeChild1?.id ?? ""]: mergeChild1HistoryData?.history ?? [],
    [mergeChild2?.id ?? ""]: mergeChild2HistoryData?.history ?? [],
  };

  const mergeMutation = useMutation({
    mutationFn: async ({ primaryId, secondaryId }: { primaryId: string; secondaryId: string }) => {
      const res = await apiRequest("POST", "/api/admin/children/merge", { primaryId, secondaryId });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/children"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/children/duplicates"] });
      setShowMergeDialog(false);
      setMergeSelected([]);
      setMergeChild1(null);
      setMergeChild2(null);
      setIsMergeMode(false);
      toast({
        title: "Profiles merged",
        description: `${data.merged ?? 0} registration(s) combined into one profile.`,
      });
    },
    onError: () => {
      toast({ title: "Merge failed", variant: "destructive" });
    },
  });

  return (
    <StudioLayout>
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold">Children Database</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              All registered child profiles across every camp
            </p>
          </div>
          {total > 0 && (
            <Badge variant="secondary" className="flex-shrink-0 text-sm px-3 py-1">
              {total} {total === 1 ? "child" : "children"}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="flex-shrink-0"
            onClick={openDuplicatesDialog}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            Find Duplicates
          </Button>
          <Button
            variant={isMergeMode ? "default" : "outline"}
            size="sm"
            className={cn("flex-shrink-0", isMergeMode && "bg-amber-600 hover:bg-amber-700 text-white border-0")}
            onClick={toggleMergeMode}
          >
            {isMergeMode ? <><X className="h-3.5 w-3.5 mr-1" />Cancel</> : <><Merge className="h-3.5 w-3.5 mr-1" />Merge</>}
          </Button>
        </div>

        {/* Merge mode banner */}
        {isMergeMode && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-amber-900">Merge mode — select 2 profiles to combine</p>
              <p className="text-xs text-amber-700 mt-0.5">
                {mergeSelected.length === 0 && "Tap any two cards that belong to the same child."}
                {mergeSelected.length === 1 && "Good — now tap the second duplicate card."}
                {mergeSelected.length === 2 && "Ready to merge. Review and confirm below."}
              </p>
            </div>
            {mergeSelected.length === 2 && (
              <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white flex-shrink-0" onClick={openMergeDialog}>
                <Merge className="h-3.5 w-3.5 mr-1" />
                Merge
              </Button>
            )}
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by child name, parent name, or phone number…"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>

        {/* List */}
        {listLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading…
          </div>
        ) : children.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Baby className="h-10 w-10 mx-auto mb-3 opacity-30" />
            {debouncedSearch ? (
              <>
                <p className="text-sm font-medium">No children match your search</p>
                <p className="text-xs mt-1">Try a different name, parent name, or phone number</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No child profiles yet</p>
                <p className="text-xs mt-1">Profiles appear here once parents register for a camp</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {children.map((child) => {
              const age = calcAge(child.dateOfBirth);
              const hasAllergy = !!child.allergies;
              const hasFood = !!child.foodRestrictions;
              const hasBehavior = !!child.behavioralNotes;
              const isSelected = mergeSelected.includes(child.id);
              const isDisabled = isMergeMode && mergeSelected.length === 2 && !isSelected;
              return (
                <Card
                  key={child.id}
                  className={cn(
                    "transition-colors",
                    isMergeMode
                      ? isDisabled
                        ? "opacity-40 cursor-not-allowed"
                        : "cursor-pointer"
                      : "cursor-pointer hover:bg-accent/40",
                    isSelected && "ring-2 ring-amber-500 bg-amber-50"
                  )}
                  onClick={() => {
                    if (isMergeMode) {
                      if (!isDisabled) toggleMergeSelect(child.id);
                    } else {
                      openChildProfile(child);
                    }
                  }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      {isMergeMode && (
                        <div className={cn(
                          "h-5 w-5 rounded border-2 flex-shrink-0 flex items-center justify-center",
                          isSelected ? "bg-amber-500 border-amber-500" : "border-muted-foreground/40"
                        )}>
                          {isSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                      )}
                      <PhotoAvatar url={child.childPhotoUrl} name={child.childFullName} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm">{child.childFullName}</span>
                          {age !== null && age >= 0 && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
                              {age} yr
                            </Badge>
                          )}
                          {hasAllergy && (
                            <span title={child.allergies} className="text-orange-500">
                              <AlertTriangle className="h-3.5 w-3.5 inline" />
                            </span>
                          )}
                          {hasFood && (
                            <span title={`Food: ${child.foodRestrictions}`} className="text-amber-600 text-xs">
                              🍽
                            </span>
                          )}
                          {hasBehavior && (
                            <span title={child.behavioralNotes} className="text-blue-500">
                              <Info className="h-3.5 w-3.5 inline" />
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          {child.dateOfBirth && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {format(parseISO(child.dateOfBirth), "d MMM yyyy")}
                            </span>
                          )}
                          {(() => {
                            const contacts = Array.isArray(child.parentContacts) && child.parentContacts.length > 0
                              ? child.parentContacts
                              : [{ name: child.parentGuardianName, phone: child.emergencyContactNumber }];
                            return contacts.map((c: any, i: number) => (
                              <span key={i} className="text-xs text-muted-foreground flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {c.name && <span className="font-medium text-foreground/70">{c.name}</span>}
                                {c.name && c.phone && <span>·</span>}
                                {c.phone}
                              </span>
                            ));
                          })()}
                          {child.primaryLanguage && (
                            <span className="text-xs text-muted-foreground">🌐 {child.primaryLanguage}</span>
                          )}
                        </div>
                      </div>
                      {!isMergeMode && <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <p className="text-sm text-muted-foreground">
              Page {page} of {totalPages} · {total} total
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Child Profile Sheet ── */}
      <Sheet open={!!selectedChild} onOpenChange={(open) => { if (!open) closeSheet(); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">
              <Baby className="h-5 w-5 text-teal-600" />
              Child Profile
            </SheetTitle>
            <SheetDescription>
              Edit <strong>{selectedChild?.childFullName}</strong>'s profile — changes sync across all camps.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 py-4">
            <ChildProfileEditor
              form={profileForm}
              onChange={(updates) => setProfileForm((p) => ({ ...p, ...updates }))}
              onPhotoUpload={handleProfilePhotoUpload}
              photoUploading={profilePhotoUploading}
            />

            {/* Save buttons */}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={closeSheet}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={
                  !profileForm.childFullName.trim() ||
                  !profileForm.parentContacts[0]?.name?.trim() ||
                  !profileForm.parentContacts[0]?.phone?.trim() ||
                  updateProfileMutation.isPending ||
                  profilePhotoUploading
                }
                onClick={() => {
                  if (!selectedChild) return;
                  updateProfileMutation.mutate({
                    id: selectedChild.id,
                    payload: {
                      childFullName: profileForm.childFullName.trim(),
                      dateOfBirth: profileForm.dateOfBirth || null,
                      primaryLanguage: profileForm.primaryLanguage.trim() || null,
                      allergies: profileForm.allergies.trim() || null,
                      foodRestrictions: profileForm.foodRestrictions.trim() || null,
                      behavioralNotes: profileForm.behavioralNotes.trim() || null,
                      specialNotes: profileForm.specialNotes.trim() || null,
                      authorizedPickupPersons: profileForm.authorizedPickupPersons.trim() || null,
                      parentContacts: profileForm.parentContacts.filter(c => c.phone.trim() || c.name.trim()),
                      childPhotoUrl: profileForm.childPhotoUrl || null,
                    },
                  });
                }}
              >
                {updateProfileMutation.isPending ? "Saving…" : "Save Profile"}
              </Button>
            </div>

            <div className="border-t border-dashed" />

            {/* Camp History */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Tent className="h-4 w-4 text-teal-600" />
                  Camp History
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    setSelectedCampId("");
                    setShowEnrollDialog(true);
                  }}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Enroll in Camp
                </Button>
              </div>

              {historyLoading ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading history…
                </div>
              ) : !historyData || historyData.history.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">No camp registrations found.</p>
              ) : (
                <div className="space-y-2">
                  {historyData.history.map((item: any) => {
                    const ev = item.event;
                    const days = Array.isArray(item.attendanceDays) ? item.attendanceDays : [];
                    return (
                      <div
                        key={item.id}
                        className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-1 cursor-pointer hover:bg-accent/30 transition-colors"
                        onClick={() => {
                          if (ev?.id) {
                            closeSheet();
                            navigate(`/studio/events/camp/${ev.id}`);
                          }
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{ev?.title ?? "Unknown Camp"}</p>
                            {ev?.branchId && branchName(ev.branchId) && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <MapPin className="h-3 w-3 flex-shrink-0" />
                                {branchName(ev.branchId)}
                              </p>
                            )}
                          </div>
                          {ev?.status && ev.status !== "upcoming" && (
                            <Badge
                              variant={ev.status === "cancelled" ? "destructive" : "secondary"}
                              className="text-xs flex-shrink-0"
                            >
                              {ev.status}
                            </Badge>
                          )}
                        </div>
                        {ev?.eventDate && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {format(parseISO(ev.eventDate), "d MMM yyyy")}
                            {ev.campEndDate && ev.campEndDate !== ev.eventDate && (
                              <> → {format(parseISO(ev.campEndDate), "d MMM yyyy")}</>
                            )}
                          </p>
                        )}
                        {days.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {days.length} day{days.length !== 1 ? "s" : ""} registered
                          </p>
                        )}
                        {item.isOneTime && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-amber-400 text-amber-600 bg-amber-50">
                            One-Time
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Enroll in Camp Dialog ── */}
      <Dialog open={showEnrollDialog} onOpenChange={(open) => { if (!open) { setShowEnrollDialog(false); setSelectedCampId(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-teal-600" />
              Enroll in Camp
            </DialogTitle>
            <DialogDescription>
              Enroll <strong>{selectedChild?.childFullName}</strong> in an existing camp. Their profile details will be copied automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Select Camp</Label>
              <Select value={selectedCampId} onValueChange={setSelectedCampId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a camp…" />
                </SelectTrigger>
                <SelectContent>
                  {openCamps.length === 0 ? (
                    <div className="py-3 text-center text-sm text-muted-foreground">No open camps available</div>
                  ) : (
                    openCamps.map((camp: any) => (
                      <SelectItem key={camp.id} value={camp.id}>
                        <div className="flex flex-col items-start">
                          <span>{camp.title}</span>
                          {camp.eventDate && (
                            <span className="text-xs text-muted-foreground">
                              {format(parseISO(camp.eventDate), "d MMM yyyy")}
                              {branchName(camp.branchId) ? ` · ${branchName(camp.branchId)}` : ""}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              The child's profile — name, DOB, allergies, emergency contact — will be pre-filled from their saved profile. You can adjust attendance days from the camp's detail page afterward.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowEnrollDialog(false); setSelectedCampId(""); }}
            >
              Cancel
            </Button>
            <Button
              disabled={!selectedCampId || enrollMutation.isPending}
              onClick={() => {
                if (!selectedCampId || !selectedChild) return;
                enrollMutation.mutate({ campId: selectedCampId, child: selectedChild });
              }}
            >
              {enrollMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Enrolling…</>
              ) : (
                <><Check className="h-4 w-4 mr-1" /> Enroll</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Find Duplicates Dialog ── */}
      <Dialog open={showDuplicatesDialog} onOpenChange={(open) => { if (!open) setShowDuplicatesDialog(false); }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              Find Duplicate Profiles
            </DialogTitle>
            <DialogDescription>
              Scans all child profiles for likely duplicates based on similar name and date of birth. Review each pair and merge if they belong to the same child.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0">
            {duplicatesLoading ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-sm">Scanning for duplicates…</p>
              </div>
            ) : duplicatesError ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <AlertTriangle className="h-8 w-8 text-destructive/60" />
                <p className="text-sm font-medium text-destructive">Scan failed</p>
                <p className="text-xs text-muted-foreground">Unable to load duplicate candidates. Please try again.</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => {
                  setDuplicatesEnabled(false);
                  setTimeout(() => setDuplicatesEnabled(true), 50);
                }}>Retry</Button>
              </div>
            ) : !duplicatesData || duplicatesData.pairs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <Check className="h-8 w-8 text-green-500" />
                <p className="text-sm font-medium">No likely duplicates found</p>
                <p className="text-xs">All profiles appear to be unique.</p>
              </div>
            ) : (
              <div className="space-y-3 py-2">
                <p className="text-xs text-muted-foreground px-1">
                  {duplicatesData.total} candidate pair{duplicatesData.total !== 1 ? "s" : ""} found
                  {duplicatesData.total > 100 ? " — showing top 100" : ""}.
                  Review each pair and merge if they are the same child.
                </p>
                {duplicatesData.pairs.map((pair, idx) => (
                  <div
                    key={`${pair.a.id}-${pair.b.id}`}
                    className="rounded-lg border border-border bg-muted/30 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground font-medium">
                        Match #{idx + 1} · {Math.round(pair.similarity * 100)}% similar
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                        onClick={() => openMergeFromPair(pair.a, pair.b)}
                      >
                        <Merge className="h-3 w-3" />
                        Review &amp; Merge
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {[pair.a, pair.b].map((child) => (
                        <div
                          key={child.id}
                          className="rounded-md border border-border bg-background p-2.5 space-y-1.5"
                        >
                          <div className="flex items-center gap-2">
                            <PhotoAvatar url={child.childPhotoUrl} name={child.childFullName} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold leading-tight">{child.childFullName}</p>
                              {child.dateOfBirth && (
                                <p className="text-[11px] text-muted-foreground">
                                  {format(parseISO(child.dateOfBirth), "d MMM yyyy")}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="space-y-0.5 text-[11px] text-muted-foreground">
                            {(() => {
                              const contacts = Array.isArray(child.parentContacts) && child.parentContacts.length > 0
                                ? child.parentContacts
                                : [{ name: child.parentGuardianName, phone: child.emergencyContactNumber }];
                              return contacts.map((c: any, i: number) => (
                                <p key={i} className="flex items-center gap-1">
                                  <Phone className="h-3 w-3 flex-shrink-0" />
                                  {c.name && <span className="font-medium">{c.name}</span>}
                                  {c.name && c.phone && <span>·</span>}
                                  <span>{c.phone}</span>
                                </p>
                              ));
                            })()}
                            {child.primaryLanguage && (
                              <p>🌐 {child.primaryLanguage}</p>
                            )}
                          </div>
                          {(child.allergies || child.foodRestrictions || child.behavioralNotes || child.specialNotes || child.authorizedPickupPersons) && (
                            <div className="border-t border-dashed pt-1.5 space-y-0.5 text-[11px]">
                              {child.allergies && (
                                <p className="text-orange-600">⚠ Allergies: {child.allergies}</p>
                              )}
                              {child.foodRestrictions && (
                                <p className="text-amber-700">🍽 Food: {child.foodRestrictions}</p>
                              )}
                              {child.behavioralNotes && (
                                <p className="text-blue-700">ℹ Behavioral: {child.behavioralNotes}</p>
                              )}
                              {child.specialNotes && (
                                <p className="text-muted-foreground">📝 Notes: {child.specialNotes}</p>
                              )}
                              {child.authorizedPickupPersons && (
                                <p className="text-muted-foreground">👥 Pickup: {child.authorizedPickupPersons}</p>
                              )}
                            </div>
                          )}
                          {child.registrationCount != null && (
                            <div className="border-t border-dashed pt-1.5">
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                                <Tent className="h-2.5 w-2.5 mr-0.5" />
                                {child.registrationCount} camp{child.registrationCount !== 1 ? "s" : ""}
                              </Badge>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => setShowDuplicatesDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Merge Confirmation Dialog ── */}
      <Dialog open={showMergeDialog} onOpenChange={(open) => { if (!open) setShowMergeDialog(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Merge className="h-5 w-5 text-amber-600" />
              Merge Profiles
            </DialogTitle>
            <DialogDescription>
              Choose which profile to keep. The other profile's camp registrations will be moved to the chosen one, and their parent contact will be saved in authorized pickup contacts.
            </DialogDescription>
          </DialogHeader>

          {mergeChild1 && mergeChild2 && (
            <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
              <p className="text-xs text-muted-foreground">Click the profile you want to keep as the primary record. The other profile's registrations will be moved into it.</p>

              {/* Profile picker — full field comparison */}
              <div className="grid grid-cols-2 gap-3">
                {[mergeChild1, mergeChild2].map((child) => {
                  const isPrimary = mergePrimaryId === child.id;
                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => setMergePrimaryId(child.id)}
                      className={cn(
                        "rounded-lg border-2 p-3 text-left transition-colors w-full",
                        isPrimary
                          ? "border-amber-500 bg-amber-50"
                          : "border-muted hover:border-muted-foreground/40"
                      )}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <PhotoAvatar url={child.childPhotoUrl} name={child.childFullName} />
                        <div className={cn("h-4 w-4 rounded-full border-2 flex-shrink-0 ml-auto", isPrimary ? "border-amber-500 bg-amber-500" : "border-muted-foreground/40")} />
                      </div>

                      <p className="text-sm font-semibold leading-tight">{child.childFullName}</p>
                      {child.dateOfBirth && (
                        <p className="text-xs text-muted-foreground mt-0.5">{format(parseISO(child.dateOfBirth), "d MMM yyyy")}</p>
                      )}
                      {child.primaryLanguage && (
                        <p className="text-xs text-muted-foreground">🌐 {child.primaryLanguage}</p>
                      )}

                      <div className="border-t border-dashed mt-2 pt-2 space-y-0.5 text-xs text-muted-foreground">
                        {(() => {
                          const contacts = Array.isArray(child.parentContacts) && child.parentContacts.length > 0
                            ? child.parentContacts
                            : [{ name: child.parentGuardianName, phone: child.emergencyContactNumber }];
                          return contacts.map((c: any, i: number) => (
                            <p key={i} className="flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {c.name && <span className="font-medium">{c.name}</span>}
                              {c.name && c.phone && <span>·</span>}
                              <span>{c.phone}</span>
                            </p>
                          ));
                        })()}
                      </div>

                      {(child.allergies || child.foodRestrictions || child.behavioralNotes || child.specialNotes || child.authorizedPickupPersons) && (
                        <div className="border-t border-dashed mt-2 pt-2 space-y-0.5 text-xs">
                          {child.allergies && <p className="text-orange-600">⚠ {child.allergies}</p>}
                          {child.foodRestrictions && <p className="text-amber-700">🍽 {child.foodRestrictions}</p>}
                          {child.behavioralNotes && <p className="text-blue-700">ℹ {child.behavioralNotes}</p>}
                          {child.specialNotes && <p className="text-muted-foreground">📝 {child.specialNotes}</p>}
                          {child.authorizedPickupPersons && <p className="text-muted-foreground">👥 {child.authorizedPickupPersons}</p>}
                        </div>
                      )}

                      {/* Camp history for this profile */}
                      <div className="border-t border-dashed mt-2 pt-2">
                        <p className="text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                          <Tent className="h-3 w-3" /> Camp History
                        </p>
                        {(child.id === mergeChild1?.id ? mergeChild1HistoryLoading : mergeChild2HistoryLoading) ? (
                          <p className="text-[11px] text-muted-foreground italic">Loading…</p>
                        ) : (() => {
                          const history = mergeHistoryMap[child.id] ?? [];
                          if (history.length === 0) return <p className="text-[11px] text-muted-foreground italic">No registrations</p>;
                          return (
                            <div className="space-y-0.5">
                              {history.map((item: any) => (
                                <div key={item.id} className="text-[11px] text-muted-foreground">
                                  <span className="font-medium text-foreground truncate block">
                                    {item.event?.title ?? "Unknown camp"}
                                  </span>
                                  {item.event?.eventDate && (
                                    <span className="text-[10px]">
                                      {format(parseISO(item.event.eventDate), "d MMM yyyy")}
                                      {item.event.campEndDate && item.event.campEndDate !== item.event.eventDate
                                        ? ` – ${format(parseISO(item.event.campEndDate), "d MMM")}`
                                        : ""}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>

                      {isPrimary && (
                        <Badge className="mt-2 text-xs bg-amber-500 hover:bg-amber-500 text-white w-full justify-center">Keep this profile</Badge>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* What happens summary */}
              {(() => {
                const primary = mergePrimaryId === mergeChild1.id ? mergeChild1 : mergeChild2;
                const secondary = mergePrimaryId === mergeChild1.id ? mergeChild2 : mergeChild1;
                return (
                  <div className="rounded-lg bg-muted/60 border border-border px-4 py-3 space-y-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{secondary.childFullName}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{primary.childFullName}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      All camp registrations under <strong>{secondary.childFullName}</strong> will use{" "}
                      <strong>{primary.childFullName}</strong>'s profile going forward.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <strong>{secondary.parentGuardianName}</strong> ({secondary.emergencyContactNumber}) will be added to authorized pickup contacts so neither phone number is lost.
                    </p>
                  </div>
                );
              })()}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMergeDialog(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              disabled={!mergePrimaryId || !mergeChild1 || !mergeChild2 || mergeMutation.isPending}
              onClick={() => {
                if (!mergePrimaryId || !mergeChild1 || !mergeChild2) return;
                const secondaryId =
                  mergeChild1.id === mergePrimaryId ? mergeChild2.id : mergeChild1.id;
                mergeMutation.mutate({ primaryId: mergePrimaryId, secondaryId });
              }}
            >
              {mergeMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Merging…</>
              ) : (
                <><Merge className="h-4 w-4 mr-1" /> Confirm Merge</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
