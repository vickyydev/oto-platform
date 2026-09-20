import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import {
  Users,
  Baby,
  Check,
  XCircle,
  HelpCircle,
  PartyPopper,
  Globe,
  Copy,
  Image as ImageIcon,
} from "lucide-react";
import {
  t,
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  type ParentExperienceLanguage,
} from "@shared/localization";
import { useToast } from "@/hooks/use-toast";
import { OtoInviteCard } from "@/components/oto-invite-card";

interface EventData {
  id: string;
  name: string;
  childName: string | null;
  description: string | null;
  eventDate: string;
  startTime: string;
  endTime: string | null;
  status: string;
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
  generatedPdfUrl: string | null;
}

interface RsvpEntry {
  id: string;
  guestName: string;
  phone: string | null;
  attendingStatus: "yes" | "no" | "maybe";
  numberOfKids: number;
  numberOfAdults: number;
  notes: string | null;
  source: string;
  language: string;
  createdAt: string;
}

interface RsvpSummary {
  total: number;
  attending: number;
  declined: number;
  maybe: number;
  totalKids: number;
  totalAdults: number;
}

interface ParentPortalData {
  event: EventData;
  design: InvitationDesign | null;
  rsvpSummary: RsvpSummary;
  rsvpEntries: RsvpEntry[];
  guestInviteToken: string;
}

