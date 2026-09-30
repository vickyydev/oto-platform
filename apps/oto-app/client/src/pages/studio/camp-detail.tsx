import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { QRCodeSVG } from "qrcode.react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Pencil,
  Calendar,
  Clock,
  Users,
  MapPin,
  FileText,
  Baby,
  UserCheck,
  UserX,
  LogOut,
  Tent,
  Link as LinkIcon,
  Check,
  Trash2,
  ChevronDown,
  XCircle,
  Ban,
  RotateCcw,
  AlertTriangle,
  QrCode,
  Download,
  CalendarPlus,
  Upload,
  User,
  Phone,
  Heart,
  Info,
  Plus,
  Search,
  UserPlus,
  ClipboardList,
  Loader2,
  Star,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format, parseISO, differenceInDays, differenceInYears, eachDayOfInterval } from "date-fns";
import { ChildProfileEditor } from "@/components/camp/child-profile-editor";

export default function CampDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();

  const [showEditSheet, setShowEditSheet] = useState(false);
  const [showStartCal, setShowStartCal] = useState(false);
  const [showEndCal, setShowEndCal] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [registrationFilter, setRegistrationFilter] = useState<"all" | "today">("all");
  const [showCancelCampDialog, setShowCancelCampDialog] = useState(false);
  const [showQrDialog, setShowQrDialog] = useState(false);

  // Add Child Dialog
  const [showAddChildDialog, setShowAddChildDialog] = useState(false);
  const [addChildFlow, setAddChildFlow] = useState<"pick" | "existing" | "new" | "one_time">("pick");
  const [childSearch, setChildSearch] = useState("");
  const [childSearchResults, setChildSearchResults] = useState<any[]>([]);
  const [childSearchLoading, setChildSearchLoading] = useState(false);
  const [selectedExistingChild, setSelectedExistingChild] = useState<any | null>(null);
  const [newChildForm, setNewChildForm] = useState({
    childFullName: "", dateOfBirth: "", primaryLanguage: "", childPhotoUrl: "",
    allergies: "", foodRestrictions: "", behavioralNotes: "", specialNotes: "",
    authorizedPickupPersons: "", parentGuardianName: "", emergencyContactNumber: "",
  });
  const [oneTimeForm, setOneTimeForm] = useState({
    childFullName: "", approximateAge: "", parentGuardianName: "", emergencyContactNumber: "",
  });
  const [addChildDays, setAddChildDays] = useState<Set<string>>(new Set());
  const [addChildPhotoUploading, setAddChildPhotoUploading] = useState(false);
  // Convert one-time dialog
  const [convertReg, setConvertReg] = useState<any | null>(null);
  const [convertForm, setConvertForm] = useState({
    childFullName: "",
    dateOfBirth: "",
    primaryLanguage: "",
    childPhotoUrl: "",
    allergies: "",
    foodRestrictions: "",
    behavioralNotes: "",
    authorizedPickupPersons: "",
    parentGuardianName: "",
    emergencyContactNumber: "",
    specialNotes: "",
  });
  const [convertPhotoUploading, setConvertPhotoUploading] = useState(false);

  // Child Profile Sheet
  const [childProfileReg, setChildProfileReg] = useState<any | null>(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [profileForm, setProfileForm] = useState<{
    childFullName: string;
    dateOfBirth: string;
    primaryLanguage: string;
    allergies: string;
    foodRestrictions: string;
    behavioralNotes: string;
    specialNotes: string;
    authorizedPickupPersons: string;
    parentContacts: Array<{ name: string; phone: string }>;
    childPhotoUrl: string;
  }>({
    childFullName: "", dateOfBirth: "", primaryLanguage: "", allergies: "",
    foodRestrictions: "", behavioralNotes: "", specialNotes: "",
    authorizedPickupPersons: "", parentContacts: [{ name: "", phone: "" }],
    childPhotoUrl: "",
  });
  const [profileDaySelected, setProfileDaySelected] = useState<Set<string>>(new Set());
  const [profilePhotoUploading, setProfilePhotoUploading] = useState(false);

  // Attendance History
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [editAtt, setEditAtt] = useState<{ row: any; payment: string; dropOff: string; pickUp: string; notes: string } | null>(null);
  const [editData, setEditData] = useState({
    title: "",
    eventDate: "",
    campEndDate: "",
    startTime: "",
    endTime: "",
    programName: "",
    specialRequests: "",
    numChildren: null as number | null,
    branchId: null as string | null,
    campDayHosts: {} as Record<string, string>,
    campCancelledDays: [] as string[],
  });

  const { data: event, isLoading } = useQuery<any>({
    queryKey: [`/api/admin/events/${id}`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/events/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["/api/branches"],
    queryFn: async () => {
      const res = await fetch("/api/branches", { credentials: "include" });
      return res.json();
    },
  });

  const { data: allEmployees = [] } = useQuery<any[]>({
    queryKey: ["/api/employees"],
    queryFn: async () => {
      const res = await fetch("/api/employees", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: registrations = [] } = useQuery<any[]>({
    queryKey: [`/api/admin/events/${id}/registrations`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/events/${id}/registrations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load registrations");
      return res.json();
    },
    enabled: !!id,
  });

  const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());

  const { data: todayAttendanceData } = useQuery<{ attendance: any[] }>({
    queryKey: [`/api/events/${id}/camp-attendance`, "today", todayStr],
    queryFn: async () => {
      const res = await fetch(`/api/events/${id}/camp-attendance?from=${todayStr}&to=${todayStr}`, { credentials: "include" });
      if (!res.ok) return { attendance: [] };
      return res.json();
    },
    enabled: !!id,
    refetchInterval: 30000,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery<{ attendance: any[] }>({
    queryKey: [`/api/events/${id}/camp-attendance`, "history", historyFrom, historyTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (historyFrom) params.set("from", historyFrom);
      if (historyTo) params.set("to", historyTo);
      const res = await fetch(`/api/events/${id}/camp-attendance?${params}`, { credentials: "include" });
      if (!res.ok) return { attendance: [] };
      return res.json();
    },
    enabled: !!id,
    refetchOnMount: "always",
    refetchInterval: 30000,
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: any) => {
      return apiRequest("PATCH", `/api/admin/events/${id}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}`] });
      queryClient.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) && (q.queryKey[0] === "/api/admin/events" || q.queryKey[0] === "/api/events")
      });
      setShowEditSheet(false);
      toast({ title: "Camp updated" });
    },
    onError: () => {
      toast({ title: "Failed to update camp", variant: "destructive" });
    },
  });

  const cancelDayMutation = useMutation({
    mutationFn: async ({ date, cancelled }: { date: string; cancelled: boolean }) => {
      const current: string[] = Array.isArray(event?.campCancelledDays) ? event.campCancelledDays : [];
      const next = cancelled
        ? [...new Set([...current, date])]
        : current.filter((d) => d !== date);
      return apiRequest("PATCH", `/api/admin/events/${id}`, { campCancelledDays: next });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}`] });
      queryClient.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) && (q.queryKey[0] === "/api/admin/events" || q.queryKey[0] === "/api/events")
      });
      toast({ title: "Camp day updated" });
    },
    onError: () => {
      toast({ title: "Failed to update camp day", variant: "destructive" });
    },
  });

  const cancelCampMutation = useMutation({
    mutationFn: async (cancelled: boolean) => {
      return apiRequest("PATCH", `/api/admin/events/${id}`, {
        status: cancelled ? "cancelled" : "upcoming",
      });
    },
    onSuccess: (_, cancelled) => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}`] });
      queryClient.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) && (q.queryKey[0] === "/api/admin/events" || q.queryKey[0] === "/api/events")
      });
      toast({ title: cancelled ? "Camp cancelled" : "Camp reactivated" });
      setShowCancelCampDialog(false);
    },
    onError: () => {
      toast({ title: "Failed to update camp status", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", `/api/admin/events/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Camp event deleted" });
      queryClient.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) && (q.queryKey[0] === "/api/admin/events" || q.queryKey[0] === "/api/events")
      });
      navigate("/studio/events");
    },
    onError: () => {
      toast({ title: "Failed to delete camp event", variant: "destructive" });
    },
  });

  const editAttMutation = useMutation({
    mutationFn: async ({ regId, date, payment, dropOff, pickUp, notes }: { regId: string; date: string; payment: string; dropOff: string; pickUp: string; notes: string }) => {
      return apiRequest("PATCH", `/api/core/camp-checkins/${regId}/attendance`, {
        date,
        paymentMethod: payment || null,
        dropOffPerson: dropOff || null,
        pickUpPerson: pickUp || null,
        staffNotes: notes || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === `/api/events/${id}/camp-attendance`
      });
      setEditAtt(null);
      toast({ title: "Attendance updated" });
    },
    onError: () => {
      toast({ title: "Failed to update attendance", variant: "destructive" });
    },
  });

  const updateAttendanceDaysMutation = useMutation({
    mutationFn: async ({ regId, addDates, removeDates }: { regId: string; addDates: string[]; removeDates: string[] }) => {
      const res = await apiRequest("PATCH", `/api/events/${id}/camp-registrations/${regId}/attendance-days`, { addDates, removeDates });
      return res.json() as Promise<{ attendanceDays: string[] }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}/registrations`] });
      // Update the in-sheet reg reference so the day picker reflects the saved state
      setChildProfileReg((prev: any) => prev ? { ...prev, attendanceDays: data?.attendanceDays ?? prev.attendanceDays } : prev);
      toast({ title: "Attendance days updated" });
    },
    onError: (err: any) => {
      const msg = err?.message || "Failed to update attendance days";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const updateCampRegistrationProfile = useMutation({
    mutationFn: async ({ regId, payload }: { regId: string; payload: Record<string, any> }) => {
      return apiRequest("PATCH", `/api/events/${id}/camp-registrations/${regId}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}/registrations`] });
      setChildProfileReg(null);
      toast({ title: "Profile updated", description: "Changes have been saved and synced across all camps." });
    },
    onError: () => {
      toast({ title: "Failed to update profile", variant: "destructive" });
    },
  });

  const addChildMutation = useMutation({
    mutationFn: async (payload: Record<string, any>) => {
      const res = await apiRequest("POST", `/api/admin/events/${id}/camp-registrations/manager`, payload);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}/registrations`] });
      setShowAddChildDialog(false);
      toast({
        title: data.merged ? "Days added to existing registration" : "Child added to camp",
        description: data.registration?.childFullName || "",
      });
    },
    onError: () => {
      toast({ title: "Failed to add child", variant: "destructive" });
    },
  });

  const convertToFullMutation = useMutation({
    mutationFn: async ({ regId, payload }: { regId: string; payload: Record<string, any> }) => {
      const res = await apiRequest("POST", `/api/admin/events/${id}/camp-registrations/${regId}/convert`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}/registrations`] });
      setConvertReg(null);
      toast({ title: "Converted to full profile" });
    },
    onError: () => {
      toast({ title: "Failed to convert profile", variant: "destructive" });
    },
  });

  const removeFromCampMutation = useMutation({
    mutationFn: async (regId: string) => {
      return apiRequest("DELETE", `/api/events/${id}/camp-registrations/${regId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/events/${id}/registrations`] });
      setChildProfileReg(null);
      setShowRemoveConfirm(false);
      toast({ title: "Removed from camp", description: "The registration has been removed. The child's profile history is preserved." });
    },
    onError: () => {
      toast({ title: "Failed to remove registration", variant: "destructive" });
    },
  });

  const openAddChildDialog = () => {
    setAddChildFlow("pick");
    setChildSearch("");
    setChildSearchResults([]);
    setSelectedExistingChild(null);
    setNewChildForm({
      childFullName: "", dateOfBirth: "", primaryLanguage: "", childPhotoUrl: "",
      allergies: "", foodRestrictions: "", behavioralNotes: "", specialNotes: "",
      authorizedPickupPersons: "", parentGuardianName: "", emergencyContactNumber: "",
    });
    setOneTimeForm({ childFullName: "", approximateAge: "", parentGuardianName: "", emergencyContactNumber: "" });
    setAddChildDays(new Set());
    setShowAddChildDialog(true);
  };

  const searchChildren = async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) { setChildSearchResults([]); return; }
    setChildSearchLoading(true);
    try {
      const res = await fetch(`/api/admin/camp-children/search?q=${encodeURIComponent(trimmed)}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      setChildSearchResults(await res.json());
    } catch {
      setChildSearchResults([]);
    } finally {
      setChildSearchLoading(false);
    }
  };

  const handleAddChildPhotoUpload = async (file: File) => {
    setAddChildPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      if (id) fd.append("eventId", id);
      const res = await fetch("/api/admin/camp-photos", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      setNewChildForm((p) => ({ ...p, childPhotoUrl: url }));
    } catch {
      toast({ title: "Photo upload failed", variant: "destructive" });
    } finally {
      setAddChildPhotoUploading(false);
    }
  };

  const openChildProfile = (reg: any) => {
    setChildProfileReg(reg);
    setProfileForm({
      childFullName: reg.childFullName || "",
      dateOfBirth: reg.dateOfBirth || "",
      primaryLanguage: reg.primaryLanguage || "",
      allergies: reg.allergies || "",
      foodRestrictions: reg.foodRestrictions || "",
      behavioralNotes: reg.behavioralNotes || "",
      specialNotes: reg.specialNotes || "",
      authorizedPickupPersons: reg.authorizedPickupPersons || "",
      parentContacts: Array.isArray(reg.parentContacts) && reg.parentContacts.length > 0
        ? reg.parentContacts
        : [{ name: reg.parentGuardianName || "", phone: reg.emergencyContactNumber || "" }],
      childPhotoUrl: reg.childPhotoUrl || "",
    });
    setProfileDaySelected(new Set(Array.isArray(reg.attendanceDays) ? reg.attendanceDays : []));
  };

  const handleProfilePhotoUpload = async (file: File) => {
    setProfilePhotoUploading(true);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      if (childProfileReg?.id) formData.append("registrationId", childProfileReg.id);
      const res = await fetch("/api/admin/camp-photos", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      setProfileForm((prev) => ({ ...prev, childPhotoUrl: url }));
    } catch {
      toast({ title: "Photo upload failed", variant: "destructive" });
    } finally {
      setProfilePhotoUploading(false);
    }
  };

  const openEdit = () => {
    if (!event) return;
    setEditData({
      title: event.title || "",
      eventDate: event.eventDate || "",
      campEndDate: event.campEndDate || event.eventDate || "",
      startTime: event.startTime || "10:00",
      endTime: event.endTime || "15:00",
      programName: event.programName || "",
      specialRequests: event.specialRequests || "",
      numChildren: event.numChildren || null,
      branchId: event.branchId || null,
      campDayHosts: event.campDayHosts || {},
      campCancelledDays: Array.isArray(event.campCancelledDays) ? event.campCancelledDays : [],
    });
    setShowStartCal(false);
    setShowEndCal(false);
    setShowEditSheet(true);
  };

  const registrationUrl = `${window.location.origin}/camp-register/${id}`;

  const copyRegistrationLink = () => {
    navigator.clipboard.writeText(registrationUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    });
  };

  const downloadQrCode = () => {
    const svg = document.getElementById("camp-qr-svg");
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const size = 512;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
      }
      const pngUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = `${(event?.title || "camp").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-qr-code.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  };

  const printQrCode = () => {
    const svg = document.getElementById("camp-qr-svg");
    if (!svg || !event) return;
    const win = window.open("", "_blank");
    if (!win) return;
    const campEndForPrint = event.campEndDate || event.eventDate;
    const dateRangeLabel = event.eventDate === campEndForPrint
      ? format(parseISO(event.eventDate), "d MMMM yyyy")
      : `${format(parseISO(event.eventDate), "d MMM")} – ${format(parseISO(campEndForPrint), "d MMM yyyy")}`;

    win.document.title = `${event.title} — Registration QR Code`;

    const style = win.document.createElement("style");
    style.textContent = `
      @page { size: A4; margin: 0; }
      body {
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        font-family: 'Helvetica Neue', Arial, sans-serif;
        background: #ffffff;
      }
      .sign { text-align: center; padding: 48px; }
      .sign h1 { font-size: 42px; margin: 0 0 8px; color: #0f766e; }
      .sign p.dates { font-size: 22px; color: #444; margin: 0 0 32px; }
      .sign .qr-wrap {
        padding: 24px;
        border: 2px solid #0f766e;
        border-radius: 24px;
        display: inline-block;
      }
      .sign p.cta { font-size: 24px; font-weight: 600; margin-top: 32px; color: #111; }
    `;
    win.document.head.appendChild(style);

    const container = win.document.createElement("div");
    container.className = "sign";

    const heading = win.document.createElement("h1");
    heading.textContent = event.title;
    container.appendChild(heading);

    const dates = win.document.createElement("p");
    dates.className = "dates";
    dates.textContent = dateRangeLabel;
    container.appendChild(dates);

    const qrWrap = win.document.createElement("div");
    qrWrap.className = "qr-wrap";
    qrWrap.appendChild(win.document.importNode(svg, true));
    container.appendChild(qrWrap);

    const cta = win.document.createElement("p");
    cta.className = "cta";
    cta.textContent = "Scan to register your child";
    container.appendChild(cta);

    const printBtn = win.document.createElement("button");
    printBtn.textContent = "Print";
    printBtn.className = "print-btn";
    printBtn.addEventListener("click", () => win.print());
    container.appendChild(printBtn);

    const printOnlyStyle = win.document.createElement("style");
    printOnlyStyle.textContent = `
      .print-btn {
        margin-top: 24px;
        padding: 10px 24px;
        font-size: 16px;
        font-weight: 600;
        color: #fff;
        background: #0f766e;
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }
      @media print {
        .print-btn { display: none; }
      }
    `;
    win.document.head.appendChild(printOnlyStyle);

    win.document.body.appendChild(container);
    win.focus();
  };

  const fmt12 = (t?: string | null) => {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const branchName = (branchId?: string | null) =>
    branches.find((b: any) => b.id === branchId)?.name || "—";

  if (isLoading) {
    return (
      <StudioLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading…
        </div>
      </StudioLayout>
    );
  }

  if (!event) {
    return (
      <StudioLayout>
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-muted-foreground">
          <p>Camp event not found.</p>
          <Button variant="outline" onClick={() => navigate("/studio/events/calendar")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Calendar
          </Button>
        </div>
      </StudioLayout>
    );
  }

  const campEnd = event.campEndDate || event.eventDate;
  const spanDays = differenceInDays(parseISO(campEnd), parseISO(event.eventDate)) + 1;
  const campDays = eachDayOfInterval({ start: parseISO(event.eventDate), end: parseISO(campEnd) });
  const cancelledDays: string[] = Array.isArray(event.campCancelledDays) ? event.campCancelledDays : [];
  const isCampCancelled = event.status === "cancelled";

  const isManagerOrAdmin = user && ["admin", "manager", "operator_admin", "global_admin"].includes(user.role);

  const registrationCount = registrations.length;
  // "Registered Today" = attending today: attendanceDays is empty (all days) OR includes today
  const registeredToday = registrations.filter((r: any) => {
    const days = r.attendanceDays;
    if (!Array.isArray(days) || days.length === 0) return true;
    return days.includes(todayStr);
  }).length;
  // Stats from daily attendance rows (accurate, refreshes every 30s)
  const todayRows = todayAttendanceData?.attendance ?? [];
  const checkedInCount = todayRows.filter((a: any) => a.status === "checked_in" || a.status === "checked_out").length;
  const checkedOutCount = todayRows.filter((a: any) => a.status === "checked_out").length;
  const currentlyPresent = checkedInCount - checkedOutCount;
  // Not-yet-arrived: registered for today but not yet checked in (live real-time count)
  const notYetArrivedCount = Math.max(0, registeredToday - checkedInCount);

  return (
    <StudioLayout>
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">

        {/* Header */}
        <div className="flex items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="mt-0.5 flex-shrink-0"
            onClick={() => navigate("/studio/events/calendar")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold truncate">{event.title}</h1>
              <Badge className="bg-teal-500 text-white border-0 flex-shrink-0">
                <Tent className="h-3 w-3 mr-1" />
                Camp
              </Badge>
              {isCampCancelled && (
                <Badge variant="destructive" className="flex-shrink-0">
                  <Ban className="h-3 w-3 mr-1" />
                  Cancelled
                </Badge>
              )}
            </div>
            {event.branchId && (
              <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {branchName(event.branchId)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
            <Button variant="outline" size="sm" onClick={copyRegistrationLink}>
              {linkCopied ? (
                <><Check className="h-4 w-4 mr-1 text-teal-600" /> Copied!</>
              ) : (
                <><LinkIcon className="h-4 w-4 mr-1" /> Registration Link</>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowQrDialog(true)}>
              <QrCode className="h-4 w-4 mr-1" />
              Show QR Code
            </Button>
            <Button onClick={openEdit} size="sm">
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </div>
        </div>

        {/* Cancelled camp banner */}
        {isCampCancelled && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive">
            <Ban className="h-5 w-5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">This camp has been cancelled</p>
              <p className="text-xs opacity-80 mt-0.5">The registration link is still accessible but parents will see the cancelled status.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="flex-shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => cancelCampMutation.mutate(false)}
              disabled={cancelCampMutation.isPending}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Reactivate
            </Button>
          </div>
        )}

        {/* Camp Information */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Camp Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InfoRow icon={<Tent className="h-4 w-4" />} label="Camp Name" value={event.title} />
              <InfoRow
                icon={<Calendar className="h-4 w-4" />}
                label="Date Range"
                value={
                  event.eventDate === campEnd
                    ? format(parseISO(event.eventDate), "d MMM yyyy")
                    : `${format(parseISO(event.eventDate), "d MMM yyyy")} → ${format(parseISO(campEnd), "d MMM yyyy")} (${spanDays} days)`
                }
              />
              <InfoRow
                icon={<Clock className="h-4 w-4" />}
                label="Daily Time"
                value={
                  fmt12(event.startTime)
                    ? `${fmt12(event.startTime)}${fmt12(event.endTime) ? ` – ${fmt12(event.endTime)}` : ""}`
                    : "—"
                }
              />
              {(() => {
                const dayHosts = event.campDayHosts as Record<string, string> | null | undefined;
                const hasPerDay = dayHosts && Object.values(dayHosts).some((v: string) => v?.trim());
                if (hasPerDay) {
                  return (
                    <div className="flex items-start gap-2">
                      <Users className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Hosts</p>
                        <div className="space-y-0.5">
                          {Object.entries(dayHosts!).filter(([, v]) => (v as string)?.trim()).map(([date, host]) => (
                            <div key={date} className="text-sm">
                              <span className="text-muted-foreground">{format(parseISO(date), "EEE, d MMM")}: </span>
                              <span className="font-medium">{host as string}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <InfoRow
                    icon={<Users className="h-4 w-4" />}
                    label="Hosts"
                    value={event.programName || "—"}
                  />
                );
              })()}
            </div>
            {event.specialRequests && (
              <div className="pt-1">
                <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5" />
                  Additional Information
                </p>
                <p className="text-sm bg-muted rounded-md px-3 py-2 leading-relaxed">
                  {event.specialRequests}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Camp Days — cancel/uncancel individual days */}
        {campDays.length > 1 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Camp Days</CardTitle>
                {!isCampCancelled && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setShowCancelCampDialog(true)}
                  >
                    <Ban className="h-3.5 w-3.5 mr-1.5" />
                    Cancel Entire Camp
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {campDays.map((day) => {
                const dateStr = format(day, "yyyy-MM-dd");
                const isCancelled = cancelledDays.includes(dateStr);
                const isToday = dateStr === todayStr;
                return (
                  <div
                    key={dateStr}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                      isCancelled
                        ? "bg-red-50 border-red-200"
                        : isToday
                        ? "bg-teal-50 border-teal-200"
                        : "bg-background border-border"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {format(day, "EEEE, d MMMM yyyy")}
                        </span>
                        {isToday && !isCancelled && (
                          <Badge className="bg-teal-500 text-white border-0 text-xs">Today</Badge>
                        )}
                        {isCancelled && (
                          <Badge variant="destructive" className="text-xs">Cancelled</Badge>
                        )}
                      </div>
                      {event.campDayHosts?.[dateStr] && !isCancelled && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Host: {event.campDayHosts[dateStr]}
                        </p>
                      )}
                    </div>
                    {!isCampCancelled && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={cn(
                          "flex-shrink-0 text-xs h-7 px-2",
                          isCancelled
                            ? "text-teal-600 hover:text-teal-700 hover:bg-teal-50"
                            : "text-destructive hover:text-destructive hover:bg-red-50"
                        )}
                        disabled={cancelDayMutation.isPending}
                        onClick={() => cancelDayMutation.mutate({ date: dateStr, cancelled: !isCancelled })}
                      >
                        {isCancelled ? (
                          <><RotateCcw className="h-3 w-3 mr-1" /> Uncancel</>
                        ) : (
                          <><XCircle className="h-3 w-3 mr-1" /> Cancel Day</>
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
              {cancelledDays.length > 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  <AlertTriangle className="h-3 w-3 inline mr-1" />
                  Cancelled days are hidden from the parent registration form. Existing registrations for those days are preserved.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Statistics */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3 text-center">
              <StatBox
                icon={<Baby className="h-5 w-5 text-teal-500" />}
                label="Total Registered"
                value={registrationCount}
                active={registrationFilter === "all"}
                accentColor="bg-teal-500"
                onClick={() => { setRegistrationFilter("all"); setHistoryFrom(""); setHistoryTo(""); }}
              />
              <StatBox
                icon={<Calendar className="h-5 w-5 text-blue-500" />}
                label="Registered Today"
                value={registeredToday}
                active={registrationFilter === "today"}
                accentColor="bg-blue-500"
                onClick={() => { setRegistrationFilter("today"); setHistoryFrom(todayStr); setHistoryTo(todayStr); }}
              />
              <StatBox
                icon={<UserCheck className="h-5 w-5 text-green-500" />}
                label="Present Now"
                value={currentlyPresent}
              />
              <StatBox
                icon={<UserCheck className="h-5 w-5 text-emerald-500" />}
                label="Checked In"
                value={checkedInCount}
              />
              <StatBox
                icon={<LogOut className="h-5 w-5 text-orange-500" />}
                label="Checked Out"
                value={checkedOutCount}
              />
              <StatBox
                icon={<UserX className="h-5 w-5 text-red-400" />}
                label="Not Yet Arrived"
                value={notYetArrivedCount}
              />
            </div>
            {event.numChildren && registrationCount > 0 && (
              <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-teal-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (registrationCount / event.numChildren) * 100)}%` }}
                />
              </div>
            )}
            {event.numChildren && (
              <p className="text-xs text-muted-foreground text-center mt-2">
                {registrationCount} / {event.numChildren} spots filled
              </p>
            )}
          </CardContent>
        </Card>

        {/* Attendance History */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Attendance History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {registrationFilter === "today" ? `Showing today (${todayStr})` : "Showing all camp days"}
            </p>
            {historyLoading ? (
              <div className="text-center py-6 text-muted-foreground text-sm">Loading…</div>
            ) : (historyData?.attendance ?? []).length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No attendance records yet.</p>
                <p className="text-xs mt-1">Records appear here once children start checking in.</p>
              </div>
            ) : (
              <div className="overflow-x-auto -mx-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Date</TableHead>
                      <TableHead>Child</TableHead>
                      <TableHead>In</TableHead>
                      <TableHead>Out</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Drop-Off</TableHead>
                      <TableHead>Pick-Up</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="pr-6 w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(historyData?.attendance ?? []).map((row: any) => (
                      <TableRow key={row.id}>
                        <TableCell className="pl-6 text-sm whitespace-nowrap">
                          {format(parseISO(row.attendanceDate), "EEE d MMM")}
                        </TableCell>
                        <TableCell className="font-medium text-sm">{row.childFullName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {row.checkedInAt ? format(new Date(row.checkedInAt), "HH:mm") : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {row.checkedOutAt ? format(new Date(row.checkedOutAt), "HH:mm") : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.paymentMethod ? (
                            <Badge variant="outline" className="text-xs">{row.paymentMethod}</Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[100px] truncate" title={row.dropOffPerson ?? ""}>
                          {row.dropOffPerson || "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[100px] truncate" title={row.pickUpPerson ?? ""}>
                          {row.pickUpPerson || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={row.status === "waiting" ? "outline" : undefined}
                            className={cn(
                              "text-xs",
                              row.status === "checked_out" && "bg-orange-100 text-orange-700 border-orange-200",
                              row.status === "checked_in" && "bg-green-100 text-green-700 border-green-200",
                            )}
                          >
                            {row.status === "checked_out" ? "Left" : row.status === "checked_in" ? "Present" : "Waiting"}
                          </Badge>
                        </TableCell>
                        <TableCell className="pr-6">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setEditAtt({ row, payment: row.paymentMethod || "", dropOff: row.dropOffPerson || "", pickUp: row.pickUpPerson || "", notes: row.staffNotes || "" })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Registered Children */}
        {(() => {
          const displayedRegistrations = registrationFilter === "today"
            ? registrations.filter((r: any) => {
                const days = r.attendanceDays;
                if (!Array.isArray(days) || days.length === 0) return true;
                return days.includes(todayStr);
              })
            : registrations;
          return (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">
              {registrationFilter === "today" ? "Registered Today" : "Registered Children"}
            </CardTitle>
            <div className="flex items-center gap-2">
              {registrationFilter === "today" && (
                <button
                  onClick={() => setRegistrationFilter("all")}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Show all
                </button>
              )}
              {isManagerOrAdmin && (
                <Button size="sm" className="h-7 gap-1 text-xs bg-teal-600 hover:bg-teal-700 text-white" onClick={openAddChildDialog}>
                  <Plus className="h-3.5 w-3.5" />
                  Add Child
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {displayedRegistrations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Baby className="h-8 w-8 mx-auto mb-2 opacity-30" />
                {registrationFilter === "today"
                  ? <p className="text-sm">No registrations today.</p>
                  : <><p className="text-sm">No registrations yet.</p>
                     <p className="text-xs mt-1">Share the Registration Link so parents can sign up.</p></>
                }
              </div>
            ) : (
              <div className="overflow-x-auto -mx-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">#</TableHead>
                      <TableHead>Child</TableHead>
                      <TableHead>Age</TableHead>
                      <TableHead>Attendance Days</TableHead>
                      <TableHead>Parent / Guardian</TableHead>
                      <TableHead>Emergency Contact</TableHead>
                      {isManagerOrAdmin && <TableHead className="pr-6">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedRegistrations.map((reg: any, idx: number) => {
                      const age = reg.dateOfBirth
                        ? differenceInYears(new Date(), parseISO(reg.dateOfBirth))
                        : null;
                      const hasAllergy = !!(reg.allergiesNotes || reg.allergies);
                      const hasFood = !!reg.foodRestrictions;
                      const hasBehavior = !!reg.behavioralNotes;
                      return (
                        <TableRow key={reg.id}>
                          <TableCell className="pl-6 text-muted-foreground">{idx + 1}</TableCell>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {reg.childPhotoUrl ? (
                                <img
                                  src={reg.childPhotoUrl}
                                  alt={reg.childFullName}
                                  className="h-8 w-8 rounded-full object-cover flex-shrink-0 border border-border"
                                />
                              ) : (
                                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                                  <Baby className="h-4 w-4 text-muted-foreground" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span>{reg.childFullName}</span>
                                  {reg.isOneTime && (
                                    <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-amber-400 text-amber-600 bg-amber-50">
                                      One-Time
                                    </Badge>
                                  )}
                                  {reg.addedByManager && !reg.isOneTime && (
                                    <Star className="h-3 w-3 text-teal-500 flex-shrink-0" title="Added by manager" />
                                  )}
                                  {hasAllergy && (
                                    <span title={reg.allergies || reg.allergiesNotes} className="text-orange-500">
                                      <AlertTriangle className="h-3.5 w-3.5 inline" />
                                    </span>
                                  )}
                                  {hasFood && (
                                    <span title={`Food: ${reg.foodRestrictions}`} className="text-amber-600 text-xs">🍽</span>
                                  )}
                                  {hasBehavior && (
                                    <span title={reg.behavioralNotes} className="text-blue-500">
                                      <Info className="h-3.5 w-3.5 inline" />
                                    </span>
                                  )}
                                </div>
                                {reg.primaryLanguage && (
                                  <p className="text-xs text-muted-foreground">🌐 {reg.primaryLanguage}</p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {age !== null && age >= 0 ? `${age} yr` : "—"}
                          </TableCell>
                          <TableCell>
                            {Array.isArray(reg.attendanceDays) && reg.attendanceDays.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {reg.attendanceDays.map((d: string) => (
                                  <span
                                    key={d}
                                    className={cn(
                                      "inline-block text-xs border rounded px-1.5 py-0.5 whitespace-nowrap",
                                      cancelledDays.includes(d)
                                        ? "bg-red-50 text-red-600 border-red-200 line-through"
                                        : "bg-teal-50 text-teal-700 border-teal-200"
                                    )}
                                  >
                                    {format(parseISO(d), "EEE d MMM")}
                                    {cancelledDays.includes(d) && " (cancelled)"}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>{Array.isArray(reg.parentContacts) && reg.parentContacts.length > 0 ? reg.parentContacts.map((c: any) => c.name).filter(Boolean).join(" / ") : reg.parentGuardianName}</TableCell>
                          <TableCell>{Array.isArray(reg.parentContacts) && reg.parentContacts.length > 0 ? reg.parentContacts.map((c: any) => c.phone).filter(Boolean).join(" / ") : reg.emergencyContactNumber}</TableCell>
                          {isManagerOrAdmin && (
                            <TableCell className="pr-6">
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs h-7 gap-1"
                                  onClick={() => openChildProfile(reg)}
                                >
                                  <Pencil className="h-3 w-3" />
                                  Edit
                                </Button>
                                {reg.isOneTime && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-xs h-7 gap-1 border-amber-400 text-amber-600 hover:bg-amber-50"
                                    onClick={() => {
                                      setConvertReg(reg);
                                      setConvertForm({
                                        childFullName: reg.childFullName || "",
                                        dateOfBirth: (reg.dateOfBirth && !reg.dateOfBirth.startsWith("1970") && !reg.dateOfBirth.startsWith("1900")) ? reg.dateOfBirth : "",
                                        primaryLanguage: reg.primaryLanguage || "",
                                        childPhotoUrl: reg.childPhotoUrl || "",
                                        allergies: reg.allergies || "",
                                        foodRestrictions: reg.foodRestrictions || "",
                                        behavioralNotes: reg.behavioralNotes || "",
                                        authorizedPickupPersons: reg.authorizedPickupPersons || "",
                                        parentGuardianName: reg.parentGuardianName !== "Manager Added" ? (reg.parentGuardianName || "") : "",
                                        emergencyContactNumber: reg.emergencyContactNumber !== "MANAGER_ADDED" ? (reg.emergencyContactNumber || "") : "",
                                        parentContacts: Array.isArray(reg.parentContacts) && reg.parentContacts.length > 0
                                          ? reg.parentContacts
                                          : [{ name: reg.parentGuardianName !== "Manager Added" ? (reg.parentGuardianName || "") : "", phone: reg.emergencyContactNumber !== "MANAGER_ADDED" ? (reg.emergencyContactNumber || "") : "" }],
                                        specialNotes: reg.specialNotes || "",
                                      });
                                    }}
                                  >
                                    <UserPlus className="h-3 w-3" />
                                    Convert
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
          );
        })()}
      </div>

      {/* Child Profile Sheet */}
      <Sheet open={!!childProfileReg} onOpenChange={(open) => { if (!open) setChildProfileReg(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">
              <Baby className="h-5 w-5 text-teal-600" />
              Child Profile
            </SheetTitle>
            <SheetDescription>
              View and edit the registration details for <strong>{childProfileReg?.childFullName}</strong>.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 py-4">
            <ChildProfileEditor
              form={profileForm}
              onChange={(updates) => setProfileForm((p) => ({ ...p, ...updates }))}
              onPhotoUpload={handleProfilePhotoUpload}
              photoUploading={profilePhotoUploading}
            />

            {/* Registration Info (read-only) */}
            {childProfileReg && (
              <div className="rounded-lg bg-muted/50 border border-border px-4 py-3 space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Registration Info</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Registered</span>
                  <span>{childProfileReg.createdAt ? format(new Date(childProfileReg.createdAt), "d MMM yyyy, HH:mm") : "—"}</span>
                  <span className="text-muted-foreground">Last updated</span>
                  <span>{childProfileReg.updatedAt ? format(new Date(childProfileReg.updatedAt), "d MMM yyyy, HH:mm") : "—"}</span>
                </div>
              </div>
            )}

            {/* Save Profile */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setChildProfileReg(null)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={
                  !profileForm.childFullName.trim() ||
                  !profileForm.parentContacts[0]?.name?.trim() ||
                  !profileForm.parentContacts[0]?.phone?.trim() ||
                  updateCampRegistrationProfile.isPending ||
                  profilePhotoUploading
                }
                onClick={() => {
                  if (!childProfileReg) return;
                  updateCampRegistrationProfile.mutate({
                    regId: childProfileReg.id,
                    payload: {
                      childFullName: profileForm.childFullName.trim(),
                      dateOfBirth: profileForm.dateOfBirth || undefined,
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
                {updateCampRegistrationProfile.isPending ? "Saving…" : "Save Profile"}
              </Button>
            </div>

            {/* Divider */}
            <div className="border-t border-dashed" />

            {/* Attendance Dates */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                <CalendarPlus className="h-4 w-4 text-teal-600" />
                Attendance Dates
              </h3>
              <p className="text-xs text-muted-foreground">
                Toggle which days this child is attending. Days already checked in cannot be removed.
              </p>
              {campDays.length === 0 ? (
                <p className="text-sm text-muted-foreground">No camp dates available.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {campDays.map((day) => {
                    const dateStr = format(day, "yyyy-MM-dd");
                    const isSelected = profileDaySelected.has(dateStr);
                    const attRow = childProfileReg
                      ? (historyData?.attendance ?? []).find(
                          (a: any) => a.campRegistrationId === childProfileReg.id && a.attendanceDate === dateStr
                        )
                      : null;
                    const isAttended = attRow && attRow.status !== "waiting";
                    const isCancelled = cancelledDays.includes(dateStr);
                    return (
                      <button
                        key={dateStr}
                        type="button"
                        disabled={!!isAttended}
                        title={isAttended ? `Already attended (${attRow.status.replace("_", " ")}) — cannot remove` : undefined}
                        onClick={() => {
                          if (isAttended) return;
                          setProfileDaySelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(dateStr)) next.delete(dateStr);
                            else next.add(dateStr);
                            return next;
                          });
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 text-xs border rounded-full px-3 py-1 transition-colors",
                          isAttended
                            ? "opacity-50 cursor-not-allowed bg-muted border-muted-foreground/30 text-muted-foreground"
                            : isSelected
                              ? "bg-teal-600 text-white border-teal-600 hover:bg-teal-700"
                              : "bg-background border-input text-foreground hover:bg-accent",
                          isCancelled && !isAttended && "line-through opacity-70"
                        )}
                      >
                        {format(day, "EEE d MMM")}
                        {isAttended && " ✓"}
                      </button>
                    );
                  })}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={updateAttendanceDaysMutation.isPending}
                onClick={() => {
                  if (!childProfileReg) return;
                  const originalDays: string[] = Array.isArray(childProfileReg.attendanceDays) ? childProfileReg.attendanceDays : [];
                  const newDays = Array.from(profileDaySelected);
                  const addDates = newDays.filter((d) => !originalDays.includes(d));
                  const removeDates = originalDays.filter((d) => !profileDaySelected.has(d));
                  if (addDates.length === 0 && removeDates.length === 0) {
                    toast({ title: "No changes to attendance days" });
                    return;
                  }
                  updateAttendanceDaysMutation.mutate({ regId: childProfileReg.id, addDates, removeDates });
                }}
              >
                {updateAttendanceDaysMutation.isPending ? "Saving…" : "Save Attendance"}
              </Button>
            </div>

            {/* Remove from Camp */}
            {isManagerOrAdmin && (
              <>
                <div className="border-t border-dashed" />
                <div className="pt-1">
                  <Button
                    variant="ghost"
                    className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={removeFromCampMutation.isPending}
                    onClick={() => setShowRemoveConfirm(true)}
                  >
                    <UserX className="h-4 w-4 mr-2" />
                    Remove from Camp
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Remove from Camp Confirmation */}
      <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Camp?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{childProfileReg?.childFullName}</strong> from this camp registration only. Their profile information and history in other camps is not affected and will be preserved.
              <br /><br />
              Attendance records for this camp will also be cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeFromCampMutation.isPending}>Keep Registration</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              disabled={removeFromCampMutation.isPending}
              onClick={() => {
                if (!childProfileReg) return;
                removeFromCampMutation.mutate(childProfileReg.id);
              }}
            >
              <UserX className="h-4 w-4 mr-1" />
              {removeFromCampMutation.isPending ? "Removing…" : "Remove from Camp"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Sheet */}
      <Sheet
        open={showEditSheet}
        onOpenChange={(open) => {
          if (!open) { setShowEditSheet(false); setShowStartCal(false); setShowEndCal(false); }
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
          <SheetHeader className="text-left">
            <SheetTitle>Edit Camp Event</SheetTitle>
            <SheetDescription>Update the camp details below.</SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-4">
            {/* Branch */}
            {branches.length > 1 && (
              <div className="space-y-2">
                <Label>Branch <span className="text-destructive">*</span></Label>
                <Select
                  value={editData.branchId || ""}
                  onValueChange={(v) => setEditData(prev => ({ ...prev, branchId: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b: any) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Camp Name */}
            <div className="space-y-2">
              <Label>Camp Name <span className="text-destructive">*</span></Label>
              <Input
                value={editData.title}
                onChange={(e) => setEditData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="e.g. Summer Camp Week 1"
              />
            </div>

            {/* Dates — inline calendars */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Start Date <span className="text-destructive">*</span></Label>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors"
                  onClick={() => { setShowStartCal(v => !v); setShowEndCal(false); }}
                >
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{editData.eventDate ? format(parseISO(editData.eventDate), "dd MMM yyyy") : "Pick date"}</span>
                </button>
                {showStartCal && (
                  <div className="border rounded-md overflow-hidden">
                    <CalendarComponent
                      mode="single"
                      selected={editData.eventDate ? parseISO(editData.eventDate) : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const ds = format(date, "yyyy-MM-dd");
                          setEditData(prev => ({
                            ...prev,
                            eventDate: ds,
                            campEndDate: prev.campEndDate < ds ? ds : prev.campEndDate,
                          }));
                          setShowStartCal(false);
                        }
                      }}
                      initialFocus={false}
                    />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label>End Date <span className="text-destructive">*</span></Label>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors"
                  onClick={() => { setShowEndCal(v => !v); setShowStartCal(false); }}
                >
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{editData.campEndDate ? format(parseISO(editData.campEndDate), "dd MMM yyyy") : "Pick date"}</span>
                </button>
                {showEndCal && (
                  <div className="border rounded-md overflow-hidden">
                    <CalendarComponent
                      mode="single"
                      selected={editData.campEndDate ? parseISO(editData.campEndDate) : undefined}
                      defaultMonth={editData.campEndDate ? parseISO(editData.campEndDate) : undefined}
                      disabled={(date) => editData.eventDate ? date < parseISO(editData.eventDate) : false}
                      onSelect={(date) => {
                        if (date) {
                          setEditData(prev => ({ ...prev, campEndDate: format(date, "yyyy-MM-dd") }));
                          setShowEndCal(false);
                        }
                      }}
                      initialFocus={false}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Times */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Daily Start Time <span className="text-destructive">*</span></Label>
                <Input
                  type="time"
                  value={editData.startTime}
                  onChange={(e) => setEditData(prev => ({ ...prev, startTime: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Daily End Time</Label>
                <Input
                  type="time"
                  value={editData.endTime}
                  onChange={(e) => setEditData(prev => ({ ...prev, endTime: e.target.value }))}
                />
              </div>
            </div>

            {/* Hosts — per-day assignment with employee picker */}
            <div className="space-y-2">
              <Label>Camp Hosts</Label>
              <p className="text-xs text-muted-foreground">Assign one or more hosts for each day of the camp</p>
              {(() => {
                try {
                  const days = eachDayOfInterval({
                    start: parseISO(editData.eventDate),
                    end: parseISO(editData.campEndDate),
                  });
                  return (
                    <div className="space-y-2">
                      {days.map((day) => {
                        const dateKey = format(day, "yyyy-MM-dd");
                        const dayLabel = format(day, "EEE, d MMM");
                        return (
                          <div key={dateKey} className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground w-24 flex-shrink-0">{dayLabel}</span>
                            <HostPickerPopover
                              employees={allEmployees}
                              value={editData.campDayHosts[dateKey] || ""}
                              onChange={(val) => setEditData(prev => ({
                                ...prev,
                                campDayHosts: { ...prev.campDayHosts, [dateKey]: val },
                              }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                } catch {
                  return <p className="text-xs text-muted-foreground">Set start and end dates to assign hosts.</p>;
                }
              })()}
            </div>

            {/* Capacity */}
            <div className="space-y-2">
              <Label>Capacity <span className="text-muted-foreground font-normal">(Optional)</span></Label>
              <Input
                type="number"
                min={1}
                value={editData.numChildren ?? ""}
                onChange={(e) => setEditData(prev => ({
                  ...prev,
                  numChildren: e.target.value ? parseInt(e.target.value) : null,
                }))}
                placeholder="Max number of participants"
              />
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Additional Information / Notes</Label>
              <Textarea
                value={editData.specialRequests}
                onChange={(e) => setEditData(prev => ({ ...prev, specialRequests: e.target.value }))}
                placeholder="Any details about the camp, schedule, requirements..."
                className="resize-none"
                rows={3}
              />
            </div>
          </div>

          <SheetFooter className="gap-2 pt-2 flex-col sm:flex-row">
            <Button
              variant="destructive"
              className="sm:mr-auto"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!confirm(`Delete "${event?.title}"? This cannot be undone.`)) return;
                deleteMutation.mutate();
              }}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {deleteMutation.isPending ? "Deleting…" : "Delete Camp"}
            </Button>
            <Button variant="outline" onClick={() => setShowEditSheet(false)}>Cancel</Button>
            <Button
              disabled={!editData.title.trim() || !editData.eventDate || !editData.campEndDate || updateMutation.isPending}
              onClick={() => {
                updateMutation.mutate({
                  eventType: "camp",
                  title: editData.title.trim(),
                  eventDate: editData.eventDate,
                  campEndDate: editData.campEndDate,
                  startTime: editData.startTime,
                  endTime: editData.endTime || null,
                  programName: editData.programName.trim() || null,
                  specialRequests: editData.specialRequests.trim() || null,
                  numChildren: editData.numChildren,
                  branchId: editData.branchId,
                  campDayHosts: editData.campDayHosts,
                });
              }}
            >
              {updateMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Cancel Entire Camp Confirmation */}
      <AlertDialog open={showCancelCampDialog} onOpenChange={setShowCancelCampDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Entire Camp?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark <strong>{event?.title}</strong> as cancelled. Existing registrations are preserved and can be viewed, but new registrations will see the cancelled status.
              <br /><br />
              You can reactivate the camp at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Camp Active</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => cancelCampMutation.mutate(true)}
            >
              <Ban className="h-4 w-4 mr-1" />
              Cancel Camp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Attendance Dialog */}
      {editAtt && (
        <Dialog open={!!editAtt} onOpenChange={(o) => { if (!o) setEditAtt(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Edit Attendance</DialogTitle>
              <DialogDescription>
                {editAtt.row.childFullName} · {format(parseISO(editAtt.row.attendanceDate), "EEEE d MMMM yyyy")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Payment Method</Label>
                <Select value={editAtt.payment || "none"} onValueChange={(v) => setEditAtt((prev) => prev ? { ...prev, payment: v === "none" ? "" : v } : null)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Not recorded" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not recorded</SelectItem>
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
                  value={editAtt.dropOff}
                  onChange={(e) => setEditAtt((prev) => prev ? { ...prev, dropOff: e.target.value } : null)}
                  placeholder="Name"
                />
              </div>
              <div className="space-y-2">
                <Label>Picked Up By</Label>
                <Input
                  value={editAtt.pickUp}
                  onChange={(e) => setEditAtt((prev) => prev ? { ...prev, pickUp: e.target.value } : null)}
                  placeholder="Name"
                />
              </div>
              <div className="space-y-2">
                <Label>Staff Notes</Label>
                <Textarea
                  value={editAtt.notes}
                  onChange={(e) => setEditAtt((prev) => prev ? { ...prev, notes: e.target.value } : null)}
                  placeholder="Any notes about this session"
                  rows={2}
                  className="resize-none"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditAtt(null)}>Cancel</Button>
              <Button
                disabled={editAttMutation.isPending}
                onClick={() => {
                  if (editAtt) {
                    editAttMutation.mutate({
                      regId: editAtt.row.campRegistrationId,
                      date: editAtt.row.attendanceDate,
                      payment: editAtt.payment,
                      dropOff: editAtt.dropOff,
                      pickUp: editAtt.pickUp,
                      notes: editAtt.notes,
                    });
                  }
                }}
              >
                {editAttMutation.isPending ? "Saving…" : "Save Changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Add Child Dialog */}
      <Dialog open={showAddChildDialog} onOpenChange={(open) => { if (!open) setShowAddChildDialog(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Baby className="h-5 w-5 text-teal-600" />
              Add Child to Camp
            </DialogTitle>
            <DialogDescription>
              {addChildFlow === "pick" && "Choose how you'd like to add a child to this camp."}
              {addChildFlow === "existing" && "Search for a previously registered child."}
              {addChildFlow === "new" && "Create a new full child profile."}
              {addChildFlow === "one_time" && "Add a one-time entry for a child attending today."}
            </DialogDescription>
          </DialogHeader>

          {/* Step 1: Pick flow */}
          {addChildFlow === "pick" && (
            <div className="space-y-3 py-2">
              <button
                className="w-full flex items-start gap-3 p-4 rounded-lg border-2 border-input hover:border-teal-400 hover:bg-teal-50/50 transition-colors text-left group"
                onClick={() => setAddChildFlow("existing")}
              >
                <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-200 transition-colors">
                  <Search className="h-5 w-5 text-teal-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Add Existing Child</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Search children registered in previous camps. Their health info and profile carry over automatically.</p>
                </div>
              </button>
              <button
                className="w-full flex items-start gap-3 p-4 rounded-lg border-2 border-input hover:border-blue-400 hover:bg-blue-50/50 transition-colors text-left group"
                onClick={() => setAddChildFlow("new")}
              >
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-200 transition-colors">
                  <UserPlus className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Create New Child Profile</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Enter full profile details — name, DOB, photo, allergies, pickup persons, and parent contact. Saved to the database permanently.</p>
                </div>
              </button>
              <button
                className="w-full flex items-start gap-3 p-4 rounded-lg border-2 border-input hover:border-amber-400 hover:bg-amber-50/50 transition-colors text-left group"
                onClick={() => setAddChildFlow("one_time")}
              >
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 group-hover:bg-amber-200 transition-colors">
                  <ClipboardList className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Add One-Time Entry</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Minimum info only (name, age, contact). Appears in check-in and attendance stats. You can convert to a full profile later.</p>
                </div>
              </button>
            </div>
          )}

          {/* Step 2a: Add Existing */}
          {addChildFlow === "existing" && (
            <div className="space-y-4 py-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-9"
                  placeholder="Search by child name, parent name, or phone…"
                  value={childSearch}
                  onChange={(e) => {
                    setChildSearch(e.target.value);
                    searchChildren(e.target.value);
                  }}
                  autoFocus
                />
                {childSearchLoading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>

              {childSearch.trim().length >= 2 && !childSearchLoading && childSearchResults.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No matching children found.</p>
              )}

              {childSearchResults.length > 0 && (
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {childSearchResults.map((child: any) => {
                    const isSelected = selectedExistingChild?.id === child.id;
                    const age = child.dateOfBirth ? differenceInYears(new Date(), parseISO(child.dateOfBirth)) : null;
                    return (
                      <button
                        key={child.id}
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors",
                          isSelected ? "border-teal-500 bg-teal-50" : "border-input hover:border-teal-300 hover:bg-muted/50"
                        )}
                        onClick={() => setSelectedExistingChild(isSelected ? null : child)}
                      >
                        {child.childPhotoUrl ? (
                          <img src={child.childPhotoUrl} alt={child.childFullName} className="h-10 w-10 rounded-full object-cover flex-shrink-0 border border-border" />
                        ) : (
                          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                            <Baby className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{child.childFullName}</p>
                          <p className="text-xs text-muted-foreground">
                            {age !== null ? `${age} yr · ` : ""}{Array.isArray(child.parentContacts) && child.parentContacts[0]?.name ? child.parentContacts[0].name : child.parentGuardianName}
                          </p>
                          {(child.allergies) && (
                            <p className="text-xs text-orange-600 mt-0.5 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />{child.allergies}
                            </p>
                          )}
                        </div>
                        {isSelected && <Check className="h-5 w-5 text-teal-600 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {selectedExistingChild && (
                <div className="space-y-3 pt-2 border-t">
                  <p className="text-sm font-medium flex items-center gap-1.5 text-teal-700">
                    <Check className="h-4 w-4" />
                    Selected: {selectedExistingChild.childFullName}
                  </p>
                  <div className="space-y-2">
                    <Label className="text-sm">Attendance Days <span className="text-muted-foreground font-normal">(optional)</span></Label>
                    <div className="flex flex-wrap gap-2">
                      {campDays.map((day) => {
                        const ds = format(day, "yyyy-MM-dd");
                        const isSel = addChildDays.has(ds);
                        return (
                          <button
                            key={ds}
                            type="button"
                            onClick={() => setAddChildDays((p) => { const n = new Set(p); isSel ? n.delete(ds) : n.add(ds); return n; })}
                            className={cn(
                              "text-xs border rounded-full px-3 py-1 transition-colors",
                              isSel ? "bg-teal-600 text-white border-teal-600" : "bg-background border-input hover:bg-accent"
                            )}
                          >{format(day, "EEE d MMM")}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setAddChildFlow("pick")}>Back</Button>
                <Button
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
                  disabled={!selectedExistingChild || addChildMutation.isPending}
                  onClick={() => {
                    if (!selectedExistingChild) return;
                    addChildMutation.mutate({
                      mode: "existing",
                      childFullName: selectedExistingChild.childFullName,
                      dateOfBirth: selectedExistingChild.dateOfBirth,
                      primaryLanguage: selectedExistingChild.primaryLanguage,
                      childPhotoUrl: selectedExistingChild.childPhotoUrl,
                      allergies: selectedExistingChild.allergies,
                      foodRestrictions: selectedExistingChild.foodRestrictions,
                      behavioralNotes: selectedExistingChild.behavioralNotes,
                      specialNotes: selectedExistingChild.specialNotes,
                      authorizedPickupPersons: selectedExistingChild.authorizedPickupPersons,
                      parentGuardianName: selectedExistingChild.parentGuardianName,
                      emergencyContactNumber: selectedExistingChild.emergencyContactNumber,
                      attendanceDays: Array.from(addChildDays),
                    });
                  }}
                >
                  {addChildMutation.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Adding…</> : "Add to Camp"}
                </Button>
              </div>
            </div>
          )}

          {/* Step 2b: Create New Child */}
          {addChildFlow === "new" && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1.5">
                  <Label>Full Name <span className="text-destructive">*</span></Label>
                  <Input value={newChildForm.childFullName} onChange={(e) => setNewChildForm((p) => ({ ...p, childFullName: e.target.value }))} placeholder="Child's full name" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Date of Birth</Label>
                    <Input type="date" value={newChildForm.dateOfBirth} onChange={(e) => setNewChildForm((p) => ({ ...p, dateOfBirth: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Language</Label>
                    <Input value={newChildForm.primaryLanguage} onChange={(e) => setNewChildForm((p) => ({ ...p, primaryLanguage: e.target.value }))} placeholder="e.g. Thai, English" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Child Photo <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                  {newChildForm.childPhotoUrl ? (
                    <div className="flex items-center gap-3">
                      <img src={newChildForm.childPhotoUrl} alt="preview" className="h-12 w-12 rounded-full object-cover border" />
                      <Button size="sm" variant="outline" onClick={() => setNewChildForm((p) => ({ ...p, childPhotoUrl: "" }))}>Remove</Button>
                    </div>
                  ) : (
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer px-3 py-2 rounded-md border border-dashed border-input bg-background hover:bg-accent transition-colors">
                      {addChildPhotoUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      {addChildPhotoUploading ? "Uploading…" : "Upload photo"}
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAddChildPhotoUpload(f); e.target.value = ""; }} />
                    </label>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Allergies</Label>
                  <Textarea value={newChildForm.allergies} onChange={(e) => setNewChildForm((p) => ({ ...p, allergies: e.target.value }))} placeholder="Any allergies or medical conditions…" rows={2} className="resize-none" />
                </div>
                <div className="space-y-1.5">
                  <Label>Food Restrictions</Label>
                  <Input value={newChildForm.foodRestrictions} onChange={(e) => setNewChildForm((p) => ({ ...p, foodRestrictions: e.target.value }))} placeholder="Dietary requirements…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Behavioral Notes</Label>
                  <Textarea value={newChildForm.behavioralNotes} onChange={(e) => setNewChildForm((p) => ({ ...p, behavioralNotes: e.target.value }))} placeholder="Any behavioral notes…" rows={2} className="resize-none" />
                </div>
                <div className="space-y-1.5">
                  <Label>Authorized Pickup Persons</Label>
                  <Input value={newChildForm.authorizedPickupPersons} onChange={(e) => setNewChildForm((p) => ({ ...p, authorizedPickupPersons: e.target.value }))} placeholder="Names of authorized pickup persons…" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Parent / Guardian <span className="text-destructive">*</span></Label>
                    <Input value={newChildForm.parentGuardianName} onChange={(e) => setNewChildForm((p) => ({ ...p, parentGuardianName: e.target.value }))} placeholder="Parent name" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Emergency Contact <span className="text-destructive">*</span></Label>
                    <Input value={newChildForm.emergencyContactNumber} onChange={(e) => setNewChildForm((p) => ({ ...p, emergencyContactNumber: e.target.value }))} placeholder="Phone number" />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Attendance Days <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <div className="flex flex-wrap gap-2">
                  {campDays.map((day) => {
                    const ds = format(day, "yyyy-MM-dd");
                    const isSel = addChildDays.has(ds);
                    return (
                      <button
                        key={ds}
                        type="button"
                        onClick={() => setAddChildDays((p) => { const n = new Set(p); isSel ? n.delete(ds) : n.add(ds); return n; })}
                        className={cn(
                          "text-xs border rounded-full px-3 py-1 transition-colors",
                          isSel ? "bg-teal-600 text-white border-teal-600" : "bg-background border-input hover:bg-accent"
                        )}
                      >{format(day, "EEE d MMM")}</button>
                    );
                  })}
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setAddChildFlow("pick")}>Back</Button>
                <Button
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
                  disabled={!newChildForm.childFullName.trim() || !newChildForm.parentGuardianName.trim() || !newChildForm.emergencyContactNumber.trim() || addChildMutation.isPending || addChildPhotoUploading}
                  onClick={() => {
                    addChildMutation.mutate({
                      mode: "new",
                      ...newChildForm,
                      attendanceDays: Array.from(addChildDays),
                    });
                  }}
                >
                  {addChildMutation.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Saving…</> : "Create & Add to Camp"}
                </Button>
              </div>
            </div>
          )}

          {/* Step 2c: One-Time Entry */}
          {addChildFlow === "one_time" && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                One-time entries do not become permanent profiles. You can convert them later from the child's row in the table.
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1.5">
                  <Label>Name / Identifier <span className="text-destructive">*</span></Label>
                  <Input value={oneTimeForm.childFullName} onChange={(e) => setOneTimeForm((p) => ({ ...p, childFullName: e.target.value }))} placeholder="Child's name or identifier" autoFocus />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Approximate Age <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                    <Input value={oneTimeForm.approximateAge} onChange={(e) => setOneTimeForm((p) => ({ ...p, approximateAge: e.target.value }))} placeholder="e.g. 7" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Parent Contact <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                    <Input value={oneTimeForm.emergencyContactNumber} onChange={(e) => setOneTimeForm((p) => ({ ...p, emergencyContactNumber: e.target.value }))} placeholder="Phone number" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Parent / Guardian Name <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                  <Input value={oneTimeForm.parentGuardianName} onChange={(e) => setOneTimeForm((p) => ({ ...p, parentGuardianName: e.target.value }))} placeholder="Parent name" />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Attendance Days <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <div className="flex flex-wrap gap-2">
                  {campDays.map((day) => {
                    const ds = format(day, "yyyy-MM-dd");
                    const isSel = addChildDays.has(ds);
                    return (
                      <button
                        key={ds}
                        type="button"
                        onClick={() => setAddChildDays((p) => { const n = new Set(p); isSel ? n.delete(ds) : n.add(ds); return n; })}
                        className={cn(
                          "text-xs border rounded-full px-3 py-1 transition-colors",
                          isSel ? "bg-amber-500 text-white border-amber-500" : "bg-background border-input hover:bg-accent"
                        )}
                      >{format(day, "EEE d MMM")}</button>
                    );
                  })}
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setAddChildFlow("pick")}>Back</Button>
                <Button
                  className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                  disabled={!oneTimeForm.childFullName.trim() || addChildMutation.isPending}
                  onClick={() => {
                    addChildMutation.mutate({
                      mode: "one_time",
                      childFullName: oneTimeForm.childFullName,
                      approximateAge: oneTimeForm.approximateAge || null,
                      parentGuardianName: oneTimeForm.parentGuardianName || null,
                      emergencyContactNumber: oneTimeForm.emergencyContactNumber || null,
                      attendanceDays: Array.from(addChildDays),
                    });
                  }}
                >
                  {addChildMutation.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Adding…</> : "Add One-Time Entry"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Convert to Full Profile Dialog */}
      <Dialog open={!!convertReg} onOpenChange={(open) => { if (!open) setConvertReg(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-teal-600" />
              Convert to Full Profile
            </DialogTitle>
            <DialogDescription>
              Complete the profile for <strong>{convertReg?.childFullName}</strong>. This creates a permanent, reusable child record.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 pr-1">
            <div className="space-y-4 py-2">
              {/* Photo upload */}
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center overflow-hidden border flex-shrink-0">
                  {convertForm.childPhotoUrl
                    ? <img src={convertForm.childPhotoUrl} alt="Child" className="h-full w-full object-cover" />
                    : <span className="text-2xl text-muted-foreground">👶</span>}
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground">Photo (optional)</Label>
                  <label className="cursor-pointer">
                    <input type="file" accept="image/*" className="hidden" disabled={convertPhotoUploading} onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setConvertPhotoUploading(true);
                      try {
                        const fd = new FormData();
                        fd.append("photo", file);
                        if (convertReg?.id) fd.append("registrationId", convertReg.id);
                        const r = await fetch("/api/admin/camp-photos", { method: "POST", body: fd, credentials: "include" });
                        if (r.ok) {
                          const d = await r.json();
                          setConvertForm((p) => ({ ...p, childPhotoUrl: d.url }));
                        }
                      } finally {
                        setConvertPhotoUploading(false);
                      }
                    }} />
                    <span className="text-xs text-blue-600 underline">
                      {convertPhotoUploading ? "Uploading…" : convertForm.childPhotoUrl ? "Change photo" : "Upload photo"}
                    </span>
                  </label>
                </div>
              </div>

              {/* Child name */}
              <div className="space-y-1.5">
                <Label>Child's Full Name <span className="text-red-500">*</span></Label>
                <Input value={convertForm.childFullName} onChange={(e) => setConvertForm((p) => ({ ...p, childFullName: e.target.value }))} placeholder="First and last name" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date of Birth <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                  <Input type="date" value={convertForm.dateOfBirth} onChange={(e) => setConvertForm((p) => ({ ...p, dateOfBirth: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Primary Language <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                  <Input value={convertForm.primaryLanguage} onChange={(e) => setConvertForm((p) => ({ ...p, primaryLanguage: e.target.value }))} placeholder="e.g. Thai, English" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Allergies <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Input value={convertForm.allergies} onChange={(e) => setConvertForm((p) => ({ ...p, allergies: e.target.value }))} placeholder="Food or environmental allergies" />
              </div>
              <div className="space-y-1.5">
                <Label>Food Restrictions <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Input value={convertForm.foodRestrictions} onChange={(e) => setConvertForm((p) => ({ ...p, foodRestrictions: e.target.value }))} placeholder="e.g. Vegetarian, Halal" />
              </div>
              <div className="space-y-1.5">
                <Label>Behavioral / Special Needs Notes <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Textarea value={convertForm.behavioralNotes} onChange={(e) => setConvertForm((p) => ({ ...p, behavioralNotes: e.target.value }))} placeholder="Anything staff should be aware of…" rows={2} className="resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label>Authorized Pickup Persons <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Input value={convertForm.authorizedPickupPersons} onChange={(e) => setConvertForm((p) => ({ ...p, authorizedPickupPersons: e.target.value }))} placeholder="e.g. Aunt Jane, Grandpa Tom" />
              </div>

              <div className="border-t pt-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Parent / Guardian</p>
                <div className="space-y-1.5">
                  <Label>Parent / Guardian Name <span className="text-red-500">*</span></Label>
                  <Input value={convertForm.parentGuardianName} onChange={(e) => setConvertForm((p) => ({ ...p, parentGuardianName: e.target.value }))} placeholder="Parent or guardian full name" />
                </div>
                <div className="space-y-1.5">
                  <Label>Emergency Contact Number <span className="text-red-500">*</span></Label>
                  <Input value={convertForm.emergencyContactNumber} onChange={(e) => setConvertForm((p) => ({ ...p, emergencyContactNumber: e.target.value }))} placeholder="Phone number" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Additional Notes <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Textarea value={convertForm.specialNotes} onChange={(e) => setConvertForm((p) => ({ ...p, specialNotes: e.target.value }))} placeholder="Any other notes…" rows={2} className="resize-none" />
              </div>
            </div>
          </div>
          <DialogFooter className="flex-shrink-0 pt-3 border-t">
            <Button variant="outline" onClick={() => setConvertReg(null)}>Cancel</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white"
              disabled={convertToFullMutation.isPending || !convertForm.childFullName.trim() || !convertForm.parentGuardianName.trim() || !convertForm.emergencyContactNumber.trim()}
              onClick={() => {
                if (!convertReg) return;
                convertToFullMutation.mutate({
                  regId: convertReg.id,
                  payload: {
                    childFullName: convertForm.childFullName.trim() || undefined,
                    dateOfBirth: convertForm.dateOfBirth || null,
                    primaryLanguage: convertForm.primaryLanguage || null,
                    childPhotoUrl: convertForm.childPhotoUrl || null,
                    allergies: convertForm.allergies || null,
                    foodRestrictions: convertForm.foodRestrictions || null,
                    behavioralNotes: convertForm.behavioralNotes || null,
                    authorizedPickupPersons: convertForm.authorizedPickupPersons || null,
                    parentGuardianName: convertForm.parentGuardianName || null,
                    emergencyContactNumber: convertForm.emergencyContactNumber || null,
                    specialNotes: convertForm.specialNotes || null,
                  },
                });
              }}
            >
              {convertToFullMutation.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Converting…</> : "Convert to Full Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Code dialog */}
      <Dialog open={showQrDialog} onOpenChange={setShowQrDialog}>
        <DialogContent className="max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="text-center">{event?.title}</DialogTitle>
            <DialogDescription className="text-center">
              Scan this QR code to open the registration form for this camp.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            <p className="text-sm text-muted-foreground text-center">
              {event && (event.eventDate === (event.campEndDate || event.eventDate)
                ? format(parseISO(event.eventDate), "d MMMM yyyy")
                : `${format(parseISO(event.eventDate), "d MMM")} – ${format(parseISO(event.campEndDate || event.eventDate), "d MMM yyyy")}`)}
            </p>
            <div className="bg-white p-4 rounded-lg border">
              <QRCodeSVG
                id="camp-qr-svg"
                value={registrationUrl}
                size={220}
                level="H"
                includeMargin
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Parents can scan this to open the registration form for this camp.
            </p>
            <div className="flex gap-2 w-full">
              <Button variant="outline" className="flex-1" onClick={downloadQrCode}>
                <Download className="h-4 w-4 mr-1" />
                Download PNG
              </Button>
              <Button className="flex-1" onClick={printQrCode}>
                <QrCode className="h-4 w-4 mr-1" />
                Print Sign
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground mt-0.5 flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium truncate">{value}</p>
      </div>
    </div>
  );
}

function StatBox({
  icon, label, value, onClick, active, accentColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  onClick?: () => void;
  active?: boolean;
  accentColor?: string;
}) {
  const isButton = !!onClick;
  return (
    <div
      onClick={onClick}
      className={[
        "relative flex flex-col items-center gap-2 p-3 rounded-lg transition-all overflow-hidden",
        isButton ? "cursor-pointer select-none" : "",
        active
          ? "bg-teal-500/15 ring-1 ring-teal-500/60"
          : isButton
          ? "bg-muted hover:bg-muted/80 ring-1 ring-border"
          : "bg-muted/50",
      ].join(" ")}
    >
      {/* Colored bottom accent bar for button stats */}
      {isButton && (
        <span
          className={[
            "absolute bottom-0 left-0 right-0 h-[3px] rounded-b-lg transition-opacity",
            active ? "opacity-100" : "opacity-40",
            accentColor ?? "bg-teal-500",
          ].join(" ")}
        />
      )}
      {icon}
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs text-muted-foreground leading-tight text-center">{label}</span>
      {isButton && (
        <span className="text-[10px] text-muted-foreground/60 -mt-1">tap to filter</span>
      )}
    </div>
  );
}

// ─── Host Picker Popover ──────────────────────────────────────────────────────
function HostPickerPopover({
  employees,
  value,
  onChange,
}: {
  employees: any[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedNames = value ? value.split(",").map((n) => n.trim()).filter(Boolean) : [];

  const activeEmployees = employees.filter(
    (e: any) => e.employmentState === "ACTIVE" || e.status === "active"
  );
  const filtered = activeEmployees.filter(
    (e: any) =>
      e.fullName?.toLowerCase().includes(search.toLowerCase()) ||
      e.nickname?.toLowerCase().includes(search.toLowerCase())
  );

  const toggleEmployee = (fullName: string) => {
    const current = new Set(selectedNames);
    if (current.has(fullName)) {
      current.delete(fullName);
    } else {
      current.add(fullName);
    }
    onChange(Array.from(current).join(", "));
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex-1 flex items-center gap-2 h-8 px-3 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors text-left min-w-0"
        >
          {selectedNames.length > 0 ? (
            <span className="truncate">{selectedNames.join(", ")}</span>
          ) : (
            <span className="text-muted-foreground">Select host…</span>
          )}
          <ChevronDown className="h-3 w-3 ml-auto flex-shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="p-2 border-b">
          <Input
            placeholder="Search employees…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
        <div className="max-h-48 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No employees found</p>
          ) : (
            filtered.map((emp: any) => {
              const isSelected = selectedNames.includes(emp.fullName);
              return (
                <button
                  key={emp.id}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors text-left",
                    isSelected && "bg-teal-50"
                  )}
                  onClick={() => toggleEmployee(emp.fullName)}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 flex-shrink-0 text-teal-600",
                      isSelected ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="font-medium truncate">{emp.fullName}</span>
                  {emp.nickname && emp.nickname !== emp.fullName && (
                    <span className="text-muted-foreground text-xs ml-auto flex-shrink-0 pl-1">
                      {emp.nickname}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {selectedNames.length > 0 && (
          <div className="border-t p-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-left"
              onClick={() => onChange("")}
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
