import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { EditableText, type EditableTextHandle } from "@/components/ui/editable-text";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Clock,
  Trash2,
  Loader2,
  Plus,
  Check,
  RotateCcw,
} from "lucide-react";
import type { BeoTimelineItem } from "@shared/schema";

interface BeoTimelineEditorProps {
  eventId: string;
  startTime: string;
}


function getTimeFromOffset(startTime: string, offsetMinutes: number): string {
  const [hours, mins] = startTime.split(":").map(Number);
  const totalMinutes = hours * 60 + mins + offsetMinutes;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;
  return `${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")}`;
}

function timeToOffset(startTime: string, actualTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [ah, am] = actualTime.split(":").map(Number);
  return (ah * 60 + am) - (sh * 60 + sm);
}

type LocalTimelineItem = BeoTimelineItem | {
  id: string;
  label: string;
  offsetFromStartMinutes: number;
  assignedToType: string;
  isLocal: true;
};

export function BeoTimelineEditor({ eventId, startTime }: BeoTimelineEditorProps) {
  const { toast } = useToast();
  const [localItems, setLocalItems] = useState<LocalTimelineItem[]>([]);

  const { data: timeline, isLoading } = useQuery<BeoTimelineItem[]>({
    queryKey: ["/api/events", eventId, "beo", "timeline"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/beo/timeline`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch timeline");
      return res.json();
    },
    enabled: !!eventId,
  });

  const addMutation = useMutation({
    mutationFn: async (data: { label: string; offsetFromStartMinutes: number; assignedToType: string }) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/timeline`, {
        ...data,
        sortOrder: (timeline?.length || 0) + localItems.length + 1,
      });
      if (!res.ok) throw new Error("Failed to add item");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "timeline"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("DELETE", `/api/events/${eventId}/beo/timeline/${itemId}`);
      if (!res.ok) throw new Error("Failed to delete item");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "timeline"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/events/${eventId}/beo/timeline-suppressions`);
      if (!res.ok) throw new Error("Failed to restore auto items");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "timeline"] });
      toast({ title: "Auto items restored" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to restore", description: error.message, variant: "destructive" });
    },
  });

  const allItems = [...(timeline || []), ...localItems];
  const sortedTimeline = allItems.sort((a, b) => a.offsetFromStartMinutes - b.offsetFromStartMinutes);

  const hasSuppressedAutoItems = (timeline || []).some(item => !('isLocal' in item) && (item as BeoTimelineItem).isSystemGenerated === false)
    || false; // We detect suppression by checking if the server returned items with suppressedTimelineSources

  const handleAddInline = () => {
    const nextOffset = sortedTimeline.length > 0
      ? sortedTimeline[sortedTimeline.length - 1].offsetFromStartMinutes + 15
      : 0;
    const newLocalItem: LocalTimelineItem = {
      id: `local-${Date.now()}`,
      label: "",
      offsetFromStartMinutes: nextOffset,
      assignedToType: "PARTY_HOST",
      isLocal: true,
    };
    setLocalItems([...localItems, newLocalItem]);
  };

  const handleSaveLocal = (localId: string, label: string, offsetFromStartMinutes: number) => {
    if (!label.trim()) {
      setLocalItems(localItems.filter(item => item.id !== localId));
      return;
    }
    
    addMutation.mutate({
      label: label.trim(),
      offsetFromStartMinutes,
      assignedToType: "PARTY_HOST",
    });
    setLocalItems(localItems.filter(item => item.id !== localId));
  };

  const handleCancelLocal = (localId: string) => {
    setLocalItems(localItems.filter(item => item.id !== localId));
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sortedTimeline.length === 0 ? (
        <div
          className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
          onClick={handleAddInline}
          data-testid="button-add-first-timeline-item"
        >
          Click here to add first timeline step
        </div>
      ) : (
        <>
          {sortedTimeline.map((item, index) => (
            <TimelineRow
              key={item.id}
              item={item}
              index={index}
              startTime={startTime}
              eventId={eventId}
              onDelete={() => {
                if ('isLocal' in item && item.isLocal) {
                  handleCancelLocal(item.id);
                } else {
                  deleteMutation.mutate(item.id);
                }
              }}
              onSave={(label, offset) => {
                if ('isLocal' in item && item.isLocal) {
                  handleSaveLocal(item.id, label, offset);
                }
              }}
              onAddNext={handleAddInline}
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddInline}
            disabled={addMutation.isPending}
            className="w-full"
            data-testid="button-add-timeline-step"
          >
            {addMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add Step
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => restoreMutation.mutate()}
        disabled={restoreMutation.isPending}
        className="w-full text-muted-foreground text-xs"
        data-testid="button-restore-auto-items"
      >
        {restoreMutation.isPending ? (
          <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3 w-3 mr-1.5" />
        )}
        Restore auto items
      </Button>
    </div>
  );
}

function TimelineRow({
  item,
  index,
  startTime,
  eventId,
  onDelete,
  onSave,
  onAddNext,
}: {
  item: LocalTimelineItem;
  index: number;
  startTime: string;
  eventId: string;
  onDelete: () => void;
  onSave?: (label: string, offset: number) => void;
  onAddNext: () => void;
}) {
  const { toast } = useToast();
  const labelRef = useRef<EditableTextHandle>(null);
  const [localLabel, setLocalLabel] = useState(item.label);
  const [localOffset, setLocalOffset] = useState(item.offsetFromStartMinutes);
  const isLocal = 'isLocal' in item && item.isLocal;
  const saveOnUnmountRef = useRef({ label: localLabel, offset: localOffset, shouldSave: isLocal });
  const savedRef = useRef(false);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<{ label: string; offsetFromStartMinutes: number; assignedToType: string }>) => {
      const res = await apiRequest("PATCH", `/api/events/${eventId}/beo/timeline/${item.id}`, data);
      if (!res.ok) throw new Error("Failed to update item");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "timeline"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    saveOnUnmountRef.current = { label: localLabel, offset: localOffset, shouldSave: isLocal && !savedRef.current };
  }, [localLabel, localOffset, isLocal]);

  useEffect(() => {
    return () => {
      const { label, offset, shouldSave } = saveOnUnmountRef.current;
      if (shouldSave && label.trim() && !savedRef.current) {
        onSave?.(label, offset);
      }
    };
  }, [onSave]);

  const handleLabelChange = (v: string) => {
    setLocalLabel(v);
    if (isLocal) {
      if (v.trim()) {
        savedRef.current = true;
        onSave?.(v, localOffset);
      }
    } else {
      updateMutation.mutate({ label: v });
    }
  };

  const handleTimeChange = (v: string) => {
    if (v) {
      const newOffset = timeToOffset(startTime, v);
      setLocalOffset(newOffset);
      if (!isLocal) {
        updateMutation.mutate({ offsetFromStartMinutes: newOffset });
      }
    }
  };

  const handleSave = () => {
    if (isLocal && localLabel.trim() && !savedRef.current) {
      savedRef.current = true;
      onSave?.(localLabel, localOffset);
    }
  };

  const displayTime = getTimeFromOffset(startTime, localOffset);

  return (
    <div
      className="flex items-center gap-2 p-2 rounded-lg border bg-background"
      data-testid={`timeline-item-${index}`}
    >
      <EditableText
        type="time"
        className="w-[75px] text-xs font-mono shrink-0"
        value={displayTime}
        onChange={handleTimeChange}
        data-testid={`input-timeline-time-${index}`}
      />
      <div className="h-6 w-px bg-border shrink-0" />
      {'isSystemGenerated' in item && (
        <span className="text-[10px] text-muted-foreground/50 shrink-0">
          {item.isSystemGenerated ? "auto" : "manual"}
        </span>
      )}
      <EditableText
        ref={labelRef}
        className="flex-1 text-sm min-w-0"
        value={localLabel}
        onChange={handleLabelChange}
        onEnter={() => {
          if (isLocal) {
            handleSave();
          }
          onAddNext();
        }}
        placeholder="What happens at this time..."
        data-testid={`input-timeline-label-${index}`}
      />
      {isLocal ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleSave}
          disabled={!localLabel.trim()}
          className="h-7 w-7 shrink-0 text-green-600 hover:text-green-700 hover:bg-green-50"
          data-testid={`button-save-${index}`}
        >
          <Check className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          data-testid={`button-delete-${index}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
