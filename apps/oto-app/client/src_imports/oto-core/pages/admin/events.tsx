import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, ArrowLeft, Clock, Users, Cake, PartyPopper, GraduationCap, CalendarDays } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import type { Event, Branch } from "@shared/schema";

interface EventFormData {
  branchId: string;
  eventType: "birthday" | "private_event" | "school_group" | "other";
  title: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  childName: string;
  bookingName: string;
  parentName: string;
  whatsappPhoneRaw: string;
  numChildren: number | null;
  numAdults: number | null;
  programName: string;
  programDetails: string;
  allergiesNotes: string;
  cakeNotes: string;
  specialRequests: string;
  internalStaffNotes: string;
  status: "upcoming" | "in_progress" | "completed" | "cancelled";
}

const defaultFormData: EventFormData = {
  branchId: "",
  eventType: "birthday",
  title: "",
  eventDate: format(new Date(), "yyyy-MM-dd"),
  startTime: "14:00",
  endTime: "",
  childName: "",
  bookingName: "",
  parentName: "",
  whatsappPhoneRaw: "",
  numChildren: null,
  numAdults: null,
  programName: "",
  programDetails: "",
  allergiesNotes: "",
  cakeNotes: "",
  specialRequests: "",
  internalStaffNotes: "",
  status: "upcoming",
};

const eventTypeIcons: Record<string, typeof Cake> = {
  birthday: Cake,
  private_event: PartyPopper,
  school_group: GraduationCap,
  other: CalendarDays,
};

