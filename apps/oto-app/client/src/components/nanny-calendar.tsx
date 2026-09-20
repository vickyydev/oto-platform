import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Clock, User, CalendarPlus, X, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";

type NannyScheduleData = {
  date: string;
  nannies: Array<{
    id: string;
    fullName: string;
    nickname: string;
    isClockedIn: boolean;
    clockInTime: string | null;
    isManuallyUnavailable?: boolean;
    currentStatus: "available" | "busy" | "reserved" | "offline" | "unavailable";
    activeService: { childName: string; status: string; startTime: string; endTime: string } | null;
    completedServices?: Array<{ childName: string; status: string; startTime: string; endTime: string }>;
    reservations: Array<{
      id: string;
      startTime: string;
      endTime: string;
      childFullName: string | null;
      parentFullName: string | null;
      status: string;
    }>;
  }>;
  reservations: Array<{
    id: string;
    nannyEmployeeId: string;
    nannyFullName: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    childFullName: string | null;
    status: string;
  }>;
};

// 15-minute time slots from 9:00 to 21:00
const TIME_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 4) + 9;
  const minute = (i % 4) * 15;
  return { hour, minute, label: `${hour}:${String(minute).padStart(2, "0")}` };
});
const SLOT_HEIGHT = 12; // Compact height for 15-min blocks

// Convert time string "HH:MM" to slot index
function timeToSlotIndex(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h - 9) * 4 + Math.floor(m / 15);
}

// Convert Date to slot index
function dateToSlotIndex(date: Date): number {
  const h = date.getHours();
  const m = date.getMinutes();
  return (h - 9) * 4 + Math.floor(m / 15);
}

// Format time for display
function formatTimeShort(time: string | Date): string {
  if (typeof time === "string") {
    return time.slice(0, 5);
  }
  return `${time.getHours()}:${String(time.getMinutes()).padStart(2, "0")}`;
}

