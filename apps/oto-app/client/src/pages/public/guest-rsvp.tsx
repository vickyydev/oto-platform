import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import {
  PartyPopper,
  Check,
  Users,
  Baby,
  Loader2,
  Globe,
  Send,
} from "lucide-react";
import {
  t,
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  type ParentExperienceLanguage,
} from "@shared/localization";
import { OtoInviteCard } from "@/components/oto-invite-card";

const OTO_ACCENT = "#E8734A";

interface EventData {
  id: string;
  name: string;
  childName: string | null;
  childAgeTurning: number | null;
  description: string | null;
  eventDate: string;
  startTime: string;
  endTime: string | null;
  locationName: string | null;
}

interface InvitationDesign {
  id: string;
  themeId: string;
  language: ParentExperienceLanguage;
  childName: string;
  childAge: string | null;
  message: string | null;
  eventDate: string;
  startTime: string;
  endTime: string | null;
  locationName: string | null;
  locationMapUrl: string | null;
  photoUrl: string | null;
  generatedImageUrl: string | null;
}

interface GuestRsvpEntry {
  id: string;
  guestName: string;
  attendingStatus: "yes" | "no" | "maybe";
  numberOfKids: number;
  numberOfAdults: number;
  notes: string | null;
  language: ParentExperienceLanguage;
}

interface GuestInviteData {
  event: EventData;
  design: InvitationDesign | null;
  myRsvp: GuestRsvpEntry | null;
}

interface KidDetails {
  name: string;
  hasDietaryRequirements: boolean;
  dietaryRequirements: string;
}

function getGuestIdentifier(eventToken: string): string {
  const storageKey = `oto_guest_id_${eventToken}`;
  let id = localStorage.getItem(storageKey);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(storageKey, id);
  }
  return id;
}

function parseKidNamesFromNotes(notes: string | null): string {
  if (!notes) return "";
  const match = notes.split("\n").find((line) => line.startsWith("Kid(s): "));
  return match ? match.replace("Kid(s): ", "") : "";
}

