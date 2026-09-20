import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { useForm } from "react-hook-form";
import { format, parseISO, differenceInDays, differenceInYears, addMonths, subMonths, getYear, getMonth, eachDayOfInterval, isAfter, endOfDay } from "date-fns";
import { DayPicker } from "react-day-picker";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Loader2, CheckCircle2, Tent, Calendar, Clock, AlertCircle,
  Camera, User, ExternalLink, Upload, X, ChevronLeft, ChevronRight, ChevronDown, Plus, Trash2,
  BadgeCheck, CalendarPlus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface FormValues {
  authorizedPickupPersons: string;
}

interface ParentContact {
  id: string;
  name: string;
  phone: string;
}

interface ChildEntry {
  id: string;
  childFullName: string;
  dateOfBirth: string;
  primaryLanguage: string;
  photoUrl: string | null;
  attendanceDays: string[];
  allergies: string;
  behavioralNotes: string;
  existingRegistrationId: string | null;
  alreadyRegistered: boolean;
  registeredDates: string[];
}

interface LookupChild {
  childFullName: string;
  dateOfBirth: string | null;
  primaryLanguage: string | null;
  childPhotoUrl: string | null;
  allergies: string | null;
  behavioralNotes: string | null;
  alreadyRegisteredForThisCamp: boolean;
  registeredDates: string[];
  existingRegistrationId: string | null;
}