export default function ParentPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const urlParams = new URLSearchParams(window.location.search);
  const langParam = urlParams.get('lang') as ParentExperienceLanguage | null;
  const initialLanguage = langParam && SUPPORTED_LANGUAGES.includes(langParam) ? langParam : "en";
  
  const [language, setLanguage] = useState<ParentExperienceLanguage>(initialLanguage);
  const [rsvpFilter, setRsvpFilter] = useState<"all" | "yes" | "no" | "maybe">("all");

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const { data, isLoading, error } = useQuery<ParentPortalData>({
    queryKey: ["/api/public/parent-portal", token, "full"],
    queryFn: async () => {
      const res = await fetch(`/api/public/parent-portal/${token}/full`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Invalid link");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t("portal.copyLink", language) });
    } catch {
      toast({ title: t("common.error", language), variant: "destructive" });
    }
  };

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-pink-50 to-purple-50 dark:from-gray-900 dark:to-gray-800 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <XCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h1 className="text-xl font-bold mb-2">{t("portal.accessDenied", language)}</h1>
            <p className="text-muted-foreground">
              {t("portal.accessDeniedMessage", language)}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { event, design, rsvpSummary, rsvpEntries, guestInviteToken } = data;
  const childName = design?.childName || event.childName || event.name;
  const rsvpLink = `${baseUrl}/rsvp/${guestInviteToken}`;

  const filteredRsvpEntries = rsvpEntries.filter(entry => {
    if (rsvpFilter === "all") return true;
    return entry.attendingStatus === rsvpFilter;
  });

  const getStatusBadge = (status: "yes" | "no" | "maybe") => {
    switch (status) {
      case "yes":
        return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><Check className="h-3 w-3 mr-1" />{t("rsvp.attending.yes", language)}</Badge>;
      case "no":
        return <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><XCircle className="h-3 w-3 mr-1" />{t("rsvp.attending.no", language)}</Badge>;
      case "maybe":
        return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"><HelpCircle className="h-3 w-3 mr-1" />{t("rsvp.attending.maybe", language)}</Badge>;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 to-purple-50 dark:from-gray-900 dark:to-gray-800 p-4 pb-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <PartyPopper className="h-8 w-8 text-pink-500" />
            <div>
              <h1 className="text-xl font-bold">{childName}</h1>
              <p className="text-sm text-muted-foreground">{t("portal.partyPlan", language)}</p>
            </div>
          </div>
          <Select value={language} onValueChange={(v) => {
            setLanguage(v as ParentExperienceLanguage);
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('lang', v);
            window.history.replaceState({}, '', newUrl.toString());
          }}>
            <SelectTrigger className="w-32" data-testid="select-portal-language">
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

        <div className="space-y-6">
          {design?.generatedImageUrl && (
            <div className="flex flex-col items-center gap-3">
              <div className="w-full max-w-sm">
                <OtoInviteCard
                  compact
                  childName={design.childName}
                  ageTurning={design.childAge ? parseInt(design.childAge, 10) || null : null}
                  eventDate={design.eventDate}
                  startTime={design.startTime}
                  endTime={design.endTime}
                  locationName={design.locationName}
                  photoUrl={design.photoUrl}
                  language={design.language}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-green-600 mb-1">
                  <Check className="h-4 w-4" />
                  <span className="text-2xl font-bold">{rsvpSummary.attending}</span>
                </div>
                <p className="text-sm text-muted-foreground">{t("portal.accepted", language)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-red-600 mb-1">
                  <XCircle className="h-4 w-4" />
                  <span className="text-2xl font-bold">{rsvpSummary.declined}</span>
                </div>
                <p className="text-sm text-muted-foreground">{t("portal.declined", language)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-blue-600 mb-1">
                  <Baby className="h-4 w-4" />
                  <span className="text-2xl font-bold">{rsvpSummary.totalKids}</span>
                </div>
                <p className="text-sm text-muted-foreground">{t("portal.totalKids", language)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-purple-600 mb-1">
                  <Users className="h-4 w-4" />
                  <span className="text-2xl font-bold">{rsvpSummary.totalAdults}</span>
                </div>
                <p className="text-sm text-muted-foreground">{t("portal.totalAdults", language)}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <CardTitle className="text-lg">{t("portal.guestList", language)}</CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocation(`/parent/${token}/invitation?lang=${language}`)}
                    data-testid="button-view-invitation"
                  >
                    <ImageIcon className="h-4 w-4 mr-2" />
                    {design?.generatedImageUrl
                      ? t("wizard.viewRegenerate", language)
                      : t("portal.createInvitation", language)}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard(rsvpLink)} data-testid="button-copy-rsvp-dashboard">
                    <Copy className="h-4 w-4 mr-2" />
                    {t("wizard.copyRsvpLink", language)}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <Tabs value={rsvpFilter} onValueChange={(v) => setRsvpFilter(v as typeof rsvpFilter)}>
                  <TabsList className="grid w-full grid-cols-4">
                    <TabsTrigger value="all" data-testid="filter-all">All ({rsvpEntries.length})</TabsTrigger>
                    <TabsTrigger value="yes" data-testid="filter-accepted">{t("portal.accepted", language)} ({rsvpSummary.attending})</TabsTrigger>
                    <TabsTrigger value="no" data-testid="filter-declined">{t("portal.declined", language)} ({rsvpSummary.declined})</TabsTrigger>
                    <TabsTrigger value="maybe" data-testid="filter-maybe">{t("portal.maybe", language)} ({rsvpSummary.maybe})</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {filteredRsvpEntries.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>{t("rsvp.noRsvpYet", language)}</p>
                  <p className="text-sm mt-2">{t("wizard.rsvpLinkWarning", language)}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("rsvp.guestName", language)}</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-center">
                          <Baby className="h-4 w-4 inline" />
                        </TableHead>
                        <TableHead className="text-center">
                          <Users className="h-4 w-4 inline" />
                        </TableHead>
                        <TableHead>{t("rsvp.notes", language)}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRsvpEntries.map((entry) => (
                        <TableRow key={entry.id} data-testid={`rsvp-entry-${entry.id}`}>
                          <TableCell className="font-medium">{entry.guestName}</TableCell>
                          <TableCell>{getStatusBadge(entry.attendingStatus)}</TableCell>
                          <TableCell className="text-center">{entry.numberOfKids}</TableCell>
                          <TableCell className="text-center">{entry.numberOfAdults}</TableCell>
                          <TableCell className="max-w-[200px] truncate">{entry.notes || "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
