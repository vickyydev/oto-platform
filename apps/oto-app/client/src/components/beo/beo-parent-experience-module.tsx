import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Link,
  Copy,
  Check,
  ExternalLink,
  Users,
  Baby,
  UserPlus,
  XCircle,
  MessageCircle,
  Loader2,
  RefreshCw,
  Globe,
  AlertTriangle,
} from "lucide-react";
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  generateWhatsAppMessage,
  type ParentExperienceLanguage,
} from "@shared/localization";
import type { Event } from "@shared/schema";

interface BeoParentExperienceModuleProps {
  eventId: string;
  event: Event;
}

interface RsvpSummary {
  total: number;
  attending: number;
  declined: number;
  maybe: number;
  totalKids: number;
  totalAdults: number;
}

interface TokenData {
  id: string;
  token: string;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

export function BeoParentExperienceModule({ eventId, event }: BeoParentExperienceModuleProps) {
  const { toast } = useToast();
  const [selectedLanguage, setSelectedLanguage] = useState<ParentExperienceLanguage>("en");
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [copiedMessage, setCopiedMessage] = useState(false);

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const { data: parentPortalToken, isLoading: loadingParentToken } = useQuery<TokenData | null>({
    queryKey: ["/api/events", eventId, "parent-portal-token"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/parent-portal-token`);
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: guestInviteToken, isLoading: loadingGuestToken } = useQuery<TokenData | null>({
    queryKey: ["/api/events", eventId, "guest-invite-token"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/guest-invite-token`);
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: rsvpSummary } = useQuery<RsvpSummary>({
    queryKey: ["/api/events", eventId, "rsvp-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/rsvp-summary`);
      if (!res.ok) return { total: 0, attending: 0, declined: 0, maybe: 0, totalKids: 0, totalAdults: 0 };
      return res.json();
    },
  });

  const createParentPortalToken = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/events/${eventId}/parent-portal-token`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "parent-portal-token"] });
      toast({ title: "Parent portal link created" });
    },
    onError: () => {
      toast({ title: "Failed to create parent portal link", variant: "destructive" });
    },
  });

  const createGuestInviteToken = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/events/${eventId}/guest-invite-token`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "guest-invite-token"] });
      toast({ title: "Guest invite link created" });
    },
    onError: () => {
      toast({ title: "Failed to create guest invite link", variant: "destructive" });
    },
  });

  const logMessage = useMutation({
    mutationFn: async (data: { channel: string; language: string; renderedMessageText: string }) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/message-logs`, data);
      return res.json();
    },
  });

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(type);
      setTimeout(() => setCopiedLink(null), 2000);
      toast({ title: "Link copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };

  const handleOpenWhatsApp = async () => {
    if (!guestInviteToken) {
      await createGuestInviteToken.mutateAsync();
    }
    
    const token = guestInviteToken?.token;
    if (!token) return;

    const rsvpLink = `${baseUrl}/rsvp/${token}`;
    const message = generateWhatsAppMessage(selectedLanguage, event.childName || event.title, rsvpLink);
    
    await logMessage.mutateAsync({
      channel: "whatsapp",
      language: selectedLanguage,
      renderedMessageText: message,
    });

    try {
      await navigator.clipboard.writeText(message);
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 3000);
      toast({ 
        title: "WhatsApp message copied!",
        description: "Open WhatsApp and paste the message to send to parents"
      });
    } catch {
      toast({ title: "Failed to copy message", variant: "destructive" });
    }
  };

  const parentPortalUrl = parentPortalToken ? `${baseUrl}/parent/${parentPortalToken.token}` : null;
  const guestInviteUrl = guestInviteToken ? `${baseUrl}/rsvp/${guestInviteToken.token}` : null;
  const kidTurningAge = (event as any).kidTurningAge as number | null | undefined;
  const missingAge = !kidTurningAge;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <Label>Message Language</Label>
        </div>
        <Select value={selectedLanguage} onValueChange={(v) => setSelectedLanguage(v as ParentExperienceLanguage)}>
          <SelectTrigger className="w-40" data-testid="select-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <SelectItem key={lang} value={lang} data-testid={`select-language-${lang}`}>
                {LANGUAGE_NAMES[lang]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-green-600" />
            <h4 className="font-medium">WhatsApp Confirmation</h4>
          </div>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700"
            onClick={handleOpenWhatsApp}
            disabled={createGuestInviteToken.isPending || logMessage.isPending}
            data-testid="button-whatsapp-confirm"
          >
            {(createGuestInviteToken.isPending || logMessage.isPending) && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            {copiedMessage ? (
              <>
                <Check className="h-4 w-4 mr-2" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 mr-2" />
                Copy WhatsApp Message
              </>
            )}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Generate a pre-written message in {LANGUAGE_NAMES[selectedLanguage]} with the RSVP link for parents.
        </p>
      </div>

      <Separator />

      <div className="space-y-4">
        <h4 className="font-medium flex items-center gap-2">
          <Link className="h-4 w-4" />
          Shareable Links
        </h4>

        {missingAge && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-3" data-testid="alert-missing-kid-age">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Kid Turning Age not set</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                The invite card will show "{event.childName || "their"}'s Birthday Party" with no age. Set <strong>Kid Turning Age</strong> in the Event Info section so it reads e.g. "{event.childName || "their"}'s 5th Birthday Party".
              </p>
            </div>
          </div>
        )}

        <Card className="border-dashed">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="font-medium text-sm">Parent Portal</p>
                <p className="text-xs text-muted-foreground">Full event details & RSVP dashboard for parents</p>
              </div>
              {parentPortalToken ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={parentPortalUrl || ""}
                    readOnly
                    className="w-64 text-xs"
                    data-testid="input-parent-portal-url"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => copyToClipboard(parentPortalUrl || "", "parent")}
                    data-testid="button-copy-parent-portal"
                  >
                    {copiedLink === "parent" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => window.open(parentPortalUrl || "", "_blank")}
                    data-testid="button-open-parent-portal"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => createParentPortalToken.mutate()}
                  disabled={createParentPortalToken.isPending || loadingParentToken}
                  data-testid="button-create-parent-portal"
                >
                  {createParentPortalToken.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Generate Link
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="font-medium text-sm">Guest RSVP Link</p>
                <p className="text-xs text-muted-foreground">Simple invitation & RSVP form for guests</p>
              </div>
              {guestInviteToken ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={guestInviteUrl || ""}
                    readOnly
                    className="w-64 text-xs"
                    data-testid="input-guest-rsvp-url"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => copyToClipboard(guestInviteUrl || "", "guest")}
                    data-testid="button-copy-guest-rsvp"
                  >
                    {copiedLink === "guest" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => window.open(guestInviteUrl || "", "_blank")}
                    data-testid="button-open-guest-rsvp"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => createGuestInviteToken.mutate()}
                  disabled={createGuestInviteToken.isPending || loadingGuestToken}
                  data-testid="button-create-guest-rsvp"
                >
                  {createGuestInviteToken.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Generate Link
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            RSVP Summary
          </h4>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "rsvp-summary"] })}
            data-testid="button-refresh-rsvp"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-green-600">
                <Check className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.attending ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Attending</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-yellow-600">
                <UserPlus className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.maybe ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Maybe</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-red-600">
                <XCircle className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.declined ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Declined</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-blue-600">
                <Baby className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.totalKids ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Total Kids</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-purple-600">
                <Users className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.totalAdults ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Total Adults</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <Users className="h-4 w-4" />
                <span className="text-2xl font-bold">{rsvpSummary?.total ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Total Responses</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