function fmt12(t?: string | null) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─── Date of Birth Picker ──────────────────────────────────────────────────
function DobPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (val: string) => void;
  error?: string;
}) {
  const currentYear = new Date().getFullYear();

  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>(() => value ? parseISO(value) : new Date());
  const [picking, setPicking] = useState<"day" | "month" | "year">("day");

  const selectedDate = value ? parseISO(value) : undefined;

  const years: number[] = [];
  for (let y = currentYear; y >= 1990; y--) years.push(y);

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setPicking("day");
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm bg-background",
            "hover:bg-muted/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
            error ? "border-red-500" : "border-input",
            !selectedDate && "text-muted-foreground"
          )}
        >
          <span>{selectedDate ? format(selectedDate, "d MMMM yyyy") : "Select date of birth"}</span>
          <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        {/* ── Custom Header ── */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          {picking === "day" ? (
            <>
              <button
                type="button"
                onClick={() => setMonth(m => subMonths(m, 1))}
                className="p-1 rounded-md hover:bg-accent transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPicking("month")}
                  className="text-sm font-semibold text-primary underline underline-offset-2 decoration-dotted hover:opacity-80 transition-opacity"
                >
                  {format(month, "MMMM")}
                </button>
                <button
                  type="button"
                  onClick={() => setPicking("year")}
                  className="text-sm font-semibold text-primary underline underline-offset-2 decoration-dotted hover:opacity-80 transition-opacity"
                >
                  {format(month, "yyyy")}
                </button>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </div>
              <button
                type="button"
                onClick={() => setMonth(m => addMonths(m, 1))}
                className="p-1 rounded-md hover:bg-accent transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPicking("day")}
                className="p-1 rounded-md hover:bg-accent transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold">
                {picking === "month" ? "Select Month" : "Select Year"}
              </span>
              <div className="w-6" />
            </>
          )}
        </div>

        {/* ── Month Grid ── */}
        {picking === "month" && (
          <div className="grid grid-cols-3 gap-1 p-3">
            {MONTHS.map((name, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setMonth(new Date(getYear(month), i, 1));
                  setPicking("day");
                }}
                className={cn(
                  "text-sm py-1.5 rounded-md hover:bg-accent transition-colors",
                  getMonth(month) === i
                    ? "bg-primary text-primary-foreground hover:bg-primary"
                    : "text-foreground"
                )}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {/* ── Year Grid ── */}
        {picking === "year" && (
          <div className="grid grid-cols-4 gap-1 p-3 max-h-52 overflow-y-auto">
            {years.map(y => (
              <button
                key={y}
                type="button"
                onClick={() => {
                  setMonth(new Date(y, getMonth(month), 1));
                  setPicking("day");
                }}
                className={cn(
                  "text-sm py-1.5 px-1 rounded-md hover:bg-accent transition-colors",
                  getYear(month) === y
                    ? "bg-primary text-primary-foreground hover:bg-primary"
                    : "text-foreground"
                )}
              >
                {y}
              </button>
            ))}
          </div>
        )}

        {picking === "day" && (
          /* ── Day Grid ── */
          <DayPicker
            mode="single"
            selected={selectedDate}
            month={month}
            onMonthChange={setMonth}
            onSelect={(date) => {
              if (date) {
                onChange(format(date, "yyyy-MM-dd"));
                setOpen(false);
                setPicking("day");
              }
            }}
            disabled={{ after: new Date() }}
            showOutsideDays
            className="p-3 pt-1"
            classNames={{
              months: "flex flex-col",
              month: "space-y-2",
              caption: "hidden",
              nav: "hidden",
              table: "w-full border-collapse",
              head_row: "flex",
              head_cell: "text-muted-foreground w-9 font-normal text-[0.8rem] text-center",
              row: "flex w-full mt-1",
              cell: "h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
              day: "h-9 w-9 p-0 font-normal rounded-md hover:bg-accent transition-colors",
              day_selected: "bg-primary text-primary-foreground hover:bg-primary",
              day_today: "bg-accent text-accent-foreground",
              day_outside: "text-muted-foreground opacity-40",
              day_disabled: "text-muted-foreground opacity-30 cursor-not-allowed",
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Photo Upload Widget ───────────────────────────────────────────────────
function PhotoUploader({
  label,
  icon,
  onUploaded,
  prefillUrl,
  required = false,
}: {
  label: string;
  icon: React.ReactNode;
  onUploaded: (url: string | null) => void;
  prefillUrl?: string | null;
  required?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(prefillUrl ?? null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillUrl) {
      setPreview(prefillUrl);
    }
  }, [prefillUrl]);

  const handleFile = async (file: File) => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await fetch("/api/public/camp-photos", { method: "POST", body: fd });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      onUploaded(url);
    } catch {
      setPreview(null);
      onUploaded(null);
    } finally {
      setUploading(false);
    }
  };

  const clear = () => {
    setPreview(null);
    onUploaded(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}{required ? <span className="text-red-500 ml-0.5">*</span> : <span className="text-gray-400 font-normal ml-1">(optional)</span>}</Label>
      {preview ? (
        <div className="relative w-24 h-24">
          <img src={preview} alt="preview" className="w-24 h-24 rounded-xl object-cover border-2 border-teal-200" />
          {uploading && (
            <div className="absolute inset-0 rounded-xl bg-black/40 flex items-center justify-center">
              <Loader2 className="h-5 w-5 text-white animate-spin" />
            </div>
          )}
          {!uploading && (
            <button
              type="button"
              onClick={clear}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white flex items-center justify-center"
              aria-label="Remove photo"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed border-gray-200 text-gray-500 hover:border-teal-300 hover:text-teal-600 transition-colors w-full"
        >
          <span className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            {icon}
          </span>
          <span className="text-sm text-left">
            <span className="font-medium block">Tap to upload photo</span>
            <span className="text-xs text-gray-400">JPG or PNG, up to 5 MB</span>
          </span>
          <Upload className="h-4 w-4 ml-auto opacity-50" />
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function CampRegisterPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { toast } = useToast();

  const [signature, setSignature] = useState<string | null>(null);
  const [signatureError, setSignatureError] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [agreedRules, setAgreedRules] = useState(false);
  const [agreedHealthy, setAgreedHealthy] = useState(false);
  const [parentContacts, setParentContacts] = useState<ParentContact[]>([
    { id: "pc-0", name: "", phone: "" },
  ]);
  const [pickupPhotoUrl, setPickupPhotoUrl] = useState<string | null>(null);
  const [prefillBanner, setPrefillBanner] = useState(false);
  const [agreedCampRulesDate, setAgreedCampRulesDate] = useState<string | null>(null);
  const [rulesConfirmedCollapsed, setRulesConfirmedCollapsed] = useState(false);
  // Guards against a delayed lookup response overwriting children the user has already edited
  const pickerActedRef = useRef(false);
  const childFormRef = useRef<HTMLDivElement>(null);

  const newChild = (): ChildEntry => ({
    id: Math.random().toString(36).slice(2),
    childFullName: "", dateOfBirth: "", primaryLanguage: "",
    photoUrl: null, attendanceDays: [],
    allergies: "", behavioralNotes: "",
    existingRegistrationId: null,
    alreadyRegistered: false,
    registeredDates: [],
  });
  const [children, setChildren] = useState<ChildEntry[]>([newChild()]);
  const updateChild = (id: string, field: keyof Omit<ChildEntry, "id">, value: any) =>
    setChildren(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));

  const { data: campEvent, isLoading: campLoading, isError: campError } = useQuery<any>({
    queryKey: [`/api/public/camp-events/${eventId}`],
    queryFn: async () => {
      const res = await fetch(`/api/public/camp-events/${eventId}`);
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
    enabled: !!eventId,
    retry: false,
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { authorizedPickupPersons: "" },
  });

  const allValues = watch();

  // ── Persist to sessionStorage so navigating to rules page doesn't lose data ──
  const storageKey = `camp-reg-draft-${eventId}`;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const { fields, children: ch, parentContacts: pc } = JSON.parse(saved);
        if (fields) Object.entries(fields).forEach(([k, v]) => setValue(k as keyof FormValues, v as any));
        if (ch && Array.isArray(ch) && ch.length > 0)
          setChildren(ch.map((c: Partial<ChildEntry>) => ({ ...newChild(), ...c })));
        if (pc && Array.isArray(pc) && pc.length > 0)
          setParentContacts(pc);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (submitted) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ fields: allValues, children, parentContacts }));
    } catch { /* ignore */ }
  }, [allValues, children, parentContacts, storageKey, submitted]);

  // Reset all lookup-derived state (called on phone change or !found response)
  const resetLookupState = useCallback(() => {
    setAgreedCampRulesDate(null);
    setRulesConfirmedCollapsed(false);
    setAgreedRules(false);
    setAgreedHealthy(false);
    setPrefillBanner(false);
    pickerActedRef.current = false;
  }, []);

  const handlePhoneLookup = useCallback(async (phoneVal: string) => {
    const trimmed = phoneVal?.trim();
    if (!trimmed || trimmed.length < 5 || !eventId) return;
    try {
      const res = await fetch(`/api/public/camp-registrations/lookup?eventId=${eventId}&phone=${encodeURIComponent(trimmed)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.found) {
        resetLookupState();
        return;
      }
      setValue("authorizedPickupPersons", data.authorizedPickupPersons || "");
      if (data.pickupPhotoUrl) { setPickupPhotoUrl(data.pickupPhotoUrl); }
      if (data.agreedCampRulesDate) {
        setAgreedCampRulesDate(data.agreedCampRulesDate);
        setAgreedRules(true);
        setAgreedHealthy(true);
        setRulesConfirmedCollapsed(true);
      }
      // Pre-fill all parent contacts from the previous registration
      if (data.parentContacts && Array.isArray(data.parentContacts) && data.parentContacts.length > 0) {
        setParentContacts(data.parentContacts.map((c: { name: string; phone: string }) => ({
          id: Math.random().toString(36).slice(2),
          name: c.name || "",
          phone: c.phone || "",
        })));
      }
      // Auto-add all found children immediately — no picker step needed.
      // Guard: don't overwrite children the user has already started editing.
      if (!pickerActedRef.current && data.children && data.children.length > 0) {
        const prefilled: ChildEntry[] = data.children.map((c: LookupChild) => ({
          id: Math.random().toString(36).slice(2),
          childFullName: c.childFullName,
          dateOfBirth: c.dateOfBirth || "",
          primaryLanguage: c.primaryLanguage || "",
          photoUrl: c.childPhotoUrl || null,
          attendanceDays: [],
          allergies: c.allergies || "",
          behavioralNotes: c.behavioralNotes || "",
          existingRegistrationId: c.existingRegistrationId,
          alreadyRegistered: c.alreadyRegisteredForThisCamp,
          registeredDates: c.registeredDates,
        }));
        setChildren(prefilled);
        setPrefillBanner(true);
        pickerActedRef.current = true;
        setTimeout(() => {
          childFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 80);
      }
    } catch { /* silently ignore */ }
  }, [eventId, setValue, resetLookupState]);

  const submitMutation = useMutation({
    mutationFn: async (payload: {
      parentContacts: ParentContact[];
      parentData: FormValues;
      childrenData: ChildEntry[];
      sig: string | null;
      pickupPhoto: string | null;
      agreedRulesVal: boolean;
      agreedHealthyVal: boolean;
      usingPriorAgreement: boolean;
    }) => {
      const today = format(new Date(), "yyyy-MM-dd");
      const contactsPayload = payload.parentContacts.map(({ name, phone }) => ({ name, phone }));
      for (const child of payload.childrenData) {
        const res = await fetch("/api/public/camp-registrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId,
            childFullName: child.childFullName,
            dateOfBirth: child.dateOfBirth,
            parentGuardianName: payload.parentContacts[0]?.name || "",
            emergencyContactNumber: payload.parentContacts[0]?.phone || "",
            parentContacts: contactsPayload,
            allergies: child.allergies,
            behavioralNotes: child.behavioralNotes,
            authorizedPickupPersons: payload.parentData.authorizedPickupPersons,
            primaryLanguage: child.primaryLanguage,
            attendanceDays: child.attendanceDays,
            childPhotoUrl: child.photoUrl,
            pickupPhotoUrl: payload.pickupPhoto,
            agreedCampRules: payload.agreedRulesVal,
            agreedChildHealthy: payload.agreedHealthyVal,
            parentSignature: payload.sig || undefined,
            signatureDate: today,
            existingRegistrationId: child.existingRegistrationId || null,
            usePriorAgreement: payload.usingPriorAgreement,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || "Submission failed");
        }
      }
    },
    onSuccess: () => {
      setSubmitted(true);
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (err: Error) => {
      const isNetworkError = err.message === "Failed to fetch" || err.message.includes("NetworkError");
      toast({
        title: isNetworkError
          ? "Connection error — please check your internet and tap Submit again."
          : (err.message || "Submission failed. Please try again."),
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: FormValues) => {
    if (!parentContacts[0]?.phone?.trim()) {
      toast({ title: "Please enter a contact number", variant: "destructive" });
      return;
    }
    if (!parentContacts[0]?.name?.trim()) {
      toast({ title: "Please enter a parent or guardian name", variant: "destructive" });
      return;
    }
    const missingPhotoIndex = children.findIndex(c => !c.photoUrl);
    if (missingPhotoIndex !== -1) {
      toast({
        title: children.length > 1
          ? `Please upload a photo for Child ${missingPhotoIndex + 1}`
          : "Please upload a photo for your child",
        variant: "destructive",
      });
      return;
    }
    // When prior agreement is valid and the rules section is collapsed, signature is optional.
    // For first-time or re-confirming families, a fresh signature is required.
    const usingPriorAgreement = Boolean(agreedCampRulesDate && rulesConfirmedCollapsed);
    if (!signature && !usingPriorAgreement) { setSignatureError(true); return; }
    setSignatureError(false);
    // Only include contacts that have at least a phone number filled in
    const validContacts = parentContacts.filter(c => c.phone.trim());
    submitMutation.mutate({
      parentContacts: validContacts.length > 0 ? validContacts : parentContacts,
      parentData: data,
      childrenData: children,
      sig: signature,
      pickupPhoto: pickupPhotoUrl,
      agreedRulesVal: agreedRules,
      agreedHealthyVal: agreedHealthy,
      usingPriorAgreement,
    });
  };

  const campEnd = campEvent?.campEndDate || campEvent?.eventDate;
  const spanDays = campEvent ? differenceInDays(parseISO(campEnd), parseISO(campEvent.eventDate)) + 1 : 0;
  const dateLabel = campEvent
    ? campEvent.eventDate === campEnd
      ? format(parseISO(campEvent.eventDate), "d MMMM yyyy")
      : `${format(parseISO(campEvent.eventDate), "d MMM")} – ${format(parseISO(campEnd), "d MMM yyyy")} (${spanDays} days)`
    : "";

  const campDays: Date[] = campEvent
    ? eachDayOfInterval({ start: parseISO(campEvent.eventDate), end: parseISO(campEnd) })
    : [];

  const isRegistrationClosed = campEvent
    ? isAfter(new Date(), endOfDay(parseISO(campEnd)))
    : false;

  // ── States ──
  if (campLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
      </div>
    );
  }

  if (campError || !campEvent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="text-center space-y-3 max-w-xs">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto" />
          <h2 className="text-lg font-semibold text-gray-800">Registration not available</h2>
          <p className="text-sm text-gray-500">This link is invalid or the camp is no longer accepting registrations.</p>
        </div>
      </div>
    );
  }

  if (isRegistrationClosed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="text-center space-y-3 max-w-xs">
          <Clock className="h-12 w-12 text-gray-400 mx-auto" />
          <h2 className="text-lg font-semibold text-gray-800">Registration closed</h2>
          <p className="text-sm text-gray-500">
            <strong className="text-gray-700">{campEvent.title}</strong> has already ended ({dateLabel}). Registration for this camp is no longer available.
          </p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-teal-50 to-white px-6 py-12">
        <div className="text-center space-y-5 max-w-sm">
          <div className="w-20 h-20 rounded-full bg-teal-100 flex items-center justify-center mx-auto">
            <CheckCircle2 className="h-10 w-10 text-teal-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-800">All done! 🎉</h2>
            <p className="text-gray-500 mt-2 leading-relaxed">
              Thank you for registering for <strong className="text-gray-800">{campEvent.title}</strong>.
              We can't wait to see you there!
            </p>
          </div>
          <div className="bg-teal-50 border border-teal-100 rounded-2xl px-5 py-4 text-sm text-teal-800">
            <p className="font-semibold">{campEvent.title}</p>
            <p className="mt-1 opacity-80">{dateLabel}</p>
          </div>
          <a
            href="https://chat.whatsapp.com/FTe7pokxW0R6rwzH3LzoqH"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-2xl bg-green-500 hover:bg-green-600 active:bg-green-700 text-white font-semibold text-sm transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Join the Camp WhatsApp Group
          </a>
          <p className="text-xs text-gray-400">You can close this page.</p>
        </div>
      </div>
    );
  }

  const canSubmit = agreedRules && agreedHealthy
    && children.every(c => !!c.childFullName && !!c.dateOfBirth && !!c.photoUrl)
    && !submitMutation.isPending;

  // ── Form ──
  return (
    <div
      className="min-h-screen bg-gray-50 pb-10"
      style={{
        colorScheme: "light",
        ["--background" as string]: "210 5% 98%",
        ["--foreground" as string]: "210 6% 12%",
        ["--card" as string]: "0 0% 100%",
        ["--card-foreground" as string]: "210 6% 12%",
        ["--border" as string]: "210 5% 88%",
        ["--input" as string]: "210 5% 88%",
        ["--muted" as string]: "210 5% 96%",
        ["--muted-foreground" as string]: "210 6% 45%",
        ["--popover" as string]: "0 0% 100%",
        ["--popover-foreground" as string]: "210 6% 12%",
      }}
    >

      {/* Teal header */}
      <div className="bg-teal-600 text-white px-4 pt-8 pb-6">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-2 opacity-80">
            <Tent className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-widest">Camp Registration</span>
          </div>
          <h1 className="text-xl font-bold leading-snug">{campEvent.title}</h1>
          <div className="flex flex-wrap gap-4 mt-3 text-sm opacity-90">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {dateLabel}
            </span>
            {campEvent.startTime && (
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {fmt12(campEvent.startTime)}{campEvent.endTime ? ` – ${fmt12(campEvent.endTime)}` : ""}
              </span>
            )}
          </div>
          {campEvent.whatsappPhoneRaw && (
            <a
              href={`https://wa.me/${(campEvent.whatsappPhoneE164 ?? campEvent.whatsappPhoneRaw).replace(/\D/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 mt-3 bg-white/15 hover:bg-white/25 transition-colors rounded-full px-3 py-1.5 text-xs font-medium"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Questions? Chat with us on WhatsApp
            </a>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg mx-auto px-4 pt-5 space-y-4">

        {/* ── Returning family banner ────────────────────── */}
        {prefillBanner && (
          <div className="flex items-start gap-3 bg-teal-50 border border-teal-200 rounded-2xl px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-teal-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-teal-800">Welcome back!</p>
              <p className="text-xs text-teal-700 mt-0.5">We found your previous registration and pre-filled the form. Please review and update anything that has changed.</p>
            </div>
            <button
              type="button"
              onClick={() => setPrefillBanner(false)}
              className="text-teal-400 hover:text-teal-600 flex-shrink-0 mt-0.5"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}


        {/* ── Parent / Guardian Contacts ─────────────────── */}
        <Card className="shadow-sm border-0 rounded-2xl">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-base font-semibold text-foreground">Parent / Guardian</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-4">
            {parentContacts.map((contact, idx) => (
              <div key={contact.id} className="space-y-3">
                {parentContacts.length > 1 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      {idx === 0 ? "Primary Contact" : `Contact ${idx + 1}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setParentContacts(prev => prev.filter(c => c.id !== contact.id))}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Contact Number {idx === 0 && <span className="text-red-500">*</span>}
                  </Label>
                  <Input
                    type="tel"
                    inputMode="tel"
                    placeholder="+66 81 234 5678"
                    className="rounded-xl"
                    value={contact.phone}
                    onChange={e => {
                      const val = e.target.value;
                      setParentContacts(prev => prev.map(c => c.id === contact.id ? { ...c, phone: val } : c));
                      if (idx === 0) { pickerActedRef.current = false; resetLookupState(); }
                    }}
                    onBlur={idx === 0 ? e => handlePhoneLookup(e.target.value) : undefined}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Name {idx === 0 && <span className="text-red-500">*</span>}
                  </Label>
                  <Input
                    placeholder="Full name"
                    className="rounded-xl"
                    value={contact.name}
                    onChange={e => {
                      const val = e.target.value;
                      setParentContacts(prev => prev.map(c => c.id === contact.id ? { ...c, name: val } : c));
                    }}
                  />
                </div>
                {idx < parentContacts.length - 1 && <div className="border-b border-dashed border-gray-200" />}
              </div>
            ))}

            <button
              type="button"
              onClick={() => setParentContacts(prev => [...prev, { id: Math.random().toString(36).slice(2), name: "", phone: "" }])}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-blue-200 text-blue-600 font-medium text-sm hover:bg-blue-50 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add Another Parent / Contact
            </button>
          </CardContent>
        </Card>

        {/* ── Children (one card per child) ─────────────── */}
        <div ref={childFormRef} />
        {children.map((child, idx) => {
          const cancelledDays: string[] = Array.isArray((campEvent as any)?.campCancelledDays)
            ? (campEvent as any).campCancelledDays
            : [];
          // In add-dates mode: only show dates NOT already registered
          const availableDays = child.alreadyRegistered
            ? campDays.filter(d => {
                const dateStr = format(d, "yyyy-MM-dd");
                return !child.registeredDates.includes(dateStr) && !cancelledDays.includes(dateStr);
              })
            : campDays;

          return (
            <Card key={child.id} className="shadow-sm border-0 rounded-2xl">
              <CardHeader className="pb-2 pt-5 px-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      {children.length > 1 ? `Child ${idx + 1}` : "Child Information"}
                    </CardTitle>
                    {child.alreadyRegistered && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                        <CalendarPlus className="h-3 w-3" />
                        Adding Dates
                      </span>
                    )}
                  </div>
                  {children.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setChildren(prev => prev.filter(c => c.id !== child.id))}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  )}
                </div>
                {child.alreadyRegistered && child.registeredDates.length > 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    Already registered for: {child.registeredDates.map(d => {
                      try { return format(parseISO(d), "d MMM"); } catch { return d; }
                    }).join(", ")}
                  </p>
                )}
              </CardHeader>
              <CardContent className="px-5 pb-5 space-y-4">

                {/* Name */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Child Full Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    placeholder="As it appears on ID or passport"
                    className="rounded-xl"
                    value={child.childFullName}
                    onChange={e => updateChild(child.id, "childFullName", e.target.value)}
                  />
                </div>

                {/* DOB */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Date of Birth <span className="text-red-500">*</span>
                  </Label>
                  <DobPicker
                    value={child.dateOfBirth}
                    onChange={v => updateChild(child.id, "dateOfBirth", v)}
                  />
                </div>

                {/* Language */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Primary Language Spoken by Child</Label>
                  <Input
                    placeholder="e.g. Thai, English, Chinese…"
                    className="rounded-xl"
                    value={child.primaryLanguage}
                    onChange={e => updateChild(child.id, "primaryLanguage", e.target.value)}
                  />
                </div>

                {/* Child photo */}
                <PhotoUploader
                  label="Child Photo"
                  icon={<Camera className="h-4 w-4" />}
                  onUploaded={url => updateChild(child.id, "photoUrl", url)}
                  prefillUrl={child.photoUrl}
                  required
                />

                {/* Attendance days (per child) */}
                {campDays.length > 1 && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      {child.alreadyRegistered ? "Additional Attendance Days" : "Attendance Days"}
                    </Label>
                    {child.alreadyRegistered ? (
                      availableDays.length === 0 ? (
                        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-green-50 border border-green-200">
                          <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                          <p className="text-sm text-green-700 font-medium">All available days already selected!</p>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500">Select any additional days for this child:</p>
                      )
                    ) : (
                      <p className="text-xs text-gray-500">Select the days this child will attend:</p>
                    )}
                    {availableDays.map(date => {
                      const dateStr = format(date, "yyyy-MM-dd");
                      const checked = (child.attendanceDays ?? []).includes(dateStr);
                      return (
                        <label
                          key={dateStr}
                          className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                            checked ? "border-teal-500 bg-teal-50" : "border-gray-200 bg-white"
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={v => {
                              const days = child.attendanceDays ?? [];
                              const next = v
                                ? [...days, dateStr]
                                : days.filter(d => d !== dateStr);
                              updateChild(child.id, "attendanceDays", next);
                            }}
                            className="flex-shrink-0"
                          />
                          <span className="text-sm font-medium text-gray-800">
                            {format(date, "EEEE, d MMMM yyyy")}
                          </span>
                        </label>
                      );
                    })}
                    {/* Show cancelled days only for non-add-dates mode (already registered doesn't need to see them) */}
                    {!child.alreadyRegistered && campDays.map(date => {
                      const dateStr = format(date, "yyyy-MM-dd");
                      const isCancelled = cancelledDays.includes(dateStr);
                      if (!isCancelled) return null;
                      return (
                        <div
                          key={`cancelled-${dateStr}`}
                          className="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed"
                        >
                          <div className="flex-shrink-0 w-4 h-4 rounded-sm border-2 border-gray-300 bg-white" />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-gray-500 line-through">
                              {format(date, "EEEE, d MMMM yyyy")}
                            </span>
                            <span className="ml-2 text-xs text-red-500 font-medium">Cancelled</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Health / notes */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Allergies &amp; Food Restrictions</Label>
                  <Textarea
                    placeholder="e.g. peanuts, vegetarian, no pork, halal… or None"
                    className="rounded-xl resize-none"
                    rows={2}
                    value={child.allergies}
                    onChange={e => updateChild(child.id, "allergies", e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Behavioral &amp; Special Notes</Label>
                  <Textarea
                    placeholder="Any behavioral, learning, or developmental needs, or anything else we should know"
                    className="rounded-xl resize-none"
                    rows={2}
                    value={child.behavioralNotes}
                    onChange={e => updateChild(child.id, "behavioralNotes", e.target.value)}
                  />
                </div>

              </CardContent>
            </Card>
          );
        })}

        {/* ── Add Another Child ──────────────────────────── */}
        <button
          type="button"
          onClick={() => setChildren(prev => [...prev, newChild()])}
          className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border-2 border-dashed border-teal-300 text-teal-600 font-medium text-sm hover:bg-teal-50 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Another Child
        </button>

        {/* ── Who Can Pick Up ───────────────────────────── */}
        <Card className="shadow-sm border-0 rounded-2xl">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-base font-semibold text-foreground">Who Can Pick Up</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="authorizedPickupPersons" className="text-sm font-medium">Authorized Pickup Persons</Label>
              <Textarea
                id="authorizedPickupPersons"
                placeholder="Full names of people authorized to collect your child (e.g. Dad – John Smith, Grandma – Sue Lee)"
                className="rounded-xl resize-none"
                rows={2}
                {...register("authorizedPickupPersons")}
              />
              <p className="text-xs text-gray-400">Children will only be released to the parent/guardian or people listed here.</p>
              <PhotoUploader
                label="Photo of Pickup Person"
                icon={<User className="h-5 w-5 text-gray-400" />}
                onUploaded={setPickupPhotoUrl}
                prefillUrl={pickupPhotoUrl}
                required
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Agreement ─────────────────────────────────── */}
        <Card className="shadow-sm border-0 rounded-2xl">
          <CardHeader className="pb-2 pt-5 px-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-foreground">Agreement</CardTitle>
              {agreedCampRulesDate && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold bg-teal-100 text-teal-700 px-2 py-1 rounded-full">
                  <BadgeCheck className="h-3.5 w-3.5" />
                  Already Confirmed
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-5">

            {/* Previously confirmed banner */}
            {agreedCampRulesDate && rulesConfirmedCollapsed && (
              <div className="flex items-start gap-3 bg-teal-50 border border-teal-100 rounded-xl px-4 py-3">
                <CheckCircle2 className="h-5 w-5 text-teal-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-teal-800">Rules previously confirmed</p>
                  <p className="text-xs text-teal-600 mt-0.5">
                    You confirmed the camp rules on {format(new Date(agreedCampRulesDate), "d MMMM yyyy")}.
                    {" "}
                    <button
                      type="button"
                      className="underline font-medium hover:opacity-80"
                      onClick={() => setRulesConfirmedCollapsed(false)}
                    >
                      Review &amp; re-confirm
                    </button>
                  </p>
                </div>
              </div>
            )}

            {/* Rules section — shown always if not previously confirmed, or expanded if confirmed */}
            {(!agreedCampRulesDate || !rulesConfirmedCollapsed) && (
              <>
                {/* Rules link */}
                <button
                  type="button"
                  onClick={() => window.open("/camp-rules", "_blank")}
                  className="flex items-center gap-2 text-sm text-teal-600 font-medium hover:text-teal-700 transition-colors"
                >
                  <ExternalLink className="h-4 w-4 flex-shrink-0" />
                  View Camp Rules &amp; Policies
                </button>

                {/* Checkbox 1 */}
                <label
                  htmlFor="agreedRules"
                  className={`flex items-start gap-3 p-4 rounded-xl border-2 transition-colors cursor-pointer ${agreedRules ? "border-teal-500 bg-teal-50" : "border-gray-300 bg-white"}`}
                >
                  <Checkbox
                    id="agreedRules"
                    checked={agreedRules}
                    onCheckedChange={(v) => setAgreedRules(Boolean(v))}
                    className="mt-0.5 flex-shrink-0"
                  />
                  <span className="text-sm font-medium leading-relaxed text-gray-800 select-none">
                    I have read and understood the <strong className="text-gray-900">Camp Rules and Policies</strong> and I agree to ensure my child follows them.
                  </span>
                </label>

                {/* Checkbox 2 */}
                <label
                  htmlFor="agreedHealthy"
                  className={`flex items-start gap-3 p-4 rounded-xl border-2 transition-colors cursor-pointer ${agreedHealthy ? "border-teal-500 bg-teal-50" : "border-gray-300 bg-white"}`}
                >
                  <Checkbox
                    id="agreedHealthy"
                    checked={agreedHealthy}
                    onCheckedChange={(v) => setAgreedHealthy(Boolean(v))}
                    className="mt-0.5 flex-shrink-0"
                  />
                  <span className="text-sm font-medium leading-relaxed text-gray-800 select-none">
                    My child is in <strong className="text-gray-900">good health</strong> and is physically able to participate in all camp activities.
                  </span>
                </label>

                {agreedCampRulesDate && (
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                    onClick={() => setRulesConfirmedCollapsed(true)}
                  >
                    Collapse rules section
                  </button>
                )}
              </>
            )}

            {/* Signature — required for new families; optional (signature on file) for returning ones */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Parent / Guardian Signature{" "}
                {agreedCampRulesDate && rulesConfirmedCollapsed
                  ? <span className="text-gray-400 font-normal text-xs">(optional — signature on file)</span>
                  : <span className="text-red-500">*</span>
                }
              </Label>
              <p className="text-xs text-gray-400">
                {agreedCampRulesDate && rulesConfirmedCollapsed
                  ? "Leave blank to use your previous signature, or draw a new one below to update it."
                  : "Draw your signature in the box below"}
              </p>
              <div className={`rounded-xl border-2 overflow-hidden bg-white ${signatureError ? "border-red-400" : "border-gray-200"}`}>
                <SignatureCanvas
                  onSignatureChange={(sig) => {
                    setSignature(sig);
                    if (sig) setSignatureError(false);
                  }}
                  width={500}
                  height={140}
                />
              </div>
              {signatureError && <p className="text-xs text-red-500">Please draw your signature above</p>}
            </div>

            <p className="text-xs text-gray-500">
              Date: <strong>{format(new Date(), "d MMMM yyyy")}</strong>
            </p>
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="space-y-3 pt-1">
          {!agreedRules || !agreedHealthy ? (
            <p className="text-xs text-center text-amber-600 bg-amber-50 rounded-xl px-4 py-2.5">
              Please confirm both agreements above before submitting.
            </p>
          ) : null}

          <Button
            type="submit"
            size="lg"
            className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-semibold text-base h-13"
            disabled={!canSubmit}
          >
            {submitMutation.isPending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…</>
              : "Submit Registration"
            }
          </Button>

          <p className="text-center text-xs text-gray-400 pb-4">
            Your information is kept confidential and used only for camp administration.
          </p>
        </div>

      </form>
    </div>
  );
}