export default function AdminEventsPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast } = useToast();
  
  const [showDialog, setShowDialog] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EventFormData>(defaultFormData);

  const { data: events, isLoading } = useQuery<Event[]>({
    queryKey: ["/api/admin/events"],
    enabled: !!user,
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/admin/branches"],
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (data: EventFormData) => {
      const res = await apiRequest("POST", "/api/admin/events", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      setShowDialog(false);
      setFormData(defaultFormData);
      toast({ title: "Event created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create event", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<EventFormData> }) => {
      const res = await apiRequest("PATCH", `/api/admin/events/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      setShowDialog(false);
      setEditingEvent(null);
      setFormData(defaultFormData);
      toast({ title: "Event updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update event", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/events/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      setDeleteEventId(null);
      toast({ title: "Event cancelled successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel event", description: error.message, variant: "destructive" });
    },
  });

  const openCreateDialog = () => {
    setEditingEvent(null);
    setFormData({
      ...defaultFormData,
      branchId: user?.branchId || branches?.[0]?.id || "",
    });
    setShowDialog(true);
  };

  const openEditDialog = (event: Event) => {
    setEditingEvent(event);
    setFormData({
      branchId: event.branchId,
      eventType: event.eventType as EventFormData["eventType"],
      title: event.title,
      eventDate: event.eventDate,
      startTime: event.startTime,
      endTime: event.endTime || "",
      childName: event.childName || "",
      bookingName: event.bookingName || "",
      parentName: event.parentName || "",
      whatsappPhoneRaw: event.whatsappPhoneRaw || "",
      numChildren: event.numChildren,
      numAdults: event.numAdults,
      programName: event.programName || "",
      programDetails: event.programDetails || "",
      allergiesNotes: event.allergiesNotes || "",
      cakeNotes: event.cakeNotes || "",
      specialRequests: event.specialRequests || "",
      internalStaffNotes: event.internalStaffNotes || "",
      status: event.status as EventFormData["status"],
    });
    setShowDialog(true);
  };

  const handleSubmit = () => {
    if (editingEvent) {
      updateMutation.mutate({ id: editingEvent.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link href="/admin">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{t.events.title}</h1>
            <p className="text-sm text-muted-foreground">Manage events and birthdays</p>
          </div>
          <Button onClick={openCreateDialog} data-testid="button-create-event">
            <Plus className="h-4 w-4 mr-2" />
            {t.events.createEvent}
          </Button>
        </div>

        <div className="space-y-3">
          {!events || events.length === 0 ? (
            <EmptyState
              title={t.events.noEvents}
              description={t.events.noEventsDesc}
            />
          ) : (
            events.map((event) => {
              const Icon = eventTypeIcons[event.eventType] || CalendarDays;
              return (
                <Card key={event.id} data-testid={`card-event-${event.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Icon className="h-5 w-5 text-muted-foreground mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold">{event.title}</span>
                          <Badge variant="secondary" className="text-xs">
                            {event.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                          <span>{event.eventDate}</span>
                          <span>{event.startTime}</span>
                          {event.numChildren && <span>{event.numChildren} children</span>}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEditDialog(event)}
                          data-testid={`button-edit-event-${event.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteEventId(event.id)}
                          data-testid={`button-delete-event-${event.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingEvent ? t.events.editEvent : t.events.createEvent}</DialogTitle>
            <DialogDescription>
              {editingEvent ? "Update event details" : "Create a new event or birthday party"}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Branch</Label>
                <Select
                  value={formData.branchId}
                  onValueChange={(v) => setFormData(prev => ({ ...prev, branchId: v }))}
                >
                  <SelectTrigger data-testid="select-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches?.map(branch => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Event Type</Label>
                <Select
                  value={formData.eventType}
                  onValueChange={(v) => setFormData(prev => ({ ...prev, eventType: v as EventFormData["eventType"] }))}
                >
                  <SelectTrigger data-testid="select-event-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="birthday">{t.events.birthday}</SelectItem>
                    <SelectItem value="private_event">{t.events.privateEvent}</SelectItem>
                    <SelectItem value="school_group">{t.events.schoolGroup}</SelectItem>
                    <SelectItem value="other">{t.events.other}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Lily's Birthday Party"
                data-testid="input-title"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={formData.eventDate}
                  onChange={(e) => setFormData(prev => ({ ...prev, eventDate: e.target.value }))}
                  data-testid="input-date"
                />
              </div>
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input
                  type="time"
                  value={formData.startTime}
                  onChange={(e) => setFormData(prev => ({ ...prev, startTime: e.target.value }))}
                  data-testid="input-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label>End Time</Label>
                <Input
                  type="time"
                  value={formData.endTime}
                  onChange={(e) => setFormData(prev => ({ ...prev, endTime: e.target.value }))}
                  data-testid="input-end-time"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.checkins.childName}</Label>
                <Input
                  value={formData.childName}
                  onChange={(e) => setFormData(prev => ({ ...prev, childName: e.target.value }))}
                  data-testid="input-child-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Booking Name</Label>
                <Input
                  value={formData.bookingName}
                  onChange={(e) => setFormData(prev => ({ ...prev, bookingName: e.target.value }))}
                  data-testid="input-booking-name"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.checkins.parentName}</Label>
                <Input
                  value={formData.parentName}
                  onChange={(e) => setFormData(prev => ({ ...prev, parentName: e.target.value }))}
                  data-testid="input-parent-name"
                />
              </div>
              <div className="space-y-2">
                <Label>WhatsApp Phone</Label>
                <Input
                  value={formData.whatsappPhoneRaw}
                  onChange={(e) => setFormData(prev => ({ ...prev, whatsappPhoneRaw: e.target.value }))}
                  placeholder="+66 xxx xxx xxxx"
                  data-testid="input-whatsapp"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.events.children}</Label>
                <Input
                  type="number"
                  value={formData.numChildren || ""}
                  onChange={(e) => setFormData(prev => ({ ...prev, numChildren: e.target.value ? parseInt(e.target.value) : null }))}
                  data-testid="input-num-children"
                />
              </div>
              <div className="space-y-2">
                <Label>{t.events.adults}</Label>
                <Input
                  type="number"
                  value={formData.numAdults || ""}
                  onChange={(e) => setFormData(prev => ({ ...prev, numAdults: e.target.value ? parseInt(e.target.value) : null }))}
                  data-testid="input-num-adults"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t.events.program}</Label>
              <Input
                value={formData.programName}
                onChange={(e) => setFormData(prev => ({ ...prev, programName: e.target.value }))}
                placeholder="e.g., Standard Birthday Package"
                data-testid="input-program-name"
              />
            </div>

            <div className="space-y-2">
              <Label>Program Details</Label>
              <Textarea
                value={formData.programDetails}
                onChange={(e) => setFormData(prev => ({ ...prev, programDetails: e.target.value }))}
                placeholder="Schedule, activities, inclusions..."
                data-testid="input-program-details"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.events.allergies}</Label>
                <Textarea
                  value={formData.allergiesNotes}
                  onChange={(e) => setFormData(prev => ({ ...prev, allergiesNotes: e.target.value }))}
                  className="min-h-[60px]"
                  data-testid="input-allergies"
                />
              </div>
              <div className="space-y-2">
                <Label>{t.events.cake}</Label>
                <Textarea
                  value={formData.cakeNotes}
                  onChange={(e) => setFormData(prev => ({ ...prev, cakeNotes: e.target.value }))}
                  className="min-h-[60px]"
                  data-testid="input-cake"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t.events.specialRequests}</Label>
              <Textarea
                value={formData.specialRequests}
                onChange={(e) => setFormData(prev => ({ ...prev, specialRequests: e.target.value }))}
                data-testid="input-special-requests"
              />
            </div>

            <div className="space-y-2">
              <Label>Internal Staff Notes</Label>
              <Textarea
                value={formData.internalStaffNotes}
                onChange={(e) => setFormData(prev => ({ ...prev, internalStaffNotes: e.target.value }))}
                placeholder="Notes visible only to staff..."
                data-testid="input-internal-notes"
              />
            </div>

            {editingEvent && (
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(v) => setFormData(prev => ({ ...prev, status: v as EventFormData["status"] }))}
                >
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upcoming">{t.events.status.upcoming}</SelectItem>
                    <SelectItem value="in_progress">{t.events.status.inProgress}</SelectItem>
                    <SelectItem value="completed">{t.events.status.completed}</SelectItem>
                    <SelectItem value="cancelled">{t.events.status.cancelled}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!formData.title || !formData.branchId || createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-event"
            >
              {createMutation.isPending || updateMutation.isPending ? t.common.loading : t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteEventId} onOpenChange={(open) => !open && setDeleteEventId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Event?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the event as cancelled. The event will remain in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteEventId && deleteMutation.mutate(deleteEventId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-cancel"
            >
              {deleteMutation.isPending ? t.common.loading : "Cancel Event"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
