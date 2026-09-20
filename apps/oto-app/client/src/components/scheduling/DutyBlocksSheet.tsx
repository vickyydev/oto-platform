import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Trash2, Clock, ListChecks, GripVertical } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { DutyBlock, DutyType } from "@shared/schema";

interface DutyBlocksSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assignmentId: string;
  branchId: string;
  employeeId: string;
  employeeName: string;
  date: string;
  shiftStartTime: string;
  shiftEndTime: string;
  shiftName: string;
}

export function DutyBlocksSheet({
  open,
  onOpenChange,
  assignmentId,
  branchId,
  employeeId,
  employeeName,
  date,
  shiftStartTime,
  shiftEndTime,
  shiftName,
}: DutyBlocksSheetProps) {
  const { toast } = useToast();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [formStartTime, setFormStartTime] = useState(shiftStartTime.slice(0, 5));
  const [formEndTime, setFormEndTime] = useState("");
  const [formDutyTypeId, setFormDutyTypeId] = useState<string>("");
  const [formDutyName, setFormDutyName] = useState("");
  const [formNotes, setFormNotes] = useState("");

  const dutyBlocksQuery = useQuery<DutyBlock[]>({
    queryKey: ["/api/duty-blocks", { branchId, date, employeeId }],
    queryFn: async () => {
      const params = new URLSearchParams({ branchId, date, employeeId });
      const res = await fetch(`/api/duty-blocks?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch duty blocks");
      return res.json();
    },
    enabled: open,
  });

  const dutyTypesQuery = useQuery<DutyType[]>({
    queryKey: ["/api/duty-types"],
    enabled: open,
  });

  const assignmentBlocks = (dutyBlocksQuery.data || []).filter(
    (b) => b.assignmentId === assignmentId
  );

  const sortedBlocks = [...assignmentBlocks].sort((a, b) =>
    a.startTime.localeCompare(b.startTime)
  );

  const createBlockMutation = useMutation({
    mutationFn: async (data: {
      branchId: string;
      date: string;
      employeeId: string;
      assignmentId: string;
      dutyTypeId?: string;
      dutyName?: string;
      startTime: string;
      endTime: string;
      notes?: string;
    }) => {
      const res = await apiRequest("POST", "/api/duty-blocks", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/duty-blocks"] });
      resetForm();
      toast({ title: "Duty block added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add duty block", description: err.message, variant: "destructive" });
    },
  });

  const updateBlockMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; startTime?: string; endTime?: string; dutyName?: string; dutyTypeId?: string | null; notes?: string }) => {
      const res = await apiRequest("PATCH", `/api/duty-blocks/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/duty-blocks"] });
      resetForm();
      toast({ title: "Duty block updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteBlockMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/duty-blocks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/duty-blocks"] });
      toast({ title: "Duty block removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setShowAddForm(false);
    setEditingBlockId(null);
    const nextStart = getNextAvailableStartTime();
    setFormStartTime(nextStart);
    setFormEndTime(getDefaultEndTime(nextStart));
    setFormDutyTypeId("");
    setFormDutyName("");
    setFormNotes("");
  }

  function getNextAvailableStartTime(): string {
    if (sortedBlocks.length === 0) return shiftStartTime.slice(0, 5);
    const lastBlock = sortedBlocks[sortedBlocks.length - 1];
    return lastBlock.endTime.slice(0, 5);
  }

  function getDefaultEndTime(start: string): string {
    const startMins = timeToMinutes(start);
    const shiftEndMins = timeToMinutes(shiftEndTime.slice(0, 5));
    const endMins = Math.min(startMins + 60, shiftEndMins);
    return minutesToTime(endMins);
  }

  function handleAddNew() {
    const nextStart = getNextAvailableStartTime();
    setFormStartTime(nextStart);
    setFormEndTime(getDefaultEndTime(nextStart));
    setFormDutyTypeId("");
    setFormDutyName("");
    setFormNotes("");
    setEditingBlockId(null);
    setShowAddForm(true);
  }

  function handleEdit(block: DutyBlock) {
    setFormStartTime(block.startTime.slice(0, 5));
    setFormEndTime(block.endTime.slice(0, 5));
    setFormDutyTypeId(block.dutyTypeId || "");
    setFormDutyName(block.dutyName || "");
    setFormNotes(block.notes || "");
    setEditingBlockId(block.id);
    setShowAddForm(true);
  }

  function handleQuickAdd(dutyType: DutyType) {
    const nextStart = getNextAvailableStartTime();
    const startMinutes = timeToMinutes(nextStart);
    const durationMins = dutyType.defaultDurationMinutes || 60;
    const endMinutes = Math.min(startMinutes + durationMins, timeToMinutes(shiftEndTime.slice(0, 5)));
    const endTime = minutesToTime(endMinutes);

    createBlockMutation.mutate({
      branchId,
      date,
      employeeId,
      assignmentId,
      dutyTypeId: dutyType.id,
      dutyName: dutyType.name,
      startTime: nextStart,
      endTime,
    });
  }

  function handleSubmit() {
    if (!formStartTime || !formEndTime) {
      toast({ title: "Please set start and end times", variant: "destructive" });
      return;
    }
    if (formStartTime >= formEndTime) {
      toast({ title: "End time must be after start time", variant: "destructive" });
      return;
    }
    const name = formDutyName || (dutyTypesQuery.data?.find((dt) => dt.id === formDutyTypeId)?.name) || "Duty";

    if (editingBlockId) {
      updateBlockMutation.mutate({
        id: editingBlockId,
        startTime: formStartTime,
        endTime: formEndTime,
        dutyTypeId: formDutyTypeId || null,
        dutyName: name,
        notes: formNotes || undefined,
      });
    } else {
      createBlockMutation.mutate({
        branchId,
        date,
        employeeId,
        assignmentId,
        dutyTypeId: formDutyTypeId || undefined,
        dutyName: name,
        startTime: formStartTime,
        endTime: formEndTime,
        notes: formNotes || undefined,
      });
    }
  }

  function handleDutyTypeSelect(typeId: string) {
    setFormDutyTypeId(typeId);
    const dt = dutyTypesQuery.data?.find((t) => t.id === typeId);
    if (dt) {
      setFormDutyName(dt.name);
      if (dt.defaultDurationMinutes && formStartTime) {
        const startMins = timeToMinutes(formStartTime);
        const endMins = Math.min(startMins + dt.defaultDurationMinutes, timeToMinutes(shiftEndTime.slice(0, 5)));
        setFormEndTime(minutesToTime(endMins));
      }
    }
  }

  const shiftStartMinutes = timeToMinutes(shiftStartTime.slice(0, 5));
  const shiftEndMinutes = timeToMinutes(shiftEndTime.slice(0, 5));
  const shiftDurationMinutes = shiftEndMinutes - shiftStartMinutes;

  const dutyTypeColors: Record<string, string> = {};
  const defaultColors = ["bg-blue-500", "bg-violet-500", "bg-amber-500", "bg-emerald-500", "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-teal-500"];
  (dutyTypesQuery.data || []).forEach((dt, i) => {
    dutyTypeColors[dt.id] = dt.color || defaultColors[i % defaultColors.length];
  });

  function getBlockColor(block: DutyBlock): string {
    if (block.dutyTypeId && dutyTypeColors[block.dutyTypeId]) {
      const c = dutyTypeColors[block.dutyTypeId];
      if (c.startsWith("bg-")) return c;
      return `bg-[${c}]`;
    }
    return "bg-blue-500";
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] sm:h-[70vh] rounded-t-xl p-0">
        <div className="flex flex-col h-full">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ListChecks className="h-4 w-4" />
              Duty Blocks
            </SheetTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              <span>{employeeName}</span>
              <span className="text-muted-foreground/50">|</span>
              <span className="font-mono">{shiftStartTime.slice(0, 5)} - {shiftEndTime.slice(0, 5)}</span>
              <span className="text-muted-foreground/50">|</span>
              <span>{shiftName}</span>
            </div>
          </SheetHeader>

          <Separator />

          <div className="px-4 pt-3 pb-1">
            <div className="relative h-8 rounded-md bg-muted overflow-hidden" data-testid="duty-blocks-timeline">
              {sortedBlocks.map((block) => {
                const blockStart = timeToMinutes(block.startTime.slice(0, 5));
                const blockEnd = timeToMinutes(block.endTime.slice(0, 5));
                const leftPct = ((blockStart - shiftStartMinutes) / shiftDurationMinutes) * 100;
                const widthPct = ((blockEnd - blockStart) / shiftDurationMinutes) * 100;
                return (
                  <div
                    key={block.id}
                    className={cn("absolute top-0 bottom-0 flex items-center justify-center text-white text-[10px] font-medium px-0.5 truncate", getBlockColor(block))}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    title={`${block.dutyName || "Duty"}: ${block.startTime.slice(0, 5)} - ${block.endTime.slice(0, 5)}`}
                    data-testid={`duty-block-timeline-${block.id}`}
                  >
                    {widthPct > 15 ? (block.dutyName || "Duty") : ""}
                  </div>
                );
              })}
              <div className="absolute left-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground font-mono z-10">
                {shiftStartTime.slice(0, 5)}
              </div>
              <div className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground font-mono z-10">
                {shiftEndTime.slice(0, 5)}
              </div>
            </div>
          </div>

          <ScrollArea className="flex-1 px-4">
            <div className="space-y-2 pb-4 pt-2">
              {dutyBlocksQuery.isLoading && (
                <div className="text-sm text-muted-foreground text-center py-4">Loading...</div>
              )}

              {!dutyBlocksQuery.isLoading && sortedBlocks.length === 0 && !showAddForm && (
                <div className="text-center py-6">
                  <ListChecks className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                  <div className="text-sm text-muted-foreground">No duty blocks yet</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">
                    Add blocks to break this shift into specific tasks
                  </div>
                </div>
              )}

              {sortedBlocks.map((block) => (
                <div
                  key={block.id}
                  className="flex items-center gap-2 group"
                  data-testid={`duty-block-item-${block.id}`}
                >
                  <div className={cn("w-1 h-10 rounded-full shrink-0", getBlockColor(block))} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{block.dutyName || "Duty"}</span>
                      {block.dutyTypeId && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{
                          dutyTypesQuery.data?.find((dt) => dt.id === block.dutyTypeId)?.name || "Type"
                        }</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span className="font-mono">{block.startTime.slice(0, 5)} - {block.endTime.slice(0, 5)}</span>
                      {block.notes && <span className="truncate ml-1">- {block.notes}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(block)}
                      data-testid={`button-edit-duty-block-${block.id}`}
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteBlockMutation.mutate(block.id)}
                      data-testid={`button-delete-duty-block-${block.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}

              {showAddForm && (
                <div className="border rounded-md p-3 space-y-3 bg-muted/30" data-testid="duty-block-form">
                  <div className="text-sm font-medium">{editingBlockId ? "Edit Duty Block" : "New Duty Block"}</div>

                  {(dutyTypesQuery.data || []).length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-xs">Duty Type</Label>
                      <Select value={formDutyTypeId} onValueChange={handleDutyTypeSelect}>
                        <SelectTrigger data-testid="select-duty-type">
                          <SelectValue placeholder="Select type (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          {(dutyTypesQuery.data || []).filter((dt) => dt.isActive).map((dt) => (
                            <SelectItem key={dt.id} value={dt.id} data-testid={`select-duty-type-option-${dt.id}`}>
                              {dt.name} {dt.defaultDurationMinutes ? `(${dt.defaultDurationMinutes}m)` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={formDutyName}
                      onChange={(e) => setFormDutyName(e.target.value)}
                      placeholder="e.g., Setup, Service, Cleanup"
                      data-testid="input-duty-block-name"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Start Time</Label>
                      <Input
                        type="time"
                        value={formStartTime}
                        onChange={(e) => {
                          setFormStartTime(e.target.value);
                          if (e.target.value && (!formEndTime || e.target.value >= formEndTime)) {
                            setFormEndTime(getDefaultEndTime(e.target.value));
                          }
                        }}
                        data-testid="input-duty-block-start"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">End Time</Label>
                      <Input
                        type="time"
                        value={formEndTime}
                        onChange={(e) => setFormEndTime(e.target.value)}
                        min={formStartTime}
                        data-testid="input-duty-block-end"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Notes (optional)</Label>
                    <Input
                      value={formNotes}
                      onChange={(e) => setFormNotes(e.target.value)}
                      placeholder="Additional info..."
                      data-testid="input-duty-block-notes"
                    />
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={resetForm}
                      data-testid="button-cancel-duty-block"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={handleSubmit}
                      disabled={createBlockMutation.isPending || updateBlockMutation.isPending}
                      data-testid="button-save-duty-block"
                    >
                      {editingBlockId ? "Update" : "Add"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          <Separator />

          <div className="px-4 py-3 space-y-2">
            {!showAddForm && (dutyTypesQuery.data || []).filter((dt) => dt.isActive).length > 0 && (
              <div className="flex gap-1.5 flex-wrap" data-testid="duty-type-quick-add">
                {(dutyTypesQuery.data || []).filter((dt) => dt.isActive).map((dt) => (
                  <Button
                    key={dt.id}
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuickAdd(dt)}
                    disabled={createBlockMutation.isPending}
                    data-testid={`button-quick-add-duty-${dt.id}`}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {dt.name}
                  </Button>
                ))}
              </div>
            )}
            {!showAddForm && (
              <Button
                className="w-full"
                variant="outline"
                onClick={handleAddNew}
                data-testid="button-add-duty-block"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Add Duty Block
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