export function NannyCalendar({ 
  branchId, 
  fetchWithAuth 
}: { 
  branchId: string;
  fetchWithAuth?: (url: string, options?: RequestInit) => Promise<Response>;
}) {
  const { toast } = useToast();
  const [showReserveDialog, setShowReserveDialog] = useState(false);
  const [selectedNannyId, setSelectedNannyId] = useState<string>("");
  const [selectedStartTime, setSelectedStartTime] = useState<string>("");
  const [duration, setDuration] = useState<string>("60");
  const [childName, setChildName] = useState("");
  const [parentName, setParentName] = useState("");
  const [currentTime, setCurrentTime] = useState(new Date());

  const today = new Date().toISOString().split("T")[0];
  
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  const { data: scheduleData, isLoading } = useQuery<NannyScheduleData>({
    queryKey: ["/api/core/nanny-schedule", branchId, today],
    queryFn: async () => {
      const fetcher = fetchWithAuth || ((url: string, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }));
      const res = await fetcher(`/api/core/nanny-schedule?branchId=${branchId}&date=${today}`);
      if (!res.ok) throw new Error("Failed to fetch nanny schedule");
      return res.json();
    },
    enabled: !!branchId,
    refetchInterval: 30000,
  });

  const reserveMutation = useMutation({
    mutationFn: async (data: {
      branchId: string;
      nannyEmployeeId: string;
      startTime: string;
      durationMinutes: number;
      childFullName?: string;
      parentFullName?: string;
    }) => {
      const fetcher = fetchWithAuth || ((url: string, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }));
      const res = await fetcher("/api/core/nanny-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          reservationDate: today,
        }),
      });
      if (!res.ok) throw new Error("Failed to create reservation");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reservation created" });
      setShowReserveDialog(false);
      resetForm();
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "/api/core/nanny-schedule" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      const fetcher = fetchWithAuth || ((url: string, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }));
      const res = await fetcher(`/api/core/nanny-reservations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!res.ok) throw new Error("Failed to cancel reservation");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reservation cancelled" });
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "/api/core/nanny-schedule" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleAvailabilityMutation = useMutation({
    mutationFn: async ({ employeeId, unavailable }: { employeeId: string; unavailable: boolean }) => {
      const fetcher = fetchWithAuth || ((url: string, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }));
      const res = await fetcher("/api/core/nanny-availability/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          employeeId, 
          unavailable,
          date: today 
        }),
      });
      if (!res.ok) throw new Error("Failed to toggle availability");
      return res.json();
    },
    onSuccess: (_, { unavailable }) => {
      toast({ title: unavailable ? "Nanny marked unavailable" : "Nanny marked available" });
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "/api/core/nanny-schedule" });
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "/api/core/nannies/available" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleToggleAvailability = (nanny: NannyScheduleData["nannies"][0]) => {
    if (nanny.currentStatus === "busy") {
      toast({ 
        title: "Cannot change", 
        description: "Nanny is currently with a child",
        variant: "destructive" 
      });
      return;
    }
    const isCurrentlyUnavailable = nanny.currentStatus === "unavailable" || nanny.isManuallyUnavailable;
    toggleAvailabilityMutation.mutate({ 
      employeeId: nanny.id, 
      unavailable: !isCurrentlyUnavailable 
    });
  };

  const resetForm = () => {
    setSelectedNannyId("");
    setSelectedStartTime("");
    setDuration("60");
    setChildName("");
    setParentName("");
  };

  const handleReserve = (nannyId: string, startTime: string) => {
    setSelectedNannyId(nannyId);
    setSelectedStartTime(startTime);
    setShowReserveDialog(true);
  };

  const confirmReservation = () => {
    if (!selectedNannyId || !selectedStartTime) return;
    reserveMutation.mutate({
      branchId,
      nannyEmployeeId: selectedNannyId,
      startTime: selectedStartTime,
      durationMinutes: parseInt(duration),
      childFullName: childName || undefined,
      parentFullName: parentName || undefined,
    });
  };

  const selectedNanny = scheduleData?.nannies.find(n => n.id === selectedNannyId);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!scheduleData || scheduleData.nannies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today's Nanny Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No nannies currently clocked in at this branch</p>
        </CardContent>
      </Card>
    );
  }

  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const currentSlotIndex = (currentHour - 9) * 4 + Math.floor(currentMinute / 15);
  const currentTimePosition = currentHour >= 9 && currentHour <= 20 
    ? currentSlotIndex * SLOT_HEIGHT + (currentMinute % 15) / 15 * SLOT_HEIGHT + 32 
    : null;

  // Build slot data for each nanny
  const getNannySlotData = (nanny: NannyScheduleData["nannies"][0], slotIndex: number) => {
    const slot = TIME_SLOTS[slotIndex];
    if (!slot) return { type: "empty" as const };

    // Check for active service FIRST - if nanny is busy, show the active service
    // This takes priority over reservations to avoid showing duplicate blocks
    if (nanny.currentStatus === "busy" && nanny.activeService) {
      const startTime = new Date(nanny.activeService.startTime);
      const endTime = new Date(nanny.activeService.endTime);
      const startIdx = dateToSlotIndex(startTime);
      const endIdx = Math.ceil((endTime.getHours() - 9) * 4 + endTime.getMinutes() / 15);
      
      if (slotIndex >= startIdx && slotIndex < endIdx) {
        const isStart = slotIndex === startIdx;
        const span = endIdx - startIdx;
        return { 
          type: "active" as const, 
          service: nanny.activeService, 
          isStart, 
          span,
          startTime: formatTimeShort(startTime),
          endTime: formatTimeShort(endTime),
        };
      }
    }

    // Check for reservation (only show if not currently active with a service)
    const reservation = scheduleData.reservations.find(r => {
      if (r.nannyEmployeeId !== nanny.id) return false;
      // Skip reservations that are linked to an active service (status = "active")
      if (r.status === "active") return false;
      const startIdx = timeToSlotIndex(r.startTime);
      const endIdx = timeToSlotIndex(r.endTime);
      return slotIndex >= startIdx && slotIndex < endIdx;
    });

    if (reservation) {
      const startIdx = timeToSlotIndex(reservation.startTime);
      const endIdx = timeToSlotIndex(reservation.endTime);
      const isStart = slotIndex === startIdx;
      const span = endIdx - startIdx;
      return { 
        type: "reservation" as const, 
        reservation, 
        isStart, 
        span,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
      };
    }

    // Check for completed services (checked out children)
    if (nanny.completedServices && nanny.completedServices.length > 0) {
      for (const completed of nanny.completedServices) {
        if (!completed.startTime || !completed.endTime) continue;
        const startTime = new Date(completed.startTime);
        const endTime = new Date(completed.endTime);
        const startIdx = dateToSlotIndex(startTime);
        const endIdx = Math.ceil((endTime.getHours() - 9) * 4 + endTime.getMinutes() / 15);
        
        if (slotIndex >= startIdx && slotIndex < endIdx) {
          const isStart = slotIndex === startIdx;
          const span = Math.max(1, endIdx - startIdx);
          return { 
            type: "completed" as const, 
            service: completed, 
            isStart, 
            span,
            startTime: formatTimeShort(startTime),
            endTime: formatTimeShort(endTime),
          };
        }
      }
    }

    // Check if nanny is manually marked unavailable
    if (nanny.currentStatus === "unavailable" || nanny.isManuallyUnavailable) {
      return { type: "unavailable" as const };
    }

    if (!nanny.isClockedIn) {
      return { type: "offline" as const };
    }

    return { type: "available" as const, time: slot.label };
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Today's Nanny Schedule</CardTitle>
            <Badge variant="outline" className="text-xs">
              {format(new Date(), "EEE, MMM d")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <div className="min-w-[300px] relative">
            {currentTimePosition !== null && (
              <div 
                className="absolute left-0 right-0 h-0.5 bg-red-500 z-10 pointer-events-none"
                style={{ top: `${currentTimePosition}px` }}
              >
                <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
              </div>
            )}
            <div className="flex">
              {/* Time column */}
              <div className="flex-shrink-0" style={{ width: '50px' }}>
                <div className="min-h-[32px] border-b border-r bg-muted/30 flex items-center justify-center py-1">
                  <span className="text-xs font-medium text-muted-foreground">Time</span>
                </div>
                {TIME_SLOTS.map((slot, slotIndex) => {
                  const isHourMark = slot.minute === 0;
                  return (
                    <div 
                      key={`time-${slotIndex}`} 
                      className={`border-r flex items-center justify-center ${isHourMark ? "border-b bg-muted/20" : "border-b border-dashed border-muted/30"}`} 
                      style={{ height: `${SLOT_HEIGHT}px` }}
                    >
                      {isHourMark && (
                        <span className="text-[10px] text-muted-foreground">{slot.hour}:00</span>
                      )}
                    </div>
                  );
                })}
              </div>
              
              {/* Nanny columns */}
              {scheduleData.nannies.map(nanny => (
                <div key={`column-${nanny.id}`} className="flex-1 min-w-[100px] relative">
                  {/* Header - clickable to toggle availability */}
                  <button
                    onClick={() => handleToggleAvailability(nanny)}
                    disabled={toggleAvailabilityMutation.isPending}
                    className="h-auto min-h-[32px] w-full border-b border-r bg-muted/30 flex flex-col items-center justify-center gap-0.5 px-1 py-1 hover-elevate active-elevate-2 transition-colors"
                    data-testid={`toggle-nanny-${nanny.id}`}
                  >
                    <div className="flex items-center gap-1">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        nanny.currentStatus === "available" ? "bg-green-500" :
                        nanny.currentStatus === "busy" ? "bg-blue-500" :
                        nanny.currentStatus === "unavailable" ? "bg-red-500" :
                        nanny.currentStatus === "reserved" ? "bg-amber-500" :
                        "bg-gray-400"
                      }`} />
                      <span className="text-xs font-medium truncate">{nanny.nickname || nanny.fullName.split(" ")[0]}</span>
                    </div>
                    {nanny.isClockedIn && nanny.clockInTime && (
                      <div className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                        <Clock className="h-2.5 w-2.5" />
                        <span>{format(new Date(nanny.clockInTime), "HH:mm")}</span>
                      </div>
                    )}
                    {!nanny.isClockedIn && !nanny.isManuallyUnavailable && (
                      <span className="text-[9px] text-muted-foreground">Not clocked in</span>
                    )}
                  </button>
                  
                  {/* Slot grid with positioned booking blocks */}
                  <div className="relative">
                    {/* Background slots */}
                    {TIME_SLOTS.map((slot, slotIndex) => {
                      const isHourMark = slot.minute === 0;
                      const slotData = getNannySlotData(nanny, slotIndex);
                      
                      // For manually unavailable nannies, show red unavailable indicator
                      if (slotData.type === "unavailable") {
                        return (
                          <div 
                            key={`bg-${slotIndex}`}
                            className={`bg-red-50 dark:bg-red-900/20 border-r flex items-center justify-center ${isHourMark ? "border-b" : "border-b border-dashed border-muted/30"}`}
                            style={{ height: `${SLOT_HEIGHT}px` }}
                          >
                            <span className="text-[10px] text-red-500">-</span>
                          </div>
                        );
                      }
                      
                      // For offline slots (not clocked in), show gray indicator
                      if (slotData.type === "offline") {
                        return (
                          <div 
                            key={`bg-${slotIndex}`}
                            className={`bg-muted/50 border-r flex items-center justify-center ${isHourMark ? "border-b" : "border-b border-dashed border-muted/30"}`}
                            style={{ height: `${SLOT_HEIGHT}px` }}
                          >
                            <span className="text-[10px] text-muted-foreground">-</span>
                          </div>
                        );
                      }
                      
                      // For available slots, show clickable button
                      if (slotData.type === "available") {
                        return (
                          <button
                            key={`bg-${slotIndex}`}
                            onClick={() => handleReserve(nanny.id, slotData.time!)}
                            className={`w-full bg-green-50 dark:bg-green-900/20 border-r hover-elevate flex items-center justify-center transition-colors ${isHourMark ? "border-b" : "border-b border-dashed border-muted/30"}`}
                            style={{ height: `${SLOT_HEIGHT}px` }}
                            data-testid={`slot-${nanny.id}-${slotIndex}`}
                          />
                        );
                      }
                      
                      // For booked slots, render empty background (booking block will overlay)
                      return (
                        <div 
                          key={`bg-${slotIndex}`}
                          className={`border-r ${isHourMark ? "border-b" : "border-b border-dashed border-muted/30"}`}
                          style={{ height: `${SLOT_HEIGHT}px` }}
                        />
                      );
                    })}
                    
                    {/* Overlay booking blocks */}
                    {TIME_SLOTS.map((_, slotIndex) => {
                      const slotData = getNannySlotData(nanny, slotIndex);
                      
                      if (slotData.type === "reservation" && slotData.isStart) {
                        return (
                          <div 
                            key={`block-${slotIndex}`}
                            className="absolute left-0 right-0 bg-amber-100 dark:bg-amber-900/30 border-r flex flex-col items-center justify-between px-1 py-0.5 z-10"
                            style={{ 
                              top: `${slotIndex * SLOT_HEIGHT}px`,
                              height: `${SLOT_HEIGHT * slotData.span}px`
                            }}
                          >
                            <span className="text-[9px] text-amber-600 dark:text-amber-400">
                              {slotData.startTime}
                            </span>
                            <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 truncate">
                              {slotData.reservation.childFullName || "Reserved"}
                            </span>
                            <span className="text-[9px] text-amber-600 dark:text-amber-400">
                              {slotData.endTime}
                            </span>
                          </div>
                        );
                      }
                      
                      if (slotData.type === "active" && slotData.isStart) {
                        const isRegistered = slotData.service.status === "registered";
                        return (
                          <div 
                            key={`block-${slotIndex}`}
                            className={`absolute left-0 right-0 border-r flex flex-col items-center justify-between px-1 py-0.5 z-10 ${
                              isRegistered 
                                ? "bg-purple-100 dark:bg-purple-900/30" 
                                : "bg-blue-100 dark:bg-blue-900/30"
                            }`}
                            style={{ 
                              top: `${slotIndex * SLOT_HEIGHT}px`,
                              height: `${SLOT_HEIGHT * slotData.span}px`
                            }}
                          >
                            <span className={`text-[9px] ${
                              isRegistered 
                                ? "text-purple-600 dark:text-purple-400" 
                                : "text-blue-600 dark:text-blue-400"
                            }`}>
                              {slotData.startTime}
                            </span>
                            <span className={`text-[10px] font-medium truncate ${
                              isRegistered 
                                ? "text-purple-700 dark:text-purple-300" 
                                : "text-blue-700 dark:text-blue-300"
                            }`}>
                              {slotData.service.childName}{isRegistered && " (pending)"}
                            </span>
                            <span className={`text-[9px] ${
                              isRegistered 
                                ? "text-purple-600 dark:text-purple-400" 
                                : "text-blue-600 dark:text-blue-400"
                            }`}>
                              {slotData.endTime}
                            </span>
                          </div>
                        );
                      }
                      
                      if (slotData.type === "completed" && slotData.isStart) {
                        return (
                          <div 
                            key={`block-${slotIndex}`}
                            className="absolute left-0 right-0 border-r flex flex-col items-center justify-between px-1 py-0.5 z-10 bg-gray-200 dark:bg-gray-700/50"
                            style={{ 
                              top: `${slotIndex * SLOT_HEIGHT}px`,
                              height: `${SLOT_HEIGHT * slotData.span}px`
                            }}
                          >
                            <span className="text-[9px] text-gray-500 dark:text-gray-400">
                              {slotData.startTime}
                            </span>
                            <span className="text-[10px] font-medium truncate text-gray-600 dark:text-gray-300 line-through">
                              {slotData.service.childName}
                            </span>
                            <span className="text-[9px] text-gray-500 dark:text-gray-400">
                              {slotData.endTime}
                            </span>
                          </div>
                        );
                      }
                      
                      return null;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3 p-3 border-t text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-green-100 dark:bg-green-900/30 border" />
              <span className="text-muted-foreground">Available</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-blue-100 dark:bg-blue-900/30 border" />
              <span className="text-muted-foreground">In Park</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-purple-100 dark:bg-purple-900/30 border" />
              <span className="text-muted-foreground">Registered</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-amber-100 dark:bg-amber-900/30 border" />
              <span className="text-muted-foreground">Reserved</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-gray-200 dark:bg-gray-700/50 border" />
              <span className="text-muted-foreground">Done</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-red-100 dark:bg-red-900/30 border" />
              <span className="text-muted-foreground">Unavailable</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-muted/50 border" />
              <span className="text-muted-foreground">Offline</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-0.5 bg-red-500" />
              <span className="text-muted-foreground">Now</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {scheduleData.reservations.length > 0 && (
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Upcoming Reservations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {scheduleData.reservations.map(res => (
              <div key={res.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                      <span className="text-sm font-medium">{res.startTime} - {res.endTime}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span>{res.nannyFullName}</span>
                      {res.childFullName && <span>• {res.childFullName}</span>}
                    </div>
                  </div>
                </div>
                <Button 
                  size="icon" 
                  variant="ghost" 
                  className="h-7 w-7"
                  onClick={() => cancelMutation.mutate(res.id)}
                  disabled={cancelMutation.isPending}
                  data-testid={`cancel-reservation-${res.id}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={showReserveDialog} onOpenChange={setShowReserveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reserve Nanny</DialogTitle>
            <DialogDescription>
              {selectedNanny && (
                <>Reserve <strong>{selectedNanny.fullName}</strong> starting at {selectedStartTime}</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Duration</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger data-testid="select-reservation-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2 hours</SelectItem>
                  <SelectItem value="180">3 hours</SelectItem>
                  <SelectItem value="240">4 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Child Name (optional)</Label>
              <Input 
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                placeholder="Enter child's name"
                data-testid="input-child-name"
              />
            </div>

            <div>
              <Label>Parent Name (optional)</Label>
              <Input 
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
                placeholder="Enter parent's name"
                data-testid="input-parent-name"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReserveDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmReservation}
              disabled={reserveMutation.isPending}
              data-testid="button-confirm-reservation"
            >
              {reserveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reserving...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Reserve
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
