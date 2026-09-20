import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { ClipboardList, Lock, Plus, Trash2, Clock, User, Users, Building2, MapPin, Camera, Image, ChevronDown, ChevronUp, Pencil, Upload, ClipboardCheck, GripVertical, Wrench } from "lucide-react";
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MediaUploadButton, MediaPreviewStrip, MediaDropZone, UploadingFilesPreview, UploadStatusBanner, type ChecklistAttachment } from "@/components/media";
import { uploadQueue } from "@/lib/uploadQueue";

interface Employee {
  id: string;
  fullName: string;
  nickname?: string | null;
  branchId?: string | null;
  status?: string;
}

interface Role {
  id: string;
  name: string;
}

interface Branch {
  id: string;
  name: string;
}

interface Location {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentName: string | null;
  isActive: boolean;
}

interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  branchId: string | null;
  branchIds?: string[] | null;
  departmentId: string | null;
  recurrence: string | null;
  scheduledTime: string | null;
  assignedEmployeeId: string | null;
  assignedRoleId: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ChecklistItem {
  id?: string;
  title: string;
  description?: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
  cameraEnabled?: boolean;
  galleryEnabled?: boolean;
  isCritical?: boolean;
  linkedToFix?: boolean;
  referenceMediaUrls?: string[];
  expanded?: boolean;
  departmentId?: string;
  zoneLabel?: string;
}

interface CreateFormValues {
  name: string;
  description: string;
  branchIds: string[];
  recurrence: string;
  weeklyDays: string[];
  monthlyDay: number | null;
  scheduledTime: string;
  assignmentType: "everyone" | "employee" | "role" | "department";
  assignedEmployeeId: string;
  assignedRoleId: string;
  assignedDepartmentId: string;
  locationId: string;
  checklistType: "operational" | "checker";
  checkerRounds: number;
  scheduleTime1: string;
  scheduleTime2: string;
  scheduleTime3: string;
  scheduleTime4: string;
  scheduleTime5: string;
}

// Days of month for monthly recurrence (1-31)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

const WEEKDAYS = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
];

function SortableChecklistItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 50 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div className="flex items-start gap-0">
        <button
          type="button"
          className="mt-2 p-1 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground touch-none"
          {...attributes}
          {...listeners}
          data-testid={`drag-handle-${id}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

export default function StudioChecklistsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin" || user?.role === "global_admin" || user?.role === "operator_admin";
  const isManager = user?.role === "manager";
  const canCreate = isAdmin || isManager;
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingChecklist, setEditingChecklist] = useState<ChecklistTemplate | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") === "true") {
      setShowCreateDialog(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const [items, setItems] = useState<ChecklistItem[]>([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
  const [headerAttachments, setHeaderAttachments] = useState<ChecklistAttachment[]>([]);
  const [itemAttachments, setItemAttachments] = useState<Record<string, ChecklistAttachment[]>>({});
  
  // For uploads during checklist creation (before the checklist exists)
  const [pendingChecklistId, setPendingChecklistId] = useState<string | null>(null);
  const [pendingHeaderAttachments, setPendingHeaderAttachments] = useState<ChecklistAttachment[]>([]);
  const [pendingItemAttachments, setPendingItemAttachments] = useState<Record<number, ChecklistAttachment[]>>({});
  const [historyChecklistId, setHistoryChecklistId] = useState<string | null>(null);
  const editQueryHandledRef = useRef(false);
  
  // Track active uploads and waiting state
  const [activeUploadCount, setActiveUploadCount] = useState(0);
  const [waitingForUploads, setWaitingForUploads] = useState(false);
  const pendingFormDataRef = useRef<CreateFormValues | null>(null);
  
  // Subscribe to upload queue changes
  useEffect(() => {
    console.log("[Checklists] Subscribing to upload queue");
    return uploadQueue.subscribe((items) => {
      const activeCount = items.filter(
        i => i.status === "pending" || i.status === "uploading" || i.status === "confirming"
      ).length;
      console.log("[Checklists] Upload queue items:", items.length, "active:", activeCount);
      setActiveUploadCount(activeCount);
    });
  }, []);
  
  // When waiting for uploads and they complete, submit the form
  useEffect(() => {
    if (waitingForUploads && activeUploadCount === 0 && pendingFormDataRef.current) {
      setWaitingForUploads(false);
      createMutation.mutate(pendingFormDataRef.current);
      pendingFormDataRef.current = null;
    }
  }, [waitingForUploads, activeUploadCount]);

  const form = useForm<CreateFormValues>({
    defaultValues: {
      name: "",
      description: "",
      branchIds: [],
      recurrence: "daily",
      weeklyDays: [],
      monthlyDay: null,
      scheduledTime: "09:00",
      assignmentType: "everyone",
      assignedEmployeeId: "",
      assignedRoleId: "",
      assignedDepartmentId: "",
      locationId: "",
      checklistType: "operational",
      checkerRounds: 2,
      scheduleTime1: "10:30",
      scheduleTime2: "15:30",
      scheduleTime3: "18:00",
      scheduleTime4: "20:00",
      scheduleTime5: "22:00",
    },
  });

  const assignmentType = form.watch("assignmentType");
  const selectedBranchIds = form.watch("branchIds");
  const recurrence = form.watch("recurrence");
  const checklistType = form.watch("checklistType");
  const checkerRounds = form.watch("checkerRounds");

  const toggleBranch = (branchId: string) => {
    const current = form.getValues("branchIds");
    if (current.includes(branchId)) {
      form.setValue("branchIds", current.filter(id => id !== branchId));
      form.setValue("assignedEmployeeId", ""); // Reset employee when changing branches
    } else {
      form.setValue("branchIds", [...current, branchId]);
      form.setValue("assignedEmployeeId", ""); // Reset employee when changing branches
    }
  };

  const toggleAllBranches = () => {
    const allBranchIds = branches.map(b => b.id);
    const current = form.getValues("branchIds");
    if (current.length === allBranchIds.length) {
      // All selected, deselect all
      form.setValue("branchIds", []);
    } else {
      // Select all
      form.setValue("branchIds", allBranchIds);
    }
    form.setValue("assignedEmployeeId", ""); // Reset employee when changing branches
  };

  const { data: checklists, isLoading } = useQuery<ChecklistTemplate[]>({
    queryKey: ["/api/checklists/templates"],
    enabled: !!user,
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
    enabled: !!user,
  });

  const { data: roles } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
    enabled: !!user,
  });

  // Filter employees: only active ones, and by branch when one is selected
  const filteredEmployees = (employees || [])
    .filter(emp => emp.status === "active") // Only show active employees
    .filter(emp => {
      if (selectedBranchIds.length === 0) return true; // No branch filter
      if (selectedBranchIds.length === 1) return emp.branchId === selectedBranchIds[0];
      return selectedBranchIds.includes(emp.branchId || ""); // Multiple branches selected
    });

  const { data: departments } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/departments"],
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/studio/branches"],
    enabled: !!user,
  });

  const allBranchesSelected = branches.length > 0 && selectedBranchIds.length === branches.length;

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
    enabled: !!user,
  });

  interface CheckerHistoryRun {
    id: string;
    branchId: string;
    completedAt: string;
    passCount: number;
    failCount: number;
    totalItems: number;
    hasFailures: boolean;
  }

  const { data: historyData, isLoading: historyLoading, error: historyError } = useQuery<{ templateName: string; runs: CheckerHistoryRun[] }>({
    queryKey: ["/api/checklists/checker-history", historyChecklistId],
    enabled: !!historyChecklistId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateFormValues) => {
      const validItems = items.filter((i) => i.title.trim()).map(item => ({
        title: item.title,
        description: item.description,
        requiresNote: item.requiresNote === true,
        requiresPhoto: item.requiresPhoto === true,
        cameraEnabled: item.cameraEnabled ?? true,
        galleryEnabled: item.galleryEnabled ?? false,
        isCritical: item.isCritical === true,
        linkedToFix: data.checklistType === "operational" && item.linkedToFix === true,
        referenceMediaUrls: item.referenceMediaUrls?.filter(url => url.trim()) || [],
        departmentId: item.departmentId || undefined,
        zoneLabel: item.zoneLabel || undefined,
      }));
      const payload: any = {
        name: data.name,
        description: data.description,
        recurrence: data.recurrence,
        scheduledTime: data.scheduledTime,
        items: validItems,
        checklistType: data.checklistType,
      };
      // For checker type, add schedule times based on rounds
      if (data.checklistType === "checker") {
        payload.checkerRounds = data.checkerRounds;
        if (data.checkerRounds >= 1) payload.scheduleTime1 = data.scheduleTime1;
        if (data.checkerRounds >= 2) payload.scheduleTime2 = data.scheduleTime2;
        if (data.checkerRounds >= 3) payload.scheduleTime3 = data.scheduleTime3;
        if (data.checkerRounds >= 4) payload.scheduleTime4 = data.scheduleTime4;
        if (data.checkerRounds >= 5) payload.scheduleTime5 = data.scheduleTime5;
      }
      if (data.locationId && data.locationId !== "__none__") {
        payload.locationId = data.locationId;
      }
      if (data.recurrence === "weekly" && data.weeklyDays.length > 0) {
        payload.weeklyDays = data.weeklyDays;
      }
      if (data.recurrence === "monthly" && data.monthlyDay) {
        payload.monthlyDay = data.monthlyDay;
      }
      if (data.branchIds.length > 0) {
        payload.branchIds = data.branchIds;
      }
      if (data.assignmentType === "employee" && data.assignedEmployeeId) {
        payload.assignedEmployeeId = data.assignedEmployeeId;
      }
      if (data.assignmentType === "role" && data.assignedRoleId) {
        payload.assignedRoleId = data.assignedRoleId;
      }
      if (data.assignmentType === "department" && data.assignedDepartmentId) {
        payload.assignedDepartmentId = data.assignedDepartmentId;
      }
      const res = await apiRequest("POST", "/api/checklists/templates", payload);
      return res.json();
    },
    onSuccess: async (newTemplate: ChecklistTemplate) => {
      // Associate any pending media uploads with the newly created checklist
      if (pendingChecklistId && (pendingHeaderAttachments.length > 0 || Object.keys(pendingItemAttachments).length > 0)) {
        try {
          // Build item mappings: pendingItemIndex -> actual item ID
          const itemIdMappings: { pendingItemIndex: number; checklistTemplateItemId: string }[] = [];
          if (newTemplate.items?.length) {
            newTemplate.items.forEach((item: any, index: number) => {
              if (item.id) {
                itemIdMappings.push({
                  pendingItemIndex: index,
                  checklistTemplateItemId: item.id,
                });
              }
            });
          }
          
          await apiRequest("POST", "/api/checklist-media/associate-pending", {
            pendingChecklistId,
            checklistTemplateId: newTemplate.id,
            itemIdMappings,
          });
        } catch (error) {
          console.error("Failed to associate pending media:", error);
        }
      }
      
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      setShowCreateDialog(false);
      form.reset();
      setItems([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
      setPendingChecklistId(null);
      setPendingHeaderAttachments([]);
      setPendingItemAttachments({});
      toast({ 
        title: "Checklist template created",
        description: pendingHeaderAttachments.length > 0 || Object.keys(pendingItemAttachments).length > 0 
          ? "Media attachments have been saved." 
          : undefined,
      });
    },
    onError: (error: any) => {
      toast({ title: error?.message || "Failed to create checklist", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: CreateFormValues }) => {
      const validItems = items.filter((i) => i.title.trim()).map(item => ({
        id: item.id,
        title: item.title,
        description: item.description,
        requiresNote: item.requiresNote === true,
        requiresPhoto: item.requiresPhoto === true,
        cameraEnabled: item.cameraEnabled ?? true,
        galleryEnabled: item.galleryEnabled ?? false,
        isCritical: item.isCritical === true,
        linkedToFix: data.checklistType === "operational" && item.linkedToFix === true,
        departmentId: item.departmentId,
        zoneLabel: item.zoneLabel,
        referenceMediaUrls: item.referenceMediaUrls?.filter(url => url.trim()) || [],
      }));
      const payload: any = {
        name: data.name,
        description: data.description,
        recurrence: data.recurrence,
        scheduledTime: data.scheduledTime,
        items: validItems,
        isActive: true,
      };
      if (data.locationId && data.locationId !== "__none__") {
        payload.locationId = data.locationId;
      } else {
        payload.locationId = null;
      }
      if (data.recurrence === "weekly" && data.weeklyDays.length > 0) {
        payload.weeklyDays = data.weeklyDays;
      }
      if (data.recurrence === "monthly" && data.monthlyDay) {
        payload.monthlyDay = data.monthlyDay;
      }
      if (data.branchIds.length > 0) {
        payload.branchId = data.branchIds[0];
        payload.branchIds = data.branchIds;
      }
      switch (data.assignmentType) {
        case "employee":
          payload.assignedEmployeeId = data.assignedEmployeeId;
          payload.assignedRoleId = null;
          payload.assignedDepartmentId = null;
          break;
        case "role":
          payload.assignedRoleId = data.assignedRoleId;
          payload.assignedEmployeeId = null;
          payload.assignedDepartmentId = null;
          break;
        case "department":
          payload.assignedDepartmentId = data.assignedDepartmentId;
          payload.assignedEmployeeId = null;
          payload.assignedRoleId = null;
          break;
        default:
          payload.assignedEmployeeId = null;
          payload.assignedRoleId = null;
          payload.assignedDepartmentId = null;
      }
      // Include checker-specific fields
      payload.checklistType = data.checklistType;
      if (data.checklistType === "checker") {
        payload.checkerRounds = data.checkerRounds;
        payload.scheduleTime1 = data.scheduleTime1 || null;
        payload.scheduleTime2 = data.scheduleTime2 || null;
        payload.scheduleTime3 = data.scheduleTime3 || null;
        payload.scheduleTime4 = data.scheduleTime4 || null;
        payload.scheduleTime5 = data.scheduleTime5 || null;
      }
      const response = await apiRequest("PATCH", `/api/checklists/templates/${id}`, payload);
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      queryClient.invalidateQueries({ predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === 'string' && (key.startsWith('/api/dashboard/checklists') || key.startsWith('/api/checklist-runs'));
      }});
      setShowEditDialog(false);
      setEditingChecklist(null);
      form.reset();
      setItems([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
      setHeaderAttachments([]);
      const propagated = data?.propagatedRunCount || 0;
      toast({ 
        title: "Checklist template updated",
        description: propagated > 0 
          ? `Version ${data?.templateVersion || ''}. Changes propagated to ${propagated} active run${propagated > 1 ? 's' : ''}.`
          : undefined,
      });
    },
    onError: () => {
      toast({ title: "Failed to update checklist", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/checklists/templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      toast({ title: "Checklist template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete checklist", variant: "destructive" });
    },
  });

  const handleDelete = (checklist: ChecklistTemplate) => {
    if (window.confirm(`Are you sure you want to delete "${checklist.name}"? This cannot be undone.`)) {
      deleteMutation.mutate(checklist.id);
    }
  };

  const openEditDialog = async (checklist: ChecklistTemplate) => {
    setEditingChecklist(checklist);
    // Fetch checklist items
    try {
      const res = await fetch(`/api/checklists/templates/${checklist.id}`, { credentials: "include" });
      const data = await res.json();
      const checklistItems = data.items || [];
      setItems(checklistItems.length > 0
        ? checklistItems.map((item: ChecklistItem) => ({
            ...item,
            cameraEnabled: item.cameraEnabled ?? true,
            galleryEnabled: item.galleryEnabled ?? false,
          }))
        : [{ title: "", cameraEnabled: true, galleryEnabled: false }]);
    } catch {
      setItems([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
    }
    
    // Fetch header attachments
    try {
      const mediaRes = await fetch(`/api/checklist-media/by-template/${checklist.id}`, { credentials: "include" });
      if (mediaRes.ok) {
        const mediaData = await mediaRes.json();
        setHeaderAttachments(mediaData.attachments || []);
      } else {
        setHeaderAttachments([]);
      }
    } catch {
      setHeaderAttachments([]);
    }
    
    // Fetch item attachments
    try {
      const itemMediaRes = await fetch(`/api/checklist-media/items-by-template/${checklist.id}`, { credentials: "include" });
      if (itemMediaRes.ok) {
        const itemMediaData = await itemMediaRes.json();
        setItemAttachments(itemMediaData.attachmentsByItem || {});
      } else {
        setItemAttachments({});
      }
    } catch {
      setItemAttachments({});
    }
    
    // Determine assignment type
    let assignmentType: "everyone" | "employee" | "role" | "department" = "everyone";
    if ((checklist as any).assignedEmployeeId) assignmentType = "employee";
    else if ((checklist as any).assignedRoleId) assignmentType = "role";
    else if ((checklist as any).assignedDepartmentId) assignmentType = "department";
    
    form.reset({
      name: checklist.name,
      description: checklist.description || "",
      branchIds: checklist.branchIds || (checklist.branchId ? [checklist.branchId] : []),
      recurrence: checklist.recurrence || "daily",
      weeklyDays: (checklist as any).weeklyDays || [],
      monthlyDay: (checklist as any).monthlyDay || null,
      scheduledTime: checklist.scheduledTime || "09:00",
      assignmentType,
      assignedEmployeeId: (checklist as any).assignedEmployeeId || "",
      assignedRoleId: (checklist as any).assignedRoleId || "",
      assignedDepartmentId: (checklist as any).assignedDepartmentId || "",
      locationId: (checklist as any).locationId || "",
      checklistType: (checklist as any).checklistType || "operational",
      checkerRounds: (checklist as any).checkerRounds || 2,
      scheduleTime1: (checklist as any).scheduleTime1 || "10:30",
      scheduleTime2: (checklist as any).scheduleTime2 || "15:30",
      scheduleTime3: (checklist as any).scheduleTime3 || "18:00",
      scheduleTime4: (checklist as any).scheduleTime4 || "20:00",
      scheduleTime5: (checklist as any).scheduleTime5 || "22:00",
    });
    setShowEditDialog(true);
  };

  useEffect(() => {
    if (editQueryHandledRef.current || !checklists?.length) return;
    const editId = new URLSearchParams(window.location.search).get("edit");
    if (!editId) return;
    const checklist = checklists.find((candidate) => candidate.id === editId);
    editQueryHandledRef.current = true;
    window.history.replaceState({}, "", window.location.pathname);
    if (checklist) void openEditDialog(checklist);
  }, [checklists]);

  const onEditSubmit = (data: CreateFormValues) => {
    if (!editingChecklist) return;
    if (!data.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const validItems = items.filter((i) => i.title.trim());
    if (validItems.length === 0) {
      toast({ title: "At least one item is required", variant: "destructive" });
      return;
    }
    const invalidPhotoItem = validItems.find(item =>
      item.requiresPhoto && item.cameraEnabled === false
      && item.galleryEnabled === false
    );
    if (invalidPhotoItem) {
      toast({ title: `"${invalidPhotoItem.title}" requires a photo. Enable Camera or Gallery.`, variant: "destructive" });
      return;
    }
    updateMutation.mutate({ id: editingChecklist.id, data });
  };

  const addItem = () => {
    setItems([...items, { title: "", requiresNote: false, requiresPhoto: false, cameraEnabled: true, galleryEnabled: false, isCritical: false, linkedToFix: false }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, updates: Partial<ChecklistItem>) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], ...updates };
    setItems(newItems);
  };

  const toggleItemExpanded = (index: number) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], expanded: !newItems[index].expanded };
    setItems(newItems);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((_, i) => `item-${i}` === active.id);
      const newIndex = items.findIndex((_, i) => `item-${i}` === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setItems(arrayMove(items, oldIndex, newIndex));
      }
    }
  };

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const onSubmit = (data: CreateFormValues) => {
    if (!data.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const validItems = items.filter((i) => i.title.trim());
    if (validItems.length === 0) {
      toast({ title: "At least one item is required", variant: "destructive" });
      return;
    }
    const invalidPhotoItem = validItems.find(item =>
      item.requiresPhoto && item.cameraEnabled === false
      && item.galleryEnabled === false
    );
    if (invalidPhotoItem) {
      toast({ title: `"${invalidPhotoItem.title}" requires a photo. Enable Camera or Gallery.`, variant: "destructive" });
      return;
    }
    if (data.assignmentType === "employee" && !data.assignedEmployeeId) {
      toast({ title: "Please select an employee", variant: "destructive" });
      return;
    }
    if (data.assignmentType === "role" && !data.assignedRoleId) {
      toast({ title: "Please select a role", variant: "destructive" });
      return;
    }
    if (data.assignmentType === "department" && !data.assignedDepartmentId) {
      toast({ title: "Please select a department", variant: "destructive" });
      return;
    }
    
    // If uploads are in progress, wait for them to complete
    if (activeUploadCount > 0) {
      pendingFormDataRef.current = data;
      setWaitingForUploads(true);
      return;
    }
    
    createMutation.mutate(data);
  };

  const getRecurrenceLabel = (recurrence: string | null) => {
    switch (recurrence) {
      case "daily":
        return "Daily";
      case "weekly":
        return "Weekly";
      case "monthly":
        return "Monthly";
      case "once":
        return "One-time";
      default:
        return recurrence || "Not set";
    }
  };

  const getAssignmentLabel = (checklist: ChecklistTemplate) => {
    if (checklist.assignedEmployeeId) {
      const emp = employees?.find(e => e.id === checklist.assignedEmployeeId);
      return emp ? (emp.nickname || emp.fullName) : "Specific employee";
    }
    if (checklist.assignedRoleId) {
      const role = roles?.find(r => r.id === checklist.assignedRoleId);
      return role ? role.name : "Specific role";
    }
    return null;
  };

  if (isLoading) {
    return (
      <StudioLayout>
        <LoadingScreen />
      </StudioLayout>
    );
  }

  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold">Checklists</h1>
          {canCreate ? (
            <Button
              size="sm"
              onClick={() => {
                setPendingChecklistId(crypto.randomUUID());
                setPendingHeaderAttachments([]);
                setPendingItemAttachments({});
                setShowCreateDialog(true);
              }}
              data-testid="button-create-checklist"
            >
              <Plus className="h-4 w-4 mr-1" />
              Create
            </Button>
          ) : (
            <Badge variant="secondary" className="flex items-center gap-1">
              <Lock className="h-3 w-3" />
              View Only
            </Badge>
          )}
        </div>

        {!canCreate && (
          <Card className="mb-4 bg-muted/50">
            <CardContent className="p-3 text-sm text-muted-foreground">
              Checklist templates can only be edited by administrators and managers. Contact your admin to make changes.
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {!checklists || checklists.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No checklists"
              description={
                canCreate
                  ? "Create your first checklist template to get started"
                  : "No checklist templates have been created yet"
              }
            />
          ) : (
            checklists.map((checklist) => (
              <Card
                key={checklist.id}
                className="overflow-visible"
                data-testid={`card-checklist-${checklist.id}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold">{checklist.name}</h3>
                        {(checklist as any).templateVersion > 1 && (
                          <span className="text-xs text-muted-foreground">v{(checklist as any).templateVersion}</span>
                        )}
                      </div>
                      {checklist.description && (
                        <p className="text-sm text-muted-foreground mb-2">
                          {checklist.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">
                          {getRecurrenceLabel(checklist.recurrence)}
                        </Badge>
                        {/* Show round times for checker type, otherwise show scheduledTime */}
                        {(checklist as any).checklistType === "checker" ? (
                          <Badge variant="secondary" className="text-xs flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {(() => {
                              const rounds = (checklist as any).checkerRounds || 2;
                              const times = [
                                (checklist as any).scheduleTime1,
                                (checklist as any).scheduleTime2,
                                (checklist as any).scheduleTime3,
                                (checklist as any).scheduleTime4,
                                (checklist as any).scheduleTime5,
                              ].filter(Boolean).slice(0, rounds);
                              return times.length > 0 ? times.join(", ") : `${rounds}x daily`;
                            })()}
                          </Badge>
                        ) : checklist.scheduledTime && (
                          <Badge variant="secondary" className="text-xs flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {checklist.scheduledTime}
                          </Badge>
                        )}
                        {(checklist.branchIds?.length || checklist.branchId) && (
                          <Badge variant="secondary" className="text-xs flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {checklist.branchIds?.length
                              ? checklist.branchIds.length === 1
                                ? branches.find(b => b.id === checklist.branchIds![0])?.name || "Branch"
                                : `${checklist.branchIds.length} branches`
                              : branches.find(b => b.id === checklist.branchId)?.name || "Branch"}
                          </Badge>
                        )}
                        {(checklist.assignedEmployeeId || checklist.assignedRoleId) && (
                          <Badge variant="secondary" className="text-xs flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {getAssignmentLabel(checklist) || "Assigned"}
                          </Badge>
                        )}
                        {!checklist.isActive && (
                          <Badge variant="destructive" className="text-xs">
                            Inactive
                          </Badge>
                        )}
                        {(checklist as any).checklistType === "checker" && (
                          <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">
                            <ClipboardCheck className="h-3 w-3 mr-1" />
                            Checker
                          </Badge>
                        )}
                      </div>
                    </div>
                    {canCreate && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEditDialog(checklist)}
                          data-testid={`button-edit-checklist-${checklist.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(checklist)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-checklist-${checklist.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => {
        setShowEditDialog(open);
        if (!open) {
          setEditingChecklist(null);
          form.reset();
          setItems([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
          setHeaderAttachments([]);
          setItemAttachments({});
        }
      }}>
        <DialogContent className="max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto">
          <MediaDropZone
            target="checklist"
            checklistTemplateId={editingChecklist?.id}
            onUploadComplete={(attachment) => {
              setHeaderAttachments(prev => [...prev, attachment]);
            }}
            disabled={!editingChecklist}
          >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Edit Checklist Template
              {checklistType === "checker" && (
                <Badge variant="secondary" className="text-xs">Checker</Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onEditSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name *</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Opening Checklist"
                        {...field}
                        data-testid="input-edit-checklist-name"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Optional description"
                        {...field}
                        data-testid="input-edit-checklist-description"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              
              {/* Reference Media (hidden for checker type since each item has its own media) */}
              {editingChecklist && checklistType !== "checker" && (
                <div className="space-y-2">
                  <FormLabel>Reference Media</FormLabel>
                  <p className="text-xs text-muted-foreground">Add photos or videos as reference for staff completing this checklist.</p>
                  <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-4 text-center bg-muted/30">
                    <div className="flex flex-col items-center gap-2">
                      <Upload className="h-8 w-8 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">Drag & drop files here, or</p>
                      <MediaUploadButton
                        target="checklist"
                        checklistTemplateId={editingChecklist.id}
                        onUploadComplete={(attachment) => {
                          setHeaderAttachments(prev => [...prev, attachment]);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Browse Files
                      </MediaUploadButton>
                    </div>
                    {headerAttachments.length > 0 && (
                      <div className="mt-3 pt-3 border-t">
                        <MediaPreviewStrip
                          attachments={headerAttachments}
                          editable
                          onRemove={async (id) => {
                            try {
                              await apiRequest("DELETE", `/api/checklist-media/${id}`);
                              setHeaderAttachments(prev => prev.filter(a => a.id !== id));
                            } catch {
                              toast({ title: "Failed to remove media", variant: "destructive" });
                            }
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Branches */}
              <div className="space-y-2">
                <FormLabel>Branches *</FormLabel>
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={allBranchesSelected ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={toggleAllBranches}
                    data-testid="badge-edit-all-branches"
                  >
                    All Branches
                  </Badge>
                  {branches.map((branch) => (
                    <Badge
                      key={branch.id}
                      variant={selectedBranchIds.includes(branch.id) ? "default" : "outline"}
                      className="cursor-pointer"
                      onClick={() => toggleBranch(branch.id)}
                      data-testid={`badge-edit-branch-${branch.id}`}
                    >
                      {branch.name}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Location */}
              <FormField
                control={form.control}
                name="locationId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || "__none__"}>
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-location">
                          <SelectValue placeholder="Select location" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">No location</SelectItem>
                        {locations.map((loc) => (
                          <SelectItem key={loc.id} value={loc.id}>
                            {loc.parentName ? `${loc.parentName} > ${loc.name}` : loc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {/* Schedule - different UI for checker vs operational */}
              {checklistType === "checker" ? (
                <>
                  {/* Checker Schedule: Rounds per day */}
                  <FormField
                    control={form.control}
                    name="checkerRounds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>How often to check</FormLabel>
                        <Select onValueChange={(v) => field.onChange(parseInt(v))} value={String(field.value || 2)}>
                          <FormControl>
                            <SelectTrigger data-testid="select-edit-checker-rounds">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="1">1 time per day</SelectItem>
                            <SelectItem value="2">2 times per day</SelectItem>
                            <SelectItem value="3">3 times per day</SelectItem>
                            <SelectItem value="4">4 times per day</SelectItem>
                            <SelectItem value="5">5 times per day</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  {/* Dynamic round time inputs */}
                  <div className="grid grid-cols-2 gap-3">
                    {Array.from({ length: checkerRounds || 2 }).map((_, idx) => (
                      <FormField
                        key={idx}
                        control={form.control}
                        name={`scheduleTime${idx + 1}` as any}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Round {idx + 1} Time</FormLabel>
                            <FormControl>
                              <Input type="time" {...field} value={field.value || ""} data-testid={`input-edit-schedule-time-${idx + 1}`} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="recurrence"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Recurrence</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-edit-recurrence">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="once">One-time</SelectItem>
                            <SelectItem value="daily">Daily</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                            <SelectItem value="monthly">Monthly</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="scheduledTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Time</FormLabel>
                        <FormControl>
                          <Input type="time" {...field} data-testid="input-edit-scheduled-time" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
              )}

              {checklistType !== "checker" && recurrence === "weekly" && (
                <FormField
                  control={form.control}
                  name="weeklyDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Days</FormLabel>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAYS.map((day) => {
                          const isSelected = field.value.includes(day.value);
                          return (
                            <Button
                              key={day.value}
                              type="button"
                              size="sm"
                              variant={isSelected ? "default" : "outline"}
                              onClick={() => {
                                const newValue = isSelected
                                  ? field.value.filter((d: string) => d !== day.value)
                                  : [...field.value, day.value];
                                field.onChange(newValue);
                              }}
                              data-testid={`btn-edit-day-${day.value}`}
                            >
                              {day.label}
                            </Button>
                          );
                        })}
                      </div>
                    </FormItem>
                  )}
                />
              )}

              {checklistType !== "checker" && recurrence === "monthly" && (
                <FormField
                  control={form.control}
                  name="monthlyDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Day of Month</FormLabel>
                      <Select
                        value={field.value?.toString() || ""}
                        onValueChange={(v) => field.onChange(parseInt(v, 10))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-monthly-day">
                            <SelectValue placeholder="Select day" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {MONTH_DAYS.map((day) => (
                            <SelectItem key={day} value={day.toString()}>
                              {day}{day === 31 ? " (or last day)" : day >= 29 ? " (or 1st of next month if unavailable)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        If the selected day doesn't exist in a month (e.g., 30th in February), it will appear on the 1st of the next month.
                      </p>
                    </FormItem>
                  )}
                />
              )}

              {/* Items */}
              <div className="space-y-2">
                <FormLabel>Checklist Items *</FormLabel>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={items.map((_, i) => `item-${i}`)} strategy={verticalListSortingStrategy}>
                {items.map((item, index) => (
                  <SortableChecklistItem key={`edit-item-${index}`} id={`item-${index}`}>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full border border-muted-foreground text-xs font-medium shrink-0">
                        {index + 1}
                      </div>
                      <Input
                        value={item.title}
                        onChange={(e) => updateItem(index, { title: e.target.value })}
                        placeholder={`Item ${index + 1}`}
                        className="flex-1"
                        data-testid={`input-edit-item-${index}`}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => toggleItemExpanded(index)}
                        data-testid={`button-expand-edit-item-${index}`}
                      >
                        {item.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                      {items.length > 1 && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeItem(index)}
                          data-testid={`button-remove-edit-item-${index}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {item.expanded && (
                      <div className="ml-8 space-y-2 p-2 border rounded-md bg-muted/30">
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Description</label>
                          <Textarea
                            placeholder="Optional note for staff doing this item..."
                            value={item.description || ""}
                            onChange={(e) => updateItem(index, { description: e.target.value })}
                            rows={2}
                            className="text-sm resize-none"
                            data-testid={`input-item-description-${index}`}
                          />
                        </div>
                        {/* Only show these options for operational checklists, not checker */}
                        {checklistType !== "checker" && (
                          <div className="flex items-center gap-4 flex-wrap">
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.requiresPhoto}
                                onCheckedChange={(checked) => updateItem(index, { requiresPhoto: !!checked })}
                              />
                              Requires photo
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.cameraEnabled ?? true}
                                onCheckedChange={(checked) => updateItem(index, { cameraEnabled: !!checked })}
                                data-testid={`checkbox-edit-item-camera-${index}`}
                              />
                              Camera
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.galleryEnabled ?? false}
                                onCheckedChange={(checked) => updateItem(index, { galleryEnabled: !!checked })}
                                data-testid={`checkbox-edit-item-gallery-${index}`}
                              />
                              Gallery
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.requiresNote}
                                onCheckedChange={(checked) => updateItem(index, { requiresNote: !!checked })}
                              />
                              Requires note
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.isCritical}
                                onCheckedChange={(checked) => updateItem(index, { isCritical: !!checked })}
                              />
                              Critical
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={item.linkedToFix}
                                onCheckedChange={(checked) => updateItem(index, { linkedToFix: !!checked })}
                                data-testid={`checkbox-edit-item-linked-to-fix-${index}`}
                              />
                              Linked to Fix
                            </label>
                          </div>
                        )}
                        {checklistType === "checker" && (
                          <div className="grid grid-cols-2 gap-3 pt-2 border-t mt-2">
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Zone Label</label>
                              <Input
                                placeholder="e.g. Kitchen, Bar..."
                                value={item.zoneLabel || ""}
                                onChange={(e) => updateItem(index, { zoneLabel: e.target.value })}
                                data-testid={`input-item-zone-${index}`}
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Route Fails To</label>
                              <Select
                                value={item.departmentId || "__none__"}
                                onValueChange={(v) => updateItem(index, { departmentId: v === "__none__" ? undefined : v })}
                              >
                                <SelectTrigger data-testid={`select-item-department-${index}`}>
                                  <SelectValue placeholder="Select department" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">No department</SelectItem>
                                  {departments.map((dept: any) => (
                                    <SelectItem key={dept.id} value={dept.id}>
                                      {dept.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        )}
                        {item.id && (
                          <div className="pt-2 border-t mt-2">
                            <p className="text-xs text-muted-foreground mb-2">Reference media for this item:</p>
                            <MediaDropZone
                              target="item"
                              checklistTemplateItemId={item.id}
                              onUploadComplete={(attachment) => {
                                setItemAttachments(prev => ({
                                  ...prev,
                                  [item.id!]: [...(prev[item.id!] || []), attachment]
                                }));
                              }}
                            >
                              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-3 text-center bg-muted/30">
                                <div className="flex flex-col items-center gap-2">
                                  <Upload className="h-6 w-6 text-muted-foreground/50" />
                                  <p className="text-xs text-muted-foreground">Drag & drop files here, or</p>
                                  <MediaUploadButton
                                    target="item"
                                    checklistTemplateItemId={item.id}
                                    onUploadComplete={(attachment) => {
                                      setItemAttachments(prev => ({
                                        ...prev,
                                        [item.id!]: [...(prev[item.id!] || []), attachment]
                                      }));
                                    }}
                                    size="sm"
                                    variant="outline"
                                  >
                                    Browse Files
                                  </MediaUploadButton>
                                </div>
                                {(itemAttachments[item.id] || []).length > 0 && (
                                  <div className="mt-3 pt-3 border-t">
                                    <MediaPreviewStrip
                                      attachments={itemAttachments[item.id] || []}
                                      editable
                                      onRemove={async (id) => {
                                        try {
                                          await apiRequest("DELETE", `/api/checklist-media/${id}`);
                                          setItemAttachments(prev => ({
                                            ...prev,
                                            [item.id!]: (prev[item.id!] || []).filter(a => a.id !== id)
                                          }));
                                        } catch {
                                          toast({ title: "Failed to remove media", variant: "destructive" });
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            </MediaDropZone>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  </SortableChecklistItem>
                ))}
                  </SortableContext>
                </DndContext>
                <Button type="button" variant="outline" size="sm" onClick={addItem} className="w-full" data-testid="button-add-edit-item">
                  <Plus className="h-4 w-4 mr-1" /> Add Item
                </Button>
              </div>

              {/* Assignment */}
              <FormField
                control={form.control}
                name="assignmentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assign to</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-assignment-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="everyone">Everyone</SelectItem>
                        <SelectItem value="employee">Specific Employee</SelectItem>
                        <SelectItem value="role">Role</SelectItem>
                        <SelectItem value="department">Department</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {assignmentType === "employee" && (
                <FormField
                  control={form.control}
                  name="assignedEmployeeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Employee</FormLabel>
                      {selectedBranchIds.length === 1 && (
                        <p className="text-xs text-muted-foreground">
                          Showing employees from: {branches.find(b => b.id === selectedBranchIds[0])?.name}
                        </p>
                      )}
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-employee">
                            <SelectValue placeholder="Select employee" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filteredEmployees.length === 0 ? (
                            <SelectItem value="__no_employees__" disabled>No employees found</SelectItem>
                          ) : (
                            filteredEmployees.map((emp) => (
                              <SelectItem key={emp.id} value={emp.id}>
                                {emp.nickname || emp.fullName}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              {assignmentType === "role" && (
                <FormField
                  control={form.control}
                  name="assignedRoleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-role">
                            <SelectValue placeholder="Select role" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {roles?.map((role) => (
                            <SelectItem key={role.id} value={role.id}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              {assignmentType === "department" && (
                <FormField
                  control={form.control}
                  name="assignedDepartmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Department</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-department">
                            <SelectValue placeholder="Select department" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {departments?.map((dept) => (
                            <SelectItem key={dept.id} value={dept.id}>
                              {dept.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowEditDialog(false)} data-testid="button-cancel-edit">
                  Cancel
                </Button>
                <Button type="submit" disabled={updateMutation.isPending} data-testid="button-save-checklist">
                  {updateMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
          </MediaDropZone>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Checklist Template</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name *</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Opening Checklist"
                        {...field}
                        data-testid="input-checklist-name"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Tasks to complete when opening..."
                        rows={2}
                        {...field}
                        data-testid="input-checklist-description"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="checklistType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-checklist-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="operational">Operational (Daily Tasks)</SelectItem>
                        <SelectItem value="checker">Checker / Inspection</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {checklistType === "checker" 
                        ? "Quality inspection with Pass/Fail results. Failures auto-create tasks."
                        : "Standard checklist for daily operational tasks."}
                    </p>
                  </FormItem>
                )}
              />

              {checklistType === "checker" && (
                <div className="space-y-3 p-3 border rounded-md bg-muted/30">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <ClipboardCheck className="h-4 w-4" />
                    Checker Schedule
                  </p>
                  <FormField
                    control={form.control}
                    name="checkerRounds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">How often to check</FormLabel>
                        <Select
                          value={String(field.value)}
                          onValueChange={(val) => field.onChange(Number(val))}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-checker-rounds">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="1">1 time per day</SelectItem>
                            <SelectItem value="2">2 times per day</SelectItem>
                            <SelectItem value="3">3 times per day</SelectItem>
                            <SelectItem value="4">4 times per day</SelectItem>
                            <SelectItem value="5">5 times per day</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  <div className={`grid gap-3 ${checkerRounds >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {checkerRounds >= 1 && (
                      <FormField
                        control={form.control}
                        name="scheduleTime1"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Round 1</FormLabel>
                            <FormControl>
                              <Input
                                type="time"
                                {...field}
                                data-testid="input-schedule-time-1"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                    {checkerRounds >= 2 && (
                      <FormField
                        control={form.control}
                        name="scheduleTime2"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Round 2</FormLabel>
                            <FormControl>
                              <Input
                                type="time"
                                {...field}
                                data-testid="input-schedule-time-2"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                    {checkerRounds >= 3 && (
                      <FormField
                        control={form.control}
                        name="scheduleTime3"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Round 3</FormLabel>
                            <FormControl>
                              <Input
                                type="time"
                                {...field}
                                data-testid="input-schedule-time-3"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                    {checkerRounds >= 4 && (
                      <FormField
                        control={form.control}
                        name="scheduleTime4"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Round 4</FormLabel>
                            <FormControl>
                              <Input
                                type="time"
                                {...field}
                                data-testid="input-schedule-time-4"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                    {checkerRounds >= 5 && (
                      <FormField
                        control={form.control}
                        name="scheduleTime5"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Round 5</FormLabel>
                            <FormControl>
                              <Input
                                type="time"
                                {...field}
                                data-testid="input-schedule-time-5"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                </div>
              )}

              <FormItem>
                <FormLabel>Branches</FormLabel>
                <div className="border rounded-md p-3 space-y-2 max-h-40 overflow-y-auto">
                  {branches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No branches available</p>
                  ) : (
                    <>
                      <label
                        className="flex items-center gap-2 cursor-pointer hover-elevate p-1 rounded font-medium"
                      >
                        <Checkbox
                          checked={allBranchesSelected}
                          onCheckedChange={toggleAllBranches}
                          data-testid="checkbox-all-branches"
                        />
                        <span className="text-sm">All Branches</span>
                      </label>
                      <hr className="my-1" />
                      {branches.map((branch) => (
                        <label
                          key={branch.id}
                          className="flex items-center gap-2 cursor-pointer hover-elevate p-1 rounded"
                        >
                          <Checkbox
                            checked={selectedBranchIds.includes(branch.id)}
                            onCheckedChange={() => toggleBranch(branch.id)}
                            data-testid={`checkbox-branch-${branch.id}`}
                          />
                          <span className="text-sm">{branch.name}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
                {selectedBranchIds.length === 0 && (
                  <p className="text-xs text-muted-foreground">No branches selected = visible to all branches</p>
                )}
              </FormItem>

              <FormField
                control={form.control}
                name="locationId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      Location Tag
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-location">
                          <SelectValue placeholder="Optional location..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">No location</SelectItem>
                        {locations.filter(l => l.isActive).map((location) => (
                          <SelectItem key={location.id} value={location.id}>
                            {location.parentName ? `${location.parentName} → ${location.name}` : location.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Tag this checklist with a specific location</p>
                  </FormItem>
                )}
              />

              <div className={`grid gap-3 ${checklistType === "checker" ? 'grid-cols-1' : 'grid-cols-2'}`}>
                <FormField
                  control={form.control}
                  name="recurrence"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Frequency</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-recurrence">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="once">One-time</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />

                {checklistType !== "checker" && (
                  <FormField
                    control={form.control}
                    name="scheduledTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Due Time</FormLabel>
                        <FormControl>
                          <Input
                            type="time"
                            {...field}
                            data-testid="input-scheduled-time"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                )}
              </div>

              {recurrence === "weekly" && (
                <FormField
                  control={form.control}
                  name="weeklyDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Days</FormLabel>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAYS.map((day) => {
                          const isSelected = field.value.includes(day.value);
                          return (
                            <Button
                              key={day.value}
                              type="button"
                              size="sm"
                              variant={isSelected ? "default" : "outline"}
                              onClick={() => {
                                const newValue = isSelected
                                  ? field.value.filter((d: string) => d !== day.value)
                                  : [...field.value, day.value];
                                field.onChange(newValue);
                              }}
                              data-testid={`btn-day-${day.value}`}
                            >
                              {day.label}
                            </Button>
                          );
                        })}
                      </div>
                    </FormItem>
                  )}
                />
              )}

              {recurrence === "monthly" && (
                <FormField
                  control={form.control}
                  name="monthlyDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Day of Month</FormLabel>
                      <Select
                        value={field.value?.toString() || ""}
                        onValueChange={(v) => field.onChange(parseInt(v, 10))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-monthly-day">
                            <SelectValue placeholder="Select day" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {MONTH_DAYS.map((day) => (
                            <SelectItem key={day} value={day.toString()}>
                              {day}{day === 31 ? " (or last day)" : day >= 29 ? " (or 1st of next month if unavailable)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        If the selected day doesn't exist in a month (e.g., 30th in February), it will appear on the 1st of the next month.
                      </p>
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="assignmentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assign To</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(val) => {
                        field.onChange(val);
                        form.setValue("assignedEmployeeId", "");
                        form.setValue("assignedRoleId", "");
                        form.setValue("assignedDepartmentId", "");
                      }}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-assignment-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="everyone">
                          <span className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            Everyone
                          </span>
                        </SelectItem>
                        <SelectItem value="employee">
                          <span className="flex items-center gap-2">
                            <User className="h-4 w-4" />
                            Specific Employee
                          </span>
                        </SelectItem>
                        <SelectItem value="role">
                          <span className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            By Role
                          </span>
                        </SelectItem>
                        <SelectItem value="department">
                          <span className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            By Department
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {assignmentType === "employee" && (
                <FormField
                  control={form.control}
                  name="assignedEmployeeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Employee</FormLabel>
                      {selectedBranchIds.length === 1 && (
                        <p className="text-xs text-muted-foreground">
                          Showing employees from: {branches.find(b => b.id === selectedBranchIds[0])?.name}
                        </p>
                      )}
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-assigned-employee">
                            <SelectValue placeholder="Choose an employee..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filteredEmployees.length === 0 ? (
                            <SelectItem value="__no_employees__" disabled>No employees found</SelectItem>
                          ) : (
                            filteredEmployees.map((emp) => (
                              <SelectItem key={emp.id} value={emp.id}>
                                {emp.nickname || emp.fullName}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              {assignmentType === "role" && (
                <FormField
                  control={form.control}
                  name="assignedRoleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Role</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-assigned-role">
                            <SelectValue placeholder="Choose a role..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {roles?.map((role) => (
                            <SelectItem key={role.id} value={role.id}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              {assignmentType === "department" && (
                <FormField
                  control={form.control}
                  name="assignedDepartmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Select Department</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-assigned-department">
                            <SelectValue placeholder="Choose a department..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {departments?.map((dept) => (
                            <SelectItem key={dept.id} value={dept.id}>
                              {dept.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}

              {/* Header-level media attachments for new checklist (hidden for checker type since each item has its own media) */}
              {pendingChecklistId && checklistType !== "checker" && (
                <div className="space-y-2">
                  <FormLabel className="flex items-center gap-1">
                    <Image className="h-3 w-3" />
                    Reference Media (Optional)
                  </FormLabel>
                  <MediaDropZone
                    target="checklist"
                    checklistTemplateId={pendingChecklistId}
                    isPending={true}
                    pendingChecklistId={pendingChecklistId}
                    onUploadComplete={(attachment) => {
                      setPendingHeaderAttachments(prev => [...prev, attachment]);
                    }}
                  >
                    <div className="border-2 border-dashed rounded-md p-4 text-center hover:border-primary/50 transition-colors">
                      <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">Drag & drop files here, or</p>
                      <MediaUploadButton
                        target="checklist"
                        checklistTemplateId={pendingChecklistId}
                        isPending={true}
                        pendingChecklistId={pendingChecklistId}
                        onUploadComplete={(attachment) => {
                          setPendingHeaderAttachments(prev => [...prev, attachment]);
                        }}
                      >
                        <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-primary">
                          Browse Files
                        </Button>
                      </MediaUploadButton>
                    </div>
                  </MediaDropZone>
                  <UploadingFilesPreview 
                    pendingChecklistId={pendingChecklistId ?? undefined}
                    className="mt-2"
                  />
                  {pendingHeaderAttachments.length > 0 && (
                    <MediaPreviewStrip
                      attachments={pendingHeaderAttachments}
                      onRemove={(id) => {
                        setPendingHeaderAttachments(prev => prev.filter(a => a.id !== id));
                      }}
                    />
                  )}
                </div>
              )}

              <div className="space-y-2">
                <FormLabel>Checklist Items *</FormLabel>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={items.map((_, i) => `item-${i}`)} strategy={verticalListSortingStrategy}>
                {items.map((item, index) => (
                  <SortableChecklistItem key={`create-item-${index}`} id={`item-${index}`}>
                  <div className="border rounded-md p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder={`Item ${index + 1}`}
                        value={item.title}
                        onChange={(e) => updateItem(index, { title: e.target.value })}
                        data-testid={`input-item-${index}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleItemExpanded(index)}
                        disabled={!item.title?.trim()}
                        data-testid={`button-expand-item-${index}`}
                      >
                        {item.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                      {items.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeItem(index)}
                          data-testid={`button-remove-item-${index}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {item.expanded && (
                      <div className="space-y-2 pl-2 border-l-2 border-muted ml-2">
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Description</label>
                          <Textarea
                            placeholder="Optional note for staff doing this item..."
                            value={item.description || ""}
                            onChange={(e) => updateItem(index, { description: e.target.value })}
                            rows={2}
                            className="text-sm resize-none"
                            data-testid={`textarea-create-item-description-${index}`}
                          />
                        </div>
                        {/* Only show these options for operational checklists, not checker */}
                        {checklistType !== "checker" && (
                          <>
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={item.requiresPhoto || false}
                                onCheckedChange={(checked) => updateItem(index, { requiresPhoto: !!checked })}
                                data-testid={`checkbox-item-requires-photo-${index}`}
                              />
                              <span className="text-sm flex items-center gap-1">
                                <Camera className="h-3 w-3" />
                                Requires photo
                              </span>
                            </div>
                            <div className="pl-6 flex items-center gap-4 flex-wrap">
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={item.cameraEnabled ?? true}
                                  onCheckedChange={(checked) => updateItem(index, { cameraEnabled: !!checked })}
                                  data-testid={`checkbox-item-camera-${index}`}
                                />
                                Camera
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={item.galleryEnabled ?? false}
                                  onCheckedChange={(checked) => updateItem(index, { galleryEnabled: !!checked })}
                                  data-testid={`checkbox-item-gallery-${index}`}
                                />
                                Gallery
                              </label>
                            </div>
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={item.isCritical || false}
                                onCheckedChange={(checked) => updateItem(index, { isCritical: !!checked })}
                                data-testid={`checkbox-item-critical-${index}`}
                              />
                              <span className="text-sm">Critical item</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={item.linkedToFix || false}
                                onCheckedChange={(checked) => updateItem(index, { linkedToFix: !!checked })}
                                data-testid={`checkbox-item-linked-to-fix-${index}`}
                              />
                              <span className="text-sm flex items-center gap-1">
                                <Wrench className="h-3 w-3" />
                                Linked to Fix
                              </span>
                            </div>
                          </>
                        )}
                        
                        {/* Checker-specific fields */}
                        {checklistType === "checker" && (
                          <div className="grid grid-cols-2 gap-3 pt-2 border-t mt-2">
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Zone Label</label>
                              <Input
                                placeholder="e.g. Kitchen, Bar..."
                                value={item.zoneLabel || ""}
                                onChange={(e) => updateItem(index, { zoneLabel: e.target.value })}
                                data-testid={`input-create-item-zone-${index}`}
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Route Fails To</label>
                              <Select
                                value={item.departmentId || "__none__"}
                                onValueChange={(v) => updateItem(index, { departmentId: v === "__none__" ? undefined : v })}
                              >
                                <SelectTrigger data-testid={`select-create-item-department-${index}`}>
                                  <SelectValue placeholder="Select department" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">No department</SelectItem>
                                  {departments.map((dept: any) => (
                                    <SelectItem key={dept.id} value={dept.id}>
                                      {dept.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        )}
                        
                        {/* Item-level media attachments */}
                        {pendingChecklistId && (
                          <div className="space-y-1">
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Image className="h-3 w-3" />
                              Reference Media
                            </span>
                            <MediaDropZone
                              target="item"
                              isPending={true}
                              pendingChecklistId={pendingChecklistId}
                              pendingItemIndex={index}
                              onUploadComplete={(attachment) => {
                                setPendingItemAttachments(prev => ({
                                  ...prev,
                                  [index]: [...(prev[index] || []), attachment],
                                }));
                              }}
                            >
                              <div className="border border-dashed rounded p-2 text-center hover:border-primary/50 transition-colors">
                                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                                  <Upload className="h-3 w-3" />
                                  <span>Drop file or</span>
                                  <MediaUploadButton
                                    target="item"
                                    isPending={true}
                                    pendingChecklistId={pendingChecklistId}
                                    pendingItemIndex={index}
                                    onUploadComplete={(attachment) => {
                                      setPendingItemAttachments(prev => ({
                                        ...prev,
                                        [index]: [...(prev[index] || []), attachment],
                                      }));
                                    }}
                                  >
                                    <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs text-primary">
                                      browse
                                    </Button>
                                  </MediaUploadButton>
                                </div>
                              </div>
                            </MediaDropZone>
                            {(pendingItemAttachments[index]?.length || 0) > 0 && (
                              <MediaPreviewStrip
                                attachments={pendingItemAttachments[index]}
                                onRemove={(id) => {
                                  setPendingItemAttachments(prev => ({
                                    ...prev,
                                    [index]: prev[index]?.filter(a => a.id !== id) || [],
                                  }));
                                }}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  </SortableChecklistItem>
                ))}
                  </SortableContext>
                </DndContext>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addItem}
                  className="w-full"
                  data-testid="button-add-item"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Item
                </Button>
              </div>

              <DialogFooter className="flex-col gap-3">
                <UploadStatusBanner 
                  pendingChecklistId={pendingChecklistId ?? undefined}
                  className="w-full"
                />
                <div className="flex gap-2 justify-end w-full">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCreateDialog(false)}
                    data-testid="button-cancel-create"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createMutation.isPending || waitingForUploads}
                    data-testid="button-submit-checklist"
                  >
                    {waitingForUploads ? "Waiting for uploads..." : createMutation.isPending ? "Creating..." : "Create"}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyChecklistId} onOpenChange={(open) => !open && setHistoryChecklistId(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Checker History</DialogTitle>
          </DialogHeader>
          {historyLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {historyError && (
            <div className="text-center py-4">
              <p className="text-sm text-destructive">Failed to load history</p>
            </div>
          )}
          {!historyLoading && !historyError && historyData && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{historyData.templateName}</p>
              {historyData.runs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No completed runs yet</p>
              ) : (
                <div className="space-y-2">
                  {historyData.runs.map((run) => {
                    const branch = branches.find(b => b.id === run.branchId);
                    const passPercent = run.totalItems > 0 ? Math.round((run.passCount / run.totalItems) * 100) : 0;
                    return (
                      <Card key={run.id} className={cn("p-3", run.hasFailures && "border-destructive/50")}>
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">
                              {run.completedAt ? new Date(run.completedAt).toLocaleDateString() : 'N/A'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {branch?.name || 'Unknown branch'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={run.hasFailures ? "destructive" : "outline"} className="text-xs">
                              {run.passCount}/{run.totalItems} pass
                            </Badge>
                            <span className="text-xs text-muted-foreground">{passPercent}%</span>
                          </div>
                        </div>
                        {run.failCount > 0 && (
                          <p className="text-xs text-destructive mt-1">{run.failCount} item(s) failed</p>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
