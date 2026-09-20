import { useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, ChevronDown, ChevronUp, Camera, MapPin, User, Users, ClipboardCheck, GripVertical } from "lucide-react";
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

interface Department {
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

interface ChecklistItem {
  title: string;
  description?: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
  cameraEnabled?: boolean;
  galleryEnabled?: boolean;
  isCritical?: boolean;
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

interface CreateChecklistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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
          data-testid={`ops-cl-drag-handle-${id}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

export function CreateChecklistDialog({ open, onOpenChange }: CreateChecklistDialogProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<ChecklistItem[]>([{ title: "", cameraEnabled: true, galleryEnabled: false }]);

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

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/studio/branches"],
    enabled: open,
  });

  const { data: roles } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
    enabled: open,
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
    enabled: open,
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
    enabled: open,
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
    enabled: open,
  });

  const filteredEmployees = (employees || [])
    .filter(emp => emp.status === "active")
    .filter(emp => {
      if (selectedBranchIds.length === 0) return true;
      if (selectedBranchIds.length === 1) return emp.branchId === selectedBranchIds[0];
      return selectedBranchIds.includes(emp.branchId || "");
    });

  const allBranchesSelected = branches.length > 0 && selectedBranchIds.length === branches.length;

  const toggleBranch = (branchId: string) => {
    const current = form.getValues("branchIds");
    if (current.includes(branchId)) {
      form.setValue("branchIds", current.filter(id => id !== branchId));
    } else {
      form.setValue("branchIds", [...current, branchId]);
    }
    form.setValue("assignedEmployeeId", "");
  };

  const toggleAllBranches = () => {
    const allBranchIds = branches.map(b => b.id);
    const current = form.getValues("branchIds");
    if (current.length === allBranchIds.length) {
      form.setValue("branchIds", []);
    } else {
      form.setValue("branchIds", allBranchIds);
    }
    form.setValue("assignedEmployeeId", "");
  };

  const addItem = () => {
    setItems([...items, { title: "", requiresNote: false, requiresPhoto: false, cameraEnabled: true, galleryEnabled: false, isCritical: false }]);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      onOpenChange(false);
      form.reset();
      setItems([{ title: "", cameraEnabled: true, galleryEnabled: false }]);
      toast({ title: "Checklist template created" });
    },
    onError: (error: any) => {
      const message = error?.message || "Failed to create checklist";
      toast({ title: message, variant: "destructive" });
    },
  });

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
    createMutation.mutate(data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                      data-testid="ops-cl-input-checklist-name"
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
                      data-testid="ops-cl-input-checklist-description"
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
                      <SelectTrigger data-testid="ops-cl-select-checklist-type">
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
                          <SelectTrigger data-testid="ops-cl-select-checker-rounds">
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
                            <Input type="time" {...field} data-testid="ops-cl-input-schedule-time-1" />
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
                            <Input type="time" {...field} data-testid="ops-cl-input-schedule-time-2" />
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
                            <Input type="time" {...field} data-testid="ops-cl-input-schedule-time-3" />
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
                            <Input type="time" {...field} data-testid="ops-cl-input-schedule-time-4" />
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
                            <Input type="time" {...field} data-testid="ops-cl-input-schedule-time-5" />
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
                    <label className="flex items-center gap-2 cursor-pointer hover-elevate p-1 rounded font-medium">
                      <Checkbox
                        checked={allBranchesSelected}
                        onCheckedChange={toggleAllBranches}
                        data-testid="ops-cl-checkbox-all-branches"
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
                          data-testid={`ops-cl-checkbox-branch-${branch.id}`}
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
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger data-testid="ops-cl-select-location">
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="ops-cl-select-recurrence">
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
                        <Input type="time" {...field} data-testid="ops-cl-input-scheduled-time" />
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
                            data-testid={`ops-cl-btn-day-${day.value}`}
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
                        <SelectTrigger data-testid="ops-cl-select-monthly-day">
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
                      <SelectTrigger data-testid="ops-cl-select-assignment-type">
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="ops-cl-select-assigned-employee">
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="ops-cl-select-assigned-role">
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="ops-cl-select-assigned-department">
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
                            data-testid={`ops-cl-input-item-${index}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => toggleItemExpanded(index)}
                            disabled={!item.title?.trim()}
                            data-testid={`ops-cl-button-expand-item-${index}`}
                          >
                            {item.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </Button>
                          {items.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeItem(index)}
                              data-testid={`ops-cl-button-remove-item-${index}`}
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
                                data-testid={`ops-cl-textarea-item-description-${index}`}
                              />
                            </div>
                            {checklistType !== "checker" && (
                              <>
                                <div className="flex items-center gap-2">
                                  <Checkbox
                                    checked={item.requiresPhoto || false}
                                    onCheckedChange={(checked) => updateItem(index, { requiresPhoto: !!checked })}
                                    data-testid={`ops-cl-checkbox-item-requires-photo-${index}`}
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
                                      data-testid={`ops-cl-checkbox-item-camera-${index}`}
                                    />
                                    Camera
                                  </label>
                                  <label className="flex items-center gap-2 text-sm">
                                    <Checkbox
                                      checked={item.galleryEnabled ?? false}
                                      onCheckedChange={(checked) => updateItem(index, { galleryEnabled: !!checked })}
                                      data-testid={`ops-cl-checkbox-item-gallery-${index}`}
                                    />
                                    Gallery
                                  </label>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Checkbox
                                    checked={item.isCritical || false}
                                    onCheckedChange={(checked) => updateItem(index, { isCritical: !!checked })}
                                    data-testid={`ops-cl-checkbox-item-critical-${index}`}
                                  />
                                  <span className="text-sm">Critical item</span>
                                </div>
                              </>
                            )}

                            {checklistType === "checker" && (
                              <div className="grid grid-cols-2 gap-3 pt-2 border-t mt-2">
                                <div>
                                  <label className="text-xs text-muted-foreground block mb-1">Zone Label</label>
                                  <Input
                                    placeholder="e.g. Kitchen, Bar..."
                                    value={item.zoneLabel || ""}
                                    onChange={(e) => updateItem(index, { zoneLabel: e.target.value })}
                                    data-testid={`ops-cl-input-item-zone-${index}`}
                                  />
                                </div>
                                <div>
                                  <label className="text-xs text-muted-foreground block mb-1">Route Fails To</label>
                                  <Select
                                    value={item.departmentId || "__none__"}
                                    onValueChange={(v) => updateItem(index, { departmentId: v === "__none__" ? undefined : v })}
                                  >
                                    <SelectTrigger data-testid={`ops-cl-select-item-department-${index}`}>
                                      <SelectValue placeholder="Select department" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">No department</SelectItem>
                                      {(departments || []).map((dept) => (
                                        <SelectItem key={dept.id} value={dept.id}>
                                          {dept.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
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
                data-testid="ops-cl-button-add-item"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Item
              </Button>
            </div>

            <DialogFooter>
              <div className="flex gap-2 justify-end w-full">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="ops-cl-button-cancel-create"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending}
                  data-testid="ops-cl-button-submit-checklist"
                >
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}