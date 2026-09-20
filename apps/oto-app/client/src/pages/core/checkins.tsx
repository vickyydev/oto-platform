import { useState, useRef, useEffect, createContext, useContext } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Search, Phone, Clock, AlertTriangle, User, Baby, CheckCircle, MessageCircle, LogOut, Users, Camera, UserPlus, Play, Square, AlertCircle, Edit, Timer, Calendar, RotateCcw, X, Plus, Copy, Send, RefreshCw, Tent, UserCheck, UserX } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ServiceCheckin } from "@shared/schema";
import { format, isAfter, isBefore, addMinutes, differenceInYears, parseISO } from "date-fns";
import { NannyCalendar } from "@/components/nanny-calendar";
import { TimeWheelPicker } from "@/components/time-wheel-picker";

interface KioskContextType {
  isKiosk: boolean;
  kioskToken: string | null;
  kioskBranchId: string | null;
}

const KioskContext = createContext<KioskContextType>({
  isKiosk: false,
  kioskToken: null,
  kioskBranchId: null,
});

export const useKioskContext = () => useContext(KioskContext);

export interface CheckinsContentProps {
  kioskMode?: boolean;
  kioskToken?: string;
  kioskBranchId?: string;
}

type Employee = {
  id: string;
  fullName: string;
};