export default function GuestRsvpPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();

  const guestIdentifier = token ? getGuestIdentifier(token) : "";

  const [language, setLanguage] = useState<ParentExperienceLanguage>("en");
  const [submitted, setSubmitted] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    guestName: "",
    attendingStatus: "" as "" | "yes" | "no",
    numberOfKids: 1,
    numberOfAdults: 1,
  });
  const [kidDetails, setKidDetails] = useState<KidDetails[]>([
    { name: "", hasDietaryRequirements: false, dietaryRequirements: "" },
  ]);
  const [hasPrefilled, setHasPrefilled] = useState(false);

  const { data, isLoading, error } = useQuery<GuestInviteData>({
    queryKey: ["/api/public/guest-invite", token, guestIdentifier],
    queryFn: async () => {
      const res = await fetch(`/api/public/guest-invite/${token}?guestIdentifier=${encodeURIComponent(guestIdentifier)}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Invalid invitation");
      }
      return res.json();
    },
    enabled: !!token,
  });

  useEffect(() => {
    if (data?.myRsvp && !hasPrefilled) {
      const rsvp = data.myRsvp;
      setFormData({
        guestName: rsvp.guestName,
        attendingStatus: rsvp.attendingStatus === "maybe" ? "yes" : rsvp.attendingStatus,
        numberOfKids: rsvp.numberOfKids || 1,
        numberOfAdults: rsvp.numberOfAdults || 1,
      });
      const kidNamesStr = parseKidNamesFromNotes(rsvp.notes);
      setKidDetails([{ name: kidNamesStr, hasDietaryRequirements: false, dietaryRequirements: "" }]);
      setLanguage(rsvp.language || "en");
      setSubmitted(true);
      setHasPrefilled(true);
    }
  }, [data, hasPrefilled]);

  useEffect(() => {
    const numKids = formData.numberOfKids;
    setKidDetails((prev) => {
      if (numKids > prev.length) {
        const newKids = [...prev];
        for (let i = prev.length; i < numKids; i++) {
          newKids.push({ name: "", hasDietaryRequirements: false, dietaryRequirements: "" });
        }
        return newKids;
      } else if (numKids < prev.length) {
        return prev.slice(0, numKids);
      }
      return prev;
    });
  }, [formData.numberOfKids]);

  const submitRsvp = useMutation({
    mutationFn: async () => {
      const kidNamesStr = kidDetails[0]?.name || "";
      const notesLines: string[] = [];
      if (kidNamesStr) notesLines.push(`Kid(s): ${kidNamesStr}`);
      if (formData.attendingStatus === "yes") {
        kidDetails.forEach((kid, idx) => {
          if (kid.hasDietaryRequirements && kid.dietaryRequirements) {
            notesLines.push(`Dietary (${kid.name || `Child ${idx + 1}`}): ${kid.dietaryRequirements}`);
          }
        });
      }

      const res = await apiRequest("POST", `/api/public/guest-invite/${token}/rsvp`, {
        guestName: formData.guestName,
        phone: "",
        attendingStatus: formData.attendingStatus,
        numberOfKids: formData.attendingStatus === "yes" ? formData.numberOfKids : 0,
        numberOfAdults: formData.attendingStatus === "yes" ? formData.numberOfAdults : 0,
        notes: notesLines.join("\n"),
        language,
        guestIdentifier,
      });
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      setIsEditing(false);
      toast({ title: t("rsvp.success", language) });
    },
    onError: (err: Error) => {
      toast({ title: err.message || t("common.error", language), variant: "destructive" });
    },
  });

  if (isLoading) return <LoadingScreen />;

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "#FDF8F2" }}>
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <PartyPopper className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h1 className="text-xl font-bold mb-2">{t("invitation.notFound", language)}</h1>
            <p className="text-muted-foreground">{t("invitation.notFoundMessage", language)}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { event, design } = data;
  const childName = design?.childName || event.childName || event.name;

  // Parse age turning: prefer design.childAge (numeric string), fall back to event.childAgeTurning
  const rawAge = design?.childAge;
  const ageTurning = rawAge ? (parseInt(rawAge, 10) || null) : (event.childAgeTurning ?? null);

  if (submitted && !isEditing) {
    const myRsvp = data.myRsvp;
    const kidNames = myRsvp ? parseKidNamesFromNotes(myRsvp.notes) : "";
    return (
      <div className="min-h-screen p-4 pb-8" style={{ background: "#FDF8F2" }}>
        <div className="max-w-md mx-auto">
          <div className="mb-6">
            <OtoInviteCard
              childName={childName}
              ageTurning={ageTurning}
              eventDate={design?.eventDate || event.eventDate}
              startTime={design?.startTime || event.startTime}
              endTime={design?.endTime || event.endTime}
              locationName={design?.locationName || event.locationName}
              photoUrl={design?.photoUrl}
              language={language}
            />
          </div>

          <Card className="border-0 shadow-xl">
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div
                className="w-16 h-16 mx-auto rounded-full flex items-center justify-center"
                style={{ backgroundColor: `${OTO_ACCENT}20` }}
              >
                <Check className="h-8 w-8" style={{ color: OTO_ACCENT }} />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">{t("rsvp.success", language)}</h1>
                <p className="text-muted-foreground">{t("rsvp.successMessage", language)}</p>
              </div>

              {myRsvp && (
                <div className="text-left rounded-lg p-4 bg-muted/30 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {language === "th" ? "สถานะ" : language === "zh" ? "状态" : language === "ru" ? "Статус" : "Status"}
                    </span>
                    <span className="font-medium">
                      {myRsvp.attendingStatus === "yes"
                        ? t("rsvp.attending.yes", language)
                        : t("rsvp.attending.no", language)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {language === "th" ? "ชื่อผู้ปกครอง" : language === "zh" ? "家长姓名" : language === "ru" ? "Имя родителя" : "Parent"}
                    </span>
                    <span className="font-medium">{myRsvp.guestName}</span>
                  </div>
                  {kidNames && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {language === "th" ? "ชื่อเด็ก" : language === "zh" ? "孩子姓名" : language === "ru" ? "Имя ребенка" : "Kid(s)"}
                      </span>
                      <span className="font-medium">{kidNames}</span>
                    </div>
                  )}
                  {myRsvp.attendingStatus === "yes" && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{t("rsvp.numberOfKids", language)}</span>
                        <span className="font-medium">{myRsvp.numberOfKids}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{t("rsvp.numberOfAdults", language)}</span>
                        <span className="font-medium">{myRsvp.numberOfAdults}</span>
                      </div>
                    </>
                  )}
                </div>
              )}

              <Button
                variant="outline"
                className="w-full"
                onClick={() => setIsEditing(true)}
                data-testid="button-edit-rsvp"
              >
                {language === "th" ? "แก้ไขคำตอบ" : language === "zh" ? "编辑回复" : language === "ru" ? "Изменить ответ" : "Edit Response"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const updateKidDetail = (index: number, field: keyof KidDetails, value: string | boolean) => {
    setKidDetails((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  return (
    <div className="min-h-screen p-4 pb-8" style={{ background: "#FDF8F2" }}>
      <div className="max-w-md mx-auto">
        {/* Language selector */}
        <div className="flex justify-end mb-4">
          <Select value={language} onValueChange={(v) => setLanguage(v as ParentExperienceLanguage)}>
            <SelectTrigger className="w-32" data-testid="select-rsvp-language">
              <Globe className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {LANGUAGE_NAMES[lang]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* OTO-branded invite card */}
        <div className="mb-6">
          <OtoInviteCard
            childName={childName}
            ageTurning={ageTurning}
            eventDate={design?.eventDate || event.eventDate}
            startTime={design?.startTime || event.startTime}
            endTime={design?.endTime || event.endTime}
            locationName={design?.locationName || event.locationName}
            photoUrl={design?.photoUrl}
            language={language}
          />
        </div>

        {/* RSVP form card */}
        <Card className="border-0 shadow-xl">
          <CardContent className="p-6 space-y-6">
            {/* RSVP heading */}
            <div>
              <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
                <PartyPopper className="h-5 w-5" style={{ color: OTO_ACCENT }} />
                {t("invitation.rsvpTitle", language)}
              </h2>
              <p className="text-sm text-muted-foreground">{t("invitation.rsvpSubtitle", language)}</p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitRsvp.mutate();
              }}
              className="space-y-5"
            >
              {/* Attendance */}
              <div className="space-y-3">
                <Label>{t("rsvp.willAttend", language)} *</Label>
                <RadioGroup
                  value={formData.attendingStatus}
                  onValueChange={(v) => setFormData({ ...formData, attendingStatus: v as "yes" | "no" })}
                  className="space-y-2"
                >
                  <div
                    className="flex items-center space-x-3 p-4 rounded-lg cursor-pointer transition-all border-2"
                    style={{
                      backgroundColor: formData.attendingStatus === "yes" ? `${OTO_ACCENT}15` : "rgba(0,0,0,0.02)",
                      borderColor: formData.attendingStatus === "yes" ? OTO_ACCENT : "transparent",
                    }}
                  >
                    <RadioGroupItem value="yes" id="yes" data-testid="radio-attend-yes" />
                    <Label htmlFor="yes" className="flex-1 cursor-pointer font-medium">
                      {t("rsvp.attending.yes", language)}
                    </Label>
                  </div>
                  <div
                    className="flex items-center space-x-3 p-4 rounded-lg cursor-pointer transition-all border-2"
                    style={{
                      backgroundColor: formData.attendingStatus === "no" ? "rgba(239,68,68,0.08)" : "rgba(0,0,0,0.02)",
                      borderColor: formData.attendingStatus === "no" ? "rgb(239,68,68)" : "transparent",
                    }}
                  >
                    <RadioGroupItem value="no" id="no" data-testid="radio-attend-no" />
                    <Label htmlFor="no" className="flex-1 cursor-pointer font-medium">
                      {t("rsvp.attending.no", language)}
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {formData.attendingStatus !== "" && (
                <>
                  {/* Parent Name */}
                  <div className="space-y-2">
                    <Label htmlFor="guestName">{t("rsvp.guestName", language)} *</Label>
                    <Input
                      id="guestName"
                      value={formData.guestName}
                      onChange={(e) => setFormData({ ...formData, guestName: e.target.value })}
                      required
                      placeholder={
                        language === "th" ? "ชื่อผู้ปกครอง"
                        : language === "zh" ? "家长姓名"
                        : language === "ru" ? "Имя родителя"
                        : "Parent's name"
                      }
                      data-testid="input-guest-name"
                    />
                  </div>

                  {/* Kid name(s) */}
                  <div className="space-y-2">
                    <Label htmlFor="kidNames">
                      {language === "th" ? "ชื่อเด็ก" : language === "zh" ? "孩子姓名" : language === "ru" ? "Имя ребенка" : "Kid's name(s)"} *
                    </Label>
                    <Input
                      id="kidNames"
                      value={kidDetails[0]?.name || ""}
                      onChange={(e) => updateKidDetail(0, "name", e.target.value)}
                      required
                      placeholder={
                        language === "th" ? "หากมีหลายคน คั่นด้วยเครื่องหมายจุลภาค"
                        : language === "zh" ? "多个孩子请用逗号分隔"
                        : language === "ru" ? "Если несколько, через запятую"
                        : "If multiple kids, separate by comma"
                      }
                      data-testid="input-kid-names"
                    />
                  </div>
                </>
              )}

              {formData.attendingStatus === "yes" && (
                <>
                  {/* Number of Kids and Adults */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Baby className="h-4 w-4" style={{ color: OTO_ACCENT }} />
                        {t("rsvp.numberOfKids", language)}
                      </Label>
                      <Select
                        value={String(formData.numberOfKids)}
                        onValueChange={(v) => setFormData({ ...formData, numberOfKids: parseInt(v) })}
                      >
                        <SelectTrigger data-testid="select-num-kids">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Users className="h-4 w-4" style={{ color: OTO_ACCENT }} />
                        {t("rsvp.numberOfAdults", language)}
                      </Label>
                      <Select
                        value={String(formData.numberOfAdults)}
                        onValueChange={(v) => setFormData({ ...formData, numberOfAdults: parseInt(v) })}
                      >
                        <SelectTrigger data-testid="select-num-adults">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Dietary requirements */}
                  <div className="p-4 rounded-lg space-y-3 bg-muted/30">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="dietary-0"
                        checked={kidDetails[0]?.hasDietaryRequirements || false}
                        onCheckedChange={(checked) => updateKidDetail(0, "hasDietaryRequirements", !!checked)}
                        data-testid="checkbox-dietary-0"
                      />
                      <Label htmlFor="dietary-0" className="text-sm cursor-pointer text-muted-foreground">
                        {language === "th" ? "มีข้อจำกัดด้านอาหาร"
                          : language === "zh" ? "有饮食限制"
                          : language === "ru" ? "Есть диетические ограничения"
                          : "Has dietary requirements / allergies"}
                      </Label>
                    </div>
                    {kidDetails[0]?.hasDietaryRequirements && (
                      <Input
                        value={kidDetails[0]?.dietaryRequirements || ""}
                        onChange={(e) => updateKidDetail(0, "dietaryRequirements", e.target.value)}
                        placeholder={
                          language === "th" ? "ระบุข้อจำกัด (เช่น แพ้ถั่ว)"
                          : language === "zh" ? "请说明（如坚果过敏）"
                          : language === "ru" ? "Укажите (например, аллергия на орехи)"
                          : "Please specify (e.g., nut allergy)"
                        }
                        data-testid="input-dietary-0"
                      />
                    )}
                  </div>
                </>
              )}

              {/* Submit */}
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={!formData.attendingStatus || !formData.guestName || !(kidDetails[0]?.name) || submitRsvp.isPending}
                style={{ backgroundColor: OTO_ACCENT, borderColor: OTO_ACCENT }}
                data-testid="button-submit-rsvp"
              >
                {submitRsvp.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t("common.loading", language)}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    {language === "th" ? "ส่ง" : language === "zh" ? "发送" : language === "ru" ? "Отправить" : "Send"}
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