function CheckinCard({
  checkin,
  onEnterPark,
  onCheckOut,
  onEditService,
  onAssignNanny,
  onExtendTime,
}: {
  checkin: ServiceCheckin;
  onEnterPark?: () => void;
  onCheckOut?: () => void;
  onEditService?: () => void;
  onAssignNanny?: () => void;
  onExtendTime?: (minutes: number) => void;
}) {
  const [showNotesDialog, setShowNotesDialog] = useState(false);
  const [telegramMessageCopied, setTelegramMessageCopied] = useState(false);
  const { toast } = useToast();
  const isOverdue = checkin.requestedEndAt && isAfter(new Date(), new Date(checkin.requestedEndAt)) && checkin.status !== "checked_out";
  const isDueSoon = !isOverdue && checkin.requestedEndAt && checkin.status === "in_park" && isBefore(new Date(), new Date(checkin.requestedEndAt)) && isAfter(addMinutes(new Date(), 15), new Date(checkin.requestedEndAt));

  const getAbsolutePhotoUrl = () => {
    if (!checkin.photoUrl) return "";
    try {
      return new URL(checkin.photoUrl, window.location.origin).toString();
    } catch {
      return "";
    }
  };

  const getWhatsAppLink = () => {
    const phone = checkin.whatsappPhoneE164?.replace("+", "") || checkin.whatsappPhoneRaw?.replace(/\D/g, "");
    const serviceName = checkin.serviceType === "nanny" ? "Nanny Service" : "Drop-Off Service";
    let message = `Hi ${checkin.parentFullName}, this is OTO Play Park. Just confirming ${checkin.childFullName} is checked in for ${serviceName}.`;
    const photoUrl = getAbsolutePhotoUrl();
    if (photoUrl) {
      message += `\n\nPhoto: ${photoUrl}`;
    }
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  };

  const getTelegramWelcomeMessage = () => {
    const serviceName = checkin.serviceType === "nanny" ? "Nanny Service" : "Drop-Off Service";
    let message = `Hi ${checkin.parentFullName}, this is OTO Play Park. Just confirming ${checkin.childFullName} is checked in for ${serviceName}.`;
    const photoUrl = getAbsolutePhotoUrl();
    if (photoUrl) {
      message += `\n\nPhoto: ${photoUrl}`;
    }
    return message;
  };

  const getTelegramLink = () => {
    // telegramUsername now contains phone number, not username
    const phone = checkin.telegramUsername?.replace(/[^0-9+]/g, "") || "";
    // Telegram deep link with phone number (format: +1234567890)
    return `https://t.me/${phone}`;
  };

  const handleCopyTelegramMessage = async () => {
    try {
      await navigator.clipboard.writeText(getTelegramWelcomeMessage());
      setTelegramMessageCopied(true);
      toast({
        title: "Message copied!",
        description: "Now tap 'Open Telegram' to send the message.",
      });
    } catch (err) {
      toast({
        title: "Failed to copy",
        description: "Please copy the message manually.",
        variant: "destructive",
      });
    }
  };

  const handleOpenTelegram = () => {
    window.open(getTelegramLink(), "_blank");
  };

  const getDurationLabel = () => {
    if (!checkin.requestedDurationMinutes) return null;
    const hours = checkin.requestedDurationMinutes / 60;
    return `${hours}h`;
  };

  return (
    <Card className={isOverdue ? "border-destructive" : isDueSoon ? "border-amber-400 dark:border-amber-500" : ""} data-testid={`checkin-${checkin.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {checkin.photoUrl ? (
            <img src={checkin.photoUrl} alt="Child" className="w-16 h-16 rounded-lg object-cover" />
          ) : (
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center">
              <Baby className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold">{checkin.childFullName}</h3>
                {checkin.childAge && (
                  <Badge variant="outline" className="text-xs">Age {checkin.childAge}</Badge>
                )}
                <Badge variant={checkin.serviceType === "nanny" ? "default" : "secondary"}>
                  {checkin.serviceType === "nanny" ? "Nanny" : "Drop-Off"}
                </Badge>
                {getDurationLabel() && (
                  <Badge variant="outline" className="text-xs gap-1">
                    <Timer className="h-3 w-3" />
                    {getDurationLabel()}
                  </Badge>
                )}
              </div>
              <div className="flex flex-col gap-1">
              {(checkin.status === "registered" || checkin.status === "in_park") && (
                <Button size="icon" variant="ghost" onClick={onEditService} data-testid="button-edit-service">
                  <Edit className="h-4 w-4" />
                </Button>
              )}
              {checkin.status === "in_park" && (checkin.serviceType === "nanny" || checkin.requestedDurationMinutes || checkin.requestedEndAt) && onExtendTime && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="text-orange-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20" data-testid="button-extend-time">
                      <Timer className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onExtendTime(30)} data-testid="extend-30min">
                      +30 min
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExtendTime(60)} data-testid="extend-1h">
                      +1 hour
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExtendTime(120)} data-testid="extend-2h">
                      +2 hours
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            </div>
            {isOverdue && (
              <Badge variant="destructive" className="gap-1 mt-1" data-testid="badge-overdue">
                <AlertCircle className="h-3 w-3" />
                Overdue
              </Badge>
            )}
            {isDueSoon && (
              <Badge className="gap-1 mt-1 bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700" data-testid="badge-due-soon">
                <Clock className="h-3 w-3" />
                Due Soon
              </Badge>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              <User className="h-3 w-3" />
              <span>{checkin.parentFullName}</span>
            </div>
            {checkin.contactMethod === "telegram" && checkin.telegramUsername ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Send className="h-3 w-3" />
                <span>{checkin.telegramUsername}</span>
              </div>
            ) : (
              <a href={`tel:${checkin.whatsappPhoneRaw}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary">
                <Phone className="h-3 w-3" />
                <span>{checkin.whatsappPhoneRaw}</span>
              </a>
            )}
            {checkin.requestedEndAt && checkin.status === "in_park" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Ends at {format(new Date(checkin.requestedEndAt), "HH:mm")}</span>
              </div>
            )}
            {checkin.nannyAssigned && (
              <div className="flex items-center gap-2 text-sm mt-1">
                <UserPlus className="h-3 w-3 text-green-600" />
                <span className="text-green-600 font-medium">{checkin.nannyAssigned}</span>
              </div>
            )}
            {(checkin.allergiesMedicalDetails || checkin.foodNotesRestrictions) && (
              <button 
                onClick={() => setShowNotesDialog(true)}
                className="flex items-center gap-1 text-amber-600 text-xs mt-1 hover:underline cursor-pointer"
                data-testid="button-view-notes"
              >
                <AlertTriangle className="h-3 w-3" />
                <span>Has notes/restrictions - tap to view</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t">
          {checkin.contactMethod === "telegram" && checkin.telegramUsername ? (
            <>
              {!telegramMessageCopied ? (
                <Button size="sm" variant="outline" className="gap-1" onClick={handleCopyTelegramMessage} data-testid="button-copy-telegram">
                  <Copy className="h-3 w-3" />
                  Copy Message
                </Button>
              ) : (
                <Button size="sm" variant="default" className="gap-1" onClick={handleOpenTelegram} data-testid="button-open-telegram">
                  <Send className="h-3 w-3" />
                  Open Telegram
                </Button>
              )}
            </>
          ) : (
            <a href={getWhatsAppLink()} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline" className="gap-1" data-testid="button-whatsapp">
                <MessageCircle className="h-3 w-3" />
                WhatsApp
              </Button>
            </a>
          )}
          
          {checkin.status === "registered" && (
            <>
              {checkin.serviceType === "nanny" && !checkin.nannyEmployeeId && (
                <Button size="sm" variant="secondary" onClick={onAssignNanny} className="gap-1" data-testid="button-assign-nanny">
                  <UserPlus className="h-3 w-3" />
                  Assign Nanny
                </Button>
              )}
              <Button size="sm" onClick={onEnterPark} className="gap-1" data-testid="button-enter-park">
                <Play className="h-3 w-3" />
                Enter Park
              </Button>
            </>
          )}
          
          {checkin.status === "in_park" && (
            <>
              {checkin.serviceType === "nanny" && !checkin.nannyEmployeeId && (
                <Button size="sm" variant="secondary" onClick={onAssignNanny} className="gap-1" data-testid="button-assign-nanny">
                  <UserPlus className="h-3 w-3" />
                  Assign Nanny
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={onCheckOut} className="gap-1" data-testid="button-check-out">
                <Square className="h-3 w-3" />
                Check Out
              </Button>
            </>
          )}
          
          {checkin.status === "checked_out" && (
            <Badge variant="outline" className="gap-1">
              <CheckCircle className="h-3 w-3" />
              Checked out {checkin.checkedOutAt && format(new Date(checkin.checkedOutAt), "HH:mm")}
            </Badge>
          )}
        </div>
      </CardContent>

      <Dialog open={showNotesDialog} onOpenChange={setShowNotesDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notes & Restrictions for {checkin.childFullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {checkin.allergiesMedicalDetails && (
              <div>
                <Label className="text-sm font-medium text-muted-foreground">Allergies / Medical Details</Label>
                <p className="mt-1 text-sm whitespace-pre-wrap">{checkin.allergiesMedicalDetails}</p>
              </div>
            )}
            {checkin.foodNotesRestrictions && (
              <div>
                <Label className="text-sm font-medium text-muted-foreground">Food Notes / Restrictions</Label>
                <p className="mt-1 text-sm whitespace-pre-wrap">{checkin.foodNotesRestrictions}</p>
              </div>
            )}
            {!checkin.allergiesMedicalDetails && !checkin.foodNotesRestrictions && (
              <p className="text-muted-foreground text-sm">No notes or restrictions recorded.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNotesDialog(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ============================================================
// CAMP CHECK-IN SECTION
// ============================================================

type CampReg = {
  id: string;
  childFullName: string;
  dateOfBirth: string;
  parentGuardianName: string;
  emergencyContactNumber: string;
  eventId: string;
  attendanceStatus: "waiting" | "checked_in" | "checked_out";
  attendanceCheckedInAt: string | null;
  attendanceCheckedOutAt: string | null;
  authorizedPickupPersons?: string | null;
  childPhotoUrl: string | null;
};

type CampEvent = {
  id: string;
  title: string;
  eventDate: string;
  campEndDate?: string;
  branchId?: string;
};

function CampCheckins({ activeBranchId, fetchWithAuth }: { activeBranchId?: string | null; fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response> }) {
  const { toast } = useToast();
  const [campSearch, setCampSearch] = useState("");
  const [campStatusFilter, setCampStatusFilter] = useState<"all" | "not_checked_in" | "checked_in" | "checked_out">("all");

  // Check-in dialog state
  const [checkInDialog, setCheckInDialog] = useState<{ open: boolean; regId: string | null; authorizedPickup: string | null }>({ open: false, regId: null, authorizedPickup: null });
  const [checkInPayment, setCheckInPayment] = useState("");
  const [checkInDropOff, setCheckInDropOff] = useState("");

  // Check-out dialog state
  const [checkOutDialog, setCheckOutDialog] = useState<{ open: boolean; regId: string | null; authorizedPickup: string | null; childName: string | null; childPhotoUrl: string | null }>({ open: false, regId: null, authorizedPickup: null, childName: null, childPhotoUrl: null });
  const [checkOutPickUp, setCheckOutPickUp] = useState("");

  const { data, isLoading } = useQuery<{ camps: CampEvent[]; registrations: CampReg[] }>({
    queryKey: ["/api/core/camp-checkins/today", activeBranchId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (activeBranchId) params.set("branchId", activeBranchId);
      const res = await fetchWithAuth(`/api/core/camp-checkins/today?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const checkInMutation = useMutation({
    mutationFn: async ({ id, paymentMethod, dropOffPerson }: { id: string; paymentMethod?: string; dropOffPerson?: string }) => {
      const res = await fetchWithAuth(`/api/core/camp-checkins/${id}/check-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: paymentMethod || undefined, dropOffPerson: dropOffPerson || undefined }),
      });
      if (!res.ok) throw new Error("Failed to check in");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Child checked in" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/camp-checkins/today"] });
      setCheckInDialog({ open: false, regId: null, authorizedPickup: null });
      setCheckInPayment("");
      setCheckInDropOff("");
    },
    onError: () => toast({ title: "Failed to check in", variant: "destructive" }),
  });

  const checkOutMutation = useMutation({
    mutationFn: async ({ id, pickUpPerson }: { id: string; pickUpPerson?: string }) => {
      const res = await fetchWithAuth(`/api/core/camp-checkins/${id}/check-out`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickUpPerson: pickUpPerson || undefined }),
      });
      if (!res.ok) throw new Error("Failed to check out");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Child checked out" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/camp-checkins/today"] });
      setCheckOutDialog({ open: false, regId: null, authorizedPickup: null, childName: null, childPhotoUrl: null });
      setCheckOutPickUp("");
    },
    onError: () => toast({ title: "Failed to check out", variant: "destructive" }),
  });

  const undoCheckInMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/api/core/camp-checkins/${id}/undo-check-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Check-in reverted" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/camp-checkins/today"] });
    },
    onError: () => toast({ title: "Failed to revert", variant: "destructive" }),
  });

  const undoCheckOutMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/api/core/camp-checkins/${id}/undo-check-out`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Check-out reverted" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/camp-checkins/today"] });
    },
    onError: () => toast({ title: "Failed to revert", variant: "destructive" }),
  });

  const camps = data?.camps ?? [];
  const registrations = data?.registrations ?? [];

  const filteredRegs = registrations.filter((r) => {
    const q = campSearch.toLowerCase();
    const matchesSearch = !campSearch ||
      r.childFullName.toLowerCase().includes(q) ||
      r.parentGuardianName.toLowerCase().includes(q) ||
      r.emergencyContactNumber.includes(campSearch);

    const matchesStatus =
      campStatusFilter === "all" ||
      (campStatusFilter === "not_checked_in" && r.attendanceStatus === "waiting") ||
      (campStatusFilter === "checked_in" && r.attendanceStatus === "checked_in") ||
      (campStatusFilter === "checked_out" && r.attendanceStatus === "checked_out");

    return matchesSearch && matchesStatus;
  });

  const checkedInCount = registrations.filter(r => r.attendanceStatus === "checked_in").length;
  const checkedOutCount = registrations.filter(r => r.attendanceStatus === "checked_out").length;
  const notCheckedInCount = registrations.filter(r => r.attendanceStatus === "waiting").length;

  const getCampName = (eventId: string) => camps.find(c => c.id === eventId)?.title ?? "";

  const getAge = (dob: string) => {
    try { return differenceInYears(new Date(), parseISO(dob)); } catch { return null; }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (camps.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Tent className="h-10 w-10 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No active camp today</p>
        <p className="text-sm mt-1">Camp events appear here on their scheduled days.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Active camp banner */}
      {camps.map(camp => (
        <div key={camp.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-500/10 border border-teal-500/20">
          <Tent className="h-4 w-4 text-teal-500 flex-shrink-0" />
          <span className="text-sm font-medium text-teal-700 dark:text-teal-400">{camp.title}</span>
        </div>
      ))}

      {/* Summary badges */}
      <div className="flex gap-2 flex-wrap">
        <Badge variant="outline" className="gap-1.5 text-xs">
          <Baby className="h-3 w-3" />
          {registrations.length} Registered
        </Badge>
        <Badge variant="outline" className="gap-1.5 text-xs text-green-700 border-green-300 bg-green-50 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
          <UserCheck className="h-3 w-3" />
          {checkedInCount} Present
        </Badge>
        <Badge variant="outline" className="gap-1.5 text-xs text-orange-700 border-orange-300 bg-orange-50 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800">
          <LogOut className="h-3 w-3" />
          {checkedOutCount} Left
        </Badge>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search child or parent..."
          value={campSearch}
          onChange={(e) => setCampSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        {(["all", "not_checked_in", "checked_in", "checked_out"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={campStatusFilter === f ? "default" : "outline"}
            onClick={() => setCampStatusFilter(f)}
          >
            {f === "all" && `All (${registrations.length})`}
            {f === "not_checked_in" && `Waiting (${notCheckedInCount})`}
            {f === "checked_in" && `Present (${checkedInCount})`}
            {f === "checked_out" && `Left (${checkedOutCount})`}
          </Button>
        ))}
      </div>

      {/* Registration cards */}
      {filteredRegs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm">
          No children match the filter.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRegs.map((reg) => {
            const age = getAge(reg.dateOfBirth);
            const isCheckedIn = reg.attendanceStatus === "checked_in";
            const isCheckedOut = reg.attendanceStatus === "checked_out";
            const isPending = checkInMutation.isPending || checkOutMutation.isPending ||
              undoCheckInMutation.isPending || undoCheckOutMutation.isPending;

            return (
              <Card key={reg.id} className={
                isCheckedOut
                  ? "border-orange-200 dark:border-orange-900/40"
                  : isCheckedIn
                    ? "border-green-200 dark:border-green-900/40"
                    : ""
              }>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    {/* Child photo */}
                    <div className="flex-shrink-0">
                      {reg.childPhotoUrl ? (
                        <img
                          src={reg.childPhotoUrl}
                          alt={reg.childFullName}
                          className="w-16 h-16 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center">
                          <Baby className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{reg.childFullName}</span>
                        {age !== null && (
                          <Badge variant="secondary" className="text-xs">{age}y</Badge>
                        )}
                        {camps.length > 1 && (
                          <Badge variant="outline" className="text-xs text-teal-600">{getCampName(reg.eventId)}</Badge>
                        )}
                      </div>
                      <div className="mt-1 space-y-0.5">
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {reg.parentGuardianName}
                        </p>
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {reg.emergencyContactNumber}
                        </p>
                      </div>
                      <div className="mt-2 flex gap-2 flex-wrap">
                        {isCheckedOut ? (
                          <Badge className="gap-1 bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800">
                            <LogOut className="h-3 w-3" />
                            Left {reg.attendanceCheckedOutAt ? format(new Date(reg.attendanceCheckedOutAt), "HH:mm") : ""}
                          </Badge>
                        ) : isCheckedIn ? (
                          <Badge className="gap-1 bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800">
                            <CheckCircle className="h-3 w-3" />
                            In {reg.attendanceCheckedInAt ? format(new Date(reg.attendanceCheckedInAt), "HH:mm") : ""}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            Waiting to check in
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-col gap-2 flex-shrink-0">
                      {isCheckedOut ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 text-xs"
                          onClick={() => undoCheckOutMutation.mutate(reg.id)}
                          disabled={isPending}
                        >
                          <RotateCcw className="h-3 w-3" />
                          Undo Out
                        </Button>
                      ) : isCheckedIn ? (
                        <>
                          <Button
                            size="sm"
                            className="gap-1 text-xs bg-orange-500 hover:bg-orange-600 text-white"
                            onClick={() => {
                              setCheckOutPickUp("");
                              setCheckOutDialog({ open: true, regId: reg.id, authorizedPickup: reg.authorizedPickupPersons ?? null, childName: reg.childFullName, childPhotoUrl: reg.childPhotoUrl ?? null });
                            }}
                            disabled={isPending}
                          >
                            <LogOut className="h-3 w-3" />
                            Check Out
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 text-xs"
                            onClick={() => undoCheckInMutation.mutate(reg.id)}
                            disabled={isPending}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Undo In
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          className="gap-1 text-xs bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => {
                            setCheckInPayment("");
                            setCheckInDropOff("");
                            setCheckInDialog({ open: true, regId: reg.id, authorizedPickup: reg.authorizedPickupPersons ?? null });
                          }}
                          disabled={isPending}
                        >
                          <UserCheck className="h-3 w-3" />
                          Check In
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Check-In Dialog */}
      <Dialog
        open={checkInDialog.open}
        onOpenChange={(o) => { if (!o) { setCheckInDialog({ open: false, regId: null, authorizedPickup: null }); setCheckInPayment(""); setCheckInDropOff(""); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check In Child</DialogTitle>
            <DialogDescription>Record payment and who dropped off the child.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Payment Method</Label>
              <Select value={checkInPayment} onValueChange={setCheckInPayment}>
                <SelectTrigger>
                  <SelectValue placeholder="Select method (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Card">Card</SelectItem>
                  <SelectItem value="QR">QR</SelectItem>
                  <SelectItem value="Prepaid">Prepaid</SelectItem>
                  <SelectItem value="Complimentary">Complimentary</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Dropped Off By</Label>
              <Input
                value={checkInDropOff}
                onChange={(e) => setCheckInDropOff(e.target.value)}
                placeholder="Name of person dropping off"
              />
              {checkInDialog.authorizedPickup && (
                <p className="text-xs text-muted-foreground">Authorized: {checkInDialog.authorizedPickup}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={() => setCheckInDialog({ open: false, regId: null, authorizedPickup: null })}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={checkInMutation.isPending}
              onClick={() => {
                if (checkInDialog.regId) {
                  checkInMutation.mutate({ id: checkInDialog.regId, paymentMethod: checkInPayment, dropOffPerson: checkInDropOff });
                }
              }}
            >
              <UserCheck className="h-4 w-4 mr-1" />
              {checkInMutation.isPending ? "Checking in…" : "Confirm Check In"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Check-Out Dialog */}
      <Dialog
        open={checkOutDialog.open}
        onOpenChange={(o) => { if (!o) { setCheckOutDialog({ open: false, regId: null, authorizedPickup: null, childName: null, childPhotoUrl: null }); setCheckOutPickUp(""); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check Out Child</DialogTitle>
            <DialogDescription>Record who is picking up the child.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Child photo + name for visual verification */}
            <div className="flex items-center gap-3">
              {checkOutDialog.childPhotoUrl ? (
                <img
                  src={checkOutDialog.childPhotoUrl}
                  alt="Child"
                  className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                  <Baby className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
              {checkOutDialog.childName && (
                <p className="font-semibold text-base">{checkOutDialog.childName}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Picked Up By</Label>
              <Input
                value={checkOutPickUp}
                onChange={(e) => setCheckOutPickUp(e.target.value)}
                placeholder="Name of person picking up"
              />
              {checkOutDialog.authorizedPickup && (
                <p className="text-xs text-muted-foreground">Authorized: {checkOutDialog.authorizedPickup}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={() => setCheckOutDialog({ open: false, regId: null, authorizedPickup: null, childName: null, childPhotoUrl: null })}>
              Cancel
            </Button>
            <Button
              className="bg-orange-500 hover:bg-orange-600 text-white"
              disabled={checkOutMutation.isPending}
              onClick={() => {
                if (checkOutDialog.regId) {
                  checkOutMutation.mutate({ id: checkOutDialog.regId, pickUpPerson: checkOutPickUp });
                }
              }}
            >
              <LogOut className="h-4 w-4 mr-1" />
              {checkOutMutation.isPending ? "Checking out…" : "Confirm Check Out"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================

export function CheckinsContent({ kioskMode = false, kioskToken, kioskBranchId }: CheckinsContentProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { activeBranchId: contextBranchId } = useBranchContext();
  const activeBranchId = kioskMode ? kioskBranchId : contextBranchId;
  const [searchQuery, setSearchQuery] = useState("");
  
  const getAuthHeaders = (): HeadersInit => {
    if (kioskMode && kioskToken) {
      return { "Authorization": `Bearer ${kioskToken}` };
    }
    return {};
  };
  
  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
    const credentials = kioskMode ? undefined : "include" as RequestCredentials;
    return fetch(url, { ...options, headers, credentials });
  };
  const [section, setSection] = useState<"services" | "camp">("services");
  const [activeTab, setActiveTab] = useState("registered");
  const [serviceFilter, setServiceFilter] = useState<"all" | "nanny" | "dropoff">("all");
  
  // Assign nanny dialog state
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [selectedCheckin, setSelectedCheckin] = useState<ServiceCheckin | null>(null);
  const [selectedNannyId, setSelectedNannyId] = useState<string>("");
  
  // Edit service dialog state
  const [showEditServiceDialog, setShowEditServiceDialog] = useState(false);
  const [editServiceType, setEditServiceType] = useState<"nanny" | "dropoff">("dropoff");
  const [editDurationHours, setEditDurationHours] = useState<string>("1");
  const [editStartTime, setEditStartTime] = useState<string>("");
  
  // Checkout dialog state
  const [showCheckoutDialog, setShowCheckoutDialog] = useState(false);
  const [checkoutCheckin, setCheckoutCheckin] = useState<ServiceCheckin | null>(null);
  const [pickupPhotoData, setPickupPhotoData] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const { data: checkins = [], isLoading } = useQuery<ServiceCheckin[]>({
    queryKey: ["/api/core/checkins", { status: activeTab, type: serviceFilter, q: searchQuery, branchId: activeBranchId, kioskMode }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("status", activeTab);
      if (serviceFilter !== "all") {
        params.set("type", serviceFilter);
      }
      if (searchQuery) {
        params.set("q", searchQuery);
      }
      if (activeBranchId) {
        params.set("branchId", activeBranchId);
      }
      const res = await fetchWithAuth(`/api/core/checkins?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch check-ins");
      return res.json();
    },
  });

  const { data: availableNannies = [], isFetching: isNanniesFetching } = useQuery<Employee[]>({
    queryKey: ["/api/core/nannies/available", selectedCheckin?.branchId, kioskMode],
    queryFn: async () => {
      if (!selectedCheckin?.branchId) return [];
      const res = await fetchWithAuth(`/api/core/nannies/available?branchId=${selectedCheckin.branchId}`);
      if (!res.ok) throw new Error("Failed to fetch available nannies");
      return res.json();
    },
    enabled: showAssignDialog && !!selectedCheckin?.branchId,
    placeholderData: (previousData) => previousData,
  });

  const enterParkMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/enter-park`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to enter park");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Guest has entered the park" });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/checkins" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/checkins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/nanny-schedule"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: async ({ id, outPhotoData }: { id: string; outPhotoData?: string }) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outPhotoData }),
      });
      if (!res.ok) throw new Error("Failed to checkout");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Child checked out successfully" });
      setShowCheckoutDialog(false);
      setCheckoutCheckin(null);
      setPickupPhotoData(null);
      stopCamera();
      queryClient.invalidateQueries({ queryKey: ["/api/core/checkins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/nanny-schedule"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const revertCheckoutMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/revert-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to revert checkout");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Checkout reverted - child is back in park" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/checkins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/nanny-schedule"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateServiceMutation = useMutation({
    mutationFn: async ({ id, serviceType, durationHours, startTime }: { id: string; serviceType: string; durationHours?: string; startTime?: string }) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/service`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceType, durationHours, startTime }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update service");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Service updated" });
      setShowEditServiceDialog(false);
      setSelectedCheckin(null);
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/checkins" });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/nanny-schedule" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignNannyMutation = useMutation({
    mutationFn: async ({ id, nannyEmployeeId }: { id: string; nannyEmployeeId: string }) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/assign-nanny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nannyEmployeeId }),
      });
      if (!res.ok) throw new Error("Failed to assign nanny");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Nanny assigned" });
      setShowAssignDialog(false);
      setSelectedCheckin(null);
      setSelectedNannyId("");
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/checkins" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const extendTimeMutation = useMutation({
    mutationFn: async ({ id, additionalMinutes }: { id: string; additionalMinutes: number }) => {
      const res = await fetchWithAuth(`/api/core/checkins/${id}/extend-time`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additionalMinutes }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to extend time");
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      const hours = variables.additionalMinutes >= 60 ? Math.floor(variables.additionalMinutes / 60) : 0;
      const mins = variables.additionalMinutes % 60;
      const timeLabel = hours > 0 ? (mins > 0 ? `${hours}h ${mins}min` : `${hours}h`) : `${mins}min`;
      toast({ title: `Time extended by ${timeLabel}` });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/checkins" });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/core/nanny-schedule" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleExtendTime = (checkinId: string, minutes: number) => {
    extendTimeMutation.mutate({ id: checkinId, additionalMinutes: minutes });
  };

  const filteredCheckins = checkins.filter((c) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      c.childFullName?.toLowerCase().includes(query) ||
      c.parentFullName?.toLowerCase().includes(query) ||
      c.whatsappPhoneRaw?.includes(searchQuery)
    );
  });

  const startCamera = async (facing?: "user" | "environment") => {
    const facingMode = facing || cameraFacing;
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } } 
      });
      streamRef.current = stream;
      setIsCapturing(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 100);
    } catch (error) {
      console.error("Camera error:", error);
      toast({ title: "Camera Error", description: "Could not access camera", variant: "destructive" });
    }
  };

  const toggleCamera = async () => {
    const newFacing = cameraFacing === "user" ? "environment" : "user";
    setCameraFacing(newFacing);
    await startCamera(newFacing);
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
  };

  const capturePhoto = () => {
    if (!videoRef.current) {
      toast({ title: "Error", description: "Camera not ready", variant: "destructive" });
      return;
    }
    const video = videoRef.current;
    // Ensure video has valid dimensions
    if (!video.videoWidth || !video.videoHeight) {
      toast({ title: "Error", description: "Camera still loading, please wait", variant: "destructive" });
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      if (cameraFacing === "user") {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      setPickupPhotoData(dataUrl);
      stopCamera();
    }
  };

  const handleEnterPark = (checkin: ServiceCheckin) => {
    enterParkMutation.mutate(checkin.id);
  };

  const handleCheckOut = (checkin: ServiceCheckin) => {
    setCheckoutCheckin(checkin);
    setPickupPhotoData(null);
    setShowCheckoutDialog(true);
  };

  const confirmCheckout = () => {
    if (!checkoutCheckin) return;
    checkoutMutation.mutate({ id: checkoutCheckin.id, outPhotoData: pickupPhotoData || undefined });
  };

  const handleRevertCheckout = (checkin: ServiceCheckin) => {
    revertCheckoutMutation.mutate(checkin.id);
  };

  const handleEditService = (checkin: ServiceCheckin) => {
    setSelectedCheckin(checkin);
    setEditServiceType((checkin.serviceType as "nanny" | "dropoff") || "dropoff");
    setEditDurationHours(checkin.requestedDurationMinutes ? String(checkin.requestedDurationMinutes / 60) : "1");
    // Auto-set to current time (exact, not rounded)
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    setEditStartTime(`${hours}:${minutes}`);
    setShowEditServiceDialog(true);
  };

  const handleAssignNanny = (checkin: ServiceCheckin) => {
    setSelectedCheckin(checkin);
    setSelectedNannyId("");
    setShowAssignDialog(true);
  };

  const confirmEditService = () => {
    if (!selectedCheckin) return;
    updateServiceMutation.mutate({
      id: selectedCheckin.id,
      serviceType: editServiceType,
      durationHours: editDurationHours,
      startTime: editStartTime,
    });
  };

  const confirmAssignNanny = () => {
    if (!selectedCheckin || !selectedNannyId) return;
    assignNannyMutation.mutate({ id: selectedCheckin.id, nannyEmployeeId: selectedNannyId });
  };

  return (
    <>
      <div className="p-4 space-y-4 max-w-lg mx-auto">
        <h1 className="text-xl font-bold">Check-ins</h1>

        {/* Section switcher */}
        <div className="flex rounded-lg border overflow-hidden">
          <button
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors ${
              section === "services"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setSection("services")}
          >
            <Users className="h-4 w-4" />
            Drop-Off &amp; Nanny
          </button>
          <button
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors border-l ${
              section === "camp"
                ? "bg-teal-600 text-white"
                : "bg-background text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setSection("camp")}
          >
            <Tent className="h-4 w-4" />
            Camp
          </button>
        </div>

        {/* Camp section */}
        {section === "camp" && (
          <CampCheckins activeBranchId={activeBranchId} fetchWithAuth={fetchWithAuth} />
        )}

        {/* Services section */}
        {section === "services" && <>

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
            <TabsTrigger value="registered" className="flex-1" data-testid="tab-registered">
              Registered
            </TabsTrigger>
            <TabsTrigger value="in_park" className="flex-1" data-testid="tab-in-park">
              In Park
            </TabsTrigger>
            <TabsTrigger value="checked_out" className="flex-1" data-testid="tab-checked-out">
              Out
            </TabsTrigger>
            <TabsTrigger value="nanny_schedule" className="flex-1" data-testid="tab-nanny-schedule">
              <Calendar className="h-4 w-4 mr-1" />
              Schedule
            </TabsTrigger>
          </TabsList>

          <TabsContent value="registered" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredCheckins.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No registered check-ins
              </div>
            ) : (
              filteredCheckins.map((checkin) => (
                <CheckinCard
                  key={checkin.id}
                  checkin={checkin}
                  onEnterPark={() => handleEnterPark(checkin)}
                  onEditService={() => handleEditService(checkin)}
                  onAssignNanny={() => handleAssignNanny(checkin)}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="in_park" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredCheckins.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No children currently in the park
              </div>
            ) : (
              filteredCheckins.map((checkin) => (
                <CheckinCard
                  key={checkin.id}
                  checkin={checkin}
                  onCheckOut={() => handleCheckOut(checkin)}
                  onEditService={() => handleEditService(checkin)}
                  onAssignNanny={() => handleAssignNanny(checkin)}
                  onExtendTime={(minutes) => handleExtendTime(checkin.id, minutes)}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="checked_out" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredCheckins.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No check-outs today
              </div>
            ) : (
              filteredCheckins.map((checkin) => (
                <Card key={checkin.id} data-testid={`checked-out-${checkin.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex gap-2">
                        {checkin.photoUrl && (
                          <img src={checkin.photoUrl} alt="Check-in" className="w-12 h-12 rounded-lg object-cover" />
                        )}
                        {checkin.outPhotoUrl && (
                          <img src={checkin.outPhotoUrl} alt="Check-out" className="w-12 h-12 rounded-lg object-cover border-2 border-green-500" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{checkin.childFullName}</h3>
                          <Badge variant="outline" className="text-xs bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Out
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{checkin.parentFullName}</p>
                        {checkin.checkedOutAt && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Left at {format(new Date(checkin.checkedOutAt), "h:mm a")}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRevertCheckout(checkin)}
                        disabled={revertCheckoutMutation.isPending}
                        className="gap-1"
                        data-testid={`revert-checkout-${checkin.id}`}
                      >
                        <RotateCcw className="h-4 w-4" />
                        Revert
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="nanny_schedule" className="mt-4">
            {activeBranchId ? (
              <NannyCalendar branchId={activeBranchId} fetchWithAuth={fetchWithAuth} />
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Please select a branch to view nanny schedule
              </div>
            )}
          </TabsContent>
        </Tabs>
        </>}
      </div>

      {/* Assign Service Details Dialog */}
      <Dialog open={showEditServiceDialog} onOpenChange={setShowEditServiceDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Service Details</DialogTitle>
            <DialogDescription>
              {selectedCheckin && (
                <>Set service type, time and duration for <strong>{selectedCheckin.childFullName}</strong></>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Service Type</Label>
              <Select value={editServiceType} onValueChange={(v: "nanny" | "dropoff") => setEditServiceType(v)}>
                <SelectTrigger data-testid="select-service-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dropoff">Drop-Off (6-8 years, 200 THB one-time)</SelectItem>
                  <SelectItem value="nanny">Nanny Service (3-5 years, 300 THB/hour)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-center block mb-2">Starting Time</Label>
              <TimeWheelPicker
                value={editStartTime}
                onChange={setEditStartTime}
                minHour={6}
                maxHour={21}
              />
            </div>
            <div>
              <Label>Duration</Label>
              <Select value={editDurationHours} onValueChange={setEditDurationHours}>
                <SelectTrigger data-testid="select-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 hour</SelectItem>
                  <SelectItem value="2">2 hours</SelectItem>
                  <SelectItem value="3">3 hours</SelectItem>
                  <SelectItem value="4">4 hours</SelectItem>
                  <SelectItem value="5">5 hours</SelectItem>
                  <SelectItem value="6">6 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditServiceDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmEditService}
              disabled={updateServiceMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {updateServiceMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Nanny Dialog */}
      <Dialog open={showAssignDialog} onOpenChange={setShowAssignDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Nanny</DialogTitle>
            <DialogDescription>
              {selectedCheckin && (
                <>Select a nanny for <strong>{selectedCheckin.childFullName}</strong></>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isNanniesFetching && availableNannies.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground">
                <p>Loading available nannies...</p>
              </div>
            ) : availableNannies.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground">
                <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-500" />
                <p>No nannies available</p>
                <p className="text-sm">All nannies are either not clocked in or already assigned.</p>
              </div>
            ) : (
              <Select value={selectedNannyId} onValueChange={setSelectedNannyId}>
                <SelectTrigger data-testid="select-nanny">
                  <SelectValue placeholder="Select a nanny..." />
                </SelectTrigger>
                <SelectContent>
                  {availableNannies.map((nanny) => (
                    <SelectItem key={nanny.id} value={nanny.id}>
                      {nanny.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssignDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmAssignNanny}
              disabled={!selectedNannyId || assignNannyMutation.isPending}
              data-testid="button-confirm-assign"
            >
              {assignNannyMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Assigning...
                </>
              ) : (
                "Assign"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Checkout Dialog */}
      <Dialog open={showCheckoutDialog} onOpenChange={(open) => {
        if (!open) {
          stopCamera();
          setPickupPhotoData(null);
        }
        setShowCheckoutDialog(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Check Out Child</DialogTitle>
            <DialogDescription>
              {checkoutCheckin && (
                <>Confirm pickup for <strong>{checkoutCheckin.childFullName}</strong></>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-sm text-muted-foreground mb-2 block">Drop-off Photo (who brought the child)</Label>
              {checkoutCheckin?.photoUrl ? (
                <img 
                  src={checkoutCheckin.photoUrl} 
                  alt="Drop-off" 
                  className="w-full max-h-64 object-contain rounded-lg border"
                />
              ) : (
                <div className="w-full h-32 bg-muted rounded-lg flex items-center justify-center">
                  <span className="text-muted-foreground">No drop-off photo</span>
                </div>
              )}
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-2 block">Pickup Photo (who is picking up)</Label>
              {pickupPhotoData ? (
                <div className="relative">
                  <img 
                    src={pickupPhotoData} 
                    alt="Pickup" 
                    className="w-full max-h-64 object-contain rounded-lg border border-green-500"
                  />
                  <Button
                    size="icon"
                    variant="destructive"
                    className="absolute top-2 right-2 h-8 w-8"
                    onClick={() => setPickupPhotoData(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : isCapturing ? (
                <div className="relative">
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    className="w-full max-h-64 object-contain rounded-lg border"
                    style={cameraFacing === "user" ? { transform: "scaleX(-1)" } : undefined}
                  />
                  <div className="absolute top-2 right-2">
                    <Button 
                      variant="secondary" 
                      size="icon" 
                      onClick={toggleCamera}
                      className="bg-black/50 hover:bg-black/70"
                      data-testid="button-switch-camera"
                    >
                      <RefreshCw className="h-5 w-5 text-white" />
                    </Button>
                  </div>
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-2">
                    <Button onClick={capturePhoto} className="gap-1" data-testid="button-capture-photo">
                      <Camera className="h-4 w-4" />
                      Capture
                    </Button>
                    <Button variant="outline" onClick={stopCamera}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button 
                  variant="outline" 
                  className="w-full h-32 flex flex-col gap-2"
                  onClick={() => startCamera()}
                  data-testid="button-start-camera"
                >
                  <Camera className="h-8 w-8" />
                  <span>Take Pickup Photo</span>
                </Button>
              )}
            </div>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => {
              stopCamera();
              setShowCheckoutDialog(false);
            }}>
              Cancel
            </Button>
            <Button
              onClick={confirmCheckout}
              disabled={checkoutMutation.isPending}
              data-testid="button-confirm-checkout"
            >
              {checkoutMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Checking out...
                </>
              ) : (
                <>
                  <LogOut className="h-4 w-4 mr-2" />
                  Confirm Check Out
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function CheckinsPage() {
  return <CheckinsContent />;
}
