import { useState, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  Upload,
  Check,
  Download,
  Copy,
  Share2,
  Loader2,
  PartyPopper,
} from "lucide-react";
import { OtoInviteCard } from "@/components/oto-invite-card";
import type { ParentExperienceLanguage } from "@shared/localization";

interface ParentPortalFullData {
  event: {
    id: string;
    name: string;
    childName: string | null;
    childAgeTurning: number | null;
    eventDate: string;
    startTime: string;
    endTime: string | null;
    locationName: string | null;
  };
  design: {
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
    photoUrl: string | null;
    generatedImageUrl: string | null;
  } | null;
  guestInviteToken: string;
}

export default function ParentInvitationWizardPage() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [currentStep, setCurrentStep] = useState(1);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const { data, isLoading, error } = useQuery<ParentPortalFullData>({
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

  const saveDesignMutation = useMutation({
    mutationFn: async (designData: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/public/parent-portal/${token}/invitation-design`, designData);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/public/parent-portal", token] });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "An error occurred", variant: "destructive" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/public/parent-portal/${token}/generate-invitation`, {});
      return res.json();
    },
    onSuccess: (result) => {
      setGeneratedImageUrl(result.imageUrl);
      setCurrentStep(2);
      toast({ title: "Your Invitation is Ready!" });
      queryClient.invalidateQueries({ queryKey: ["/api/public/parent-portal", token] });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "An error occurred", variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file", variant: "destructive" });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Image must be less than 5MB", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotoPreview(ev.target?.result as string);
    };
    reader.readAsDataURL(file);

    try {
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`/api/public/parent-portal/${token}/upload-photo`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      const { photoUrl: uploadedUrl } = await res.json();
      setPhotoUrl(uploadedUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to upload photo";
      toast({ title: message, variant: "destructive" });
      setPhotoPreview(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleGenerate = async () => {
    if (!data?.event) return;

    await saveDesignMutation.mutateAsync({
      themeId: "enchanted_castle",
      language: "en",
      childName: data.event.childName || data.event.name,
      childAge: data.event.childAgeTurning ? String(data.event.childAgeTurning) : null,
      message: null,
      eventDate: data.event.eventDate,
      startTime: data.event.startTime,
      endTime: data.event.endTime || null,
      locationName: data.event.locationName || null,
      photoUrl: photoUrl || null,
    });

    generateMutation.mutate();
  };

  const handleDownload = async () => {
    if (!generatedImageUrl) return;
    try {
      const response = await fetch(generatedImageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `OTO-Invitation-${data?.event?.childName || "Party"}-${new Date().toISOString().split("T")[0]}.jpg`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({ title: "Downloaded!" });
    } catch {
      toast({ title: "An error occurred", variant: "destructive" });
    }
  };

  const handleCopyLink = async () => {
    const rsvpLink = `${baseUrl}/rsvp/${data?.guestInviteToken}`;
    try {
      await navigator.clipboard.writeText(rsvpLink);
      toast({ title: "Copy Link" });
    } catch {
      toast({ title: "An error occurred", variant: "destructive" });
    }
  };

  const handleShareWhatsApp = () => {
    const rsvpLink = `${baseUrl}/rsvp/${data?.guestInviteToken}`;
    const childName = data?.event?.childName || "the birthday child";
    const message = encodeURIComponent(`You're invited to ${childName}'s party! RSVP here: ${rsvpLink}`);
    window.open(`https://wa.me/?text=${message}`, "_blank");
  };

  if (isLoading) return <LoadingScreen />;

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDF8F2] p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <PartyPopper className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h1 className="text-xl font-bold mb-2">Access Denied</h1>
            <p className="text-muted-foreground">This portal link is invalid or has been revoked.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { event } = data;
  const childName = event.childName || event.name;
  const ageTurning = event.childAgeTurning ?? null;

  return (
    <div className="min-h-screen" style={{ background: "#FDF8F2" }}>
      <div className="max-w-lg mx-auto p-4 pb-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="ghost"
            onClick={() => setLocation(`/parent/${token}`)}
            className="gap-2"
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" />
            Party Plan
          </Button>
        </div>

        <h1 className="text-xl font-bold mb-6 text-center" style={{ color: "#E8734A" }}>
          Create Your Invitation
        </h1>

        {/* Step 1: Photo Upload + Preview */}
        {currentStep === 1 && (
          <div className="space-y-6">
            {/* Live preview */}
            <OtoInviteCard
              childName={childName}
              ageTurning={ageTurning}
              eventDate={event.eventDate}
              startTime={event.startTime}
              endTime={event.endTime}
              locationName={event.locationName}
              photoUrl={photoPreview || photoUrl}
            />

            <Card>
              <CardContent className="pt-6 space-y-4">
                <div>
                  <p className="font-medium mb-1">Upload a photo of the birthday child</p>
                  <p className="text-sm text-muted-foreground mb-3">
                    A photo will appear in the circular frame on the invite. You can skip this if you prefer.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    className="hidden"
                  />
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed rounded-lg p-5 cursor-pointer hover:border-orange-400 transition-colors flex flex-col items-center justify-center min-h-[110px]"
                    style={{ borderColor: "#E8A8C8" }}
                  >
                    {isUploading ? (
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    ) : photoPreview ? (
                      <div className="flex flex-col items-center gap-2">
                        <img
                          src={photoPreview}
                          alt="Preview"
                          className="h-20 w-20 rounded-full object-cover border-2"
                          style={{ borderColor: "#D95BA3" }}
                        />
                        <span className="text-sm text-muted-foreground">Tap to change photo</span>
                      </div>
                    ) : (
                      <>
                        <Upload className="h-7 w-7 mb-2" style={{ color: "#E8734A" }} />
                        <span className="text-muted-foreground text-sm">Tap to upload photo</span>
                      </>
                    )}
                  </div>
                </div>

                <Button
                  onClick={handleGenerate}
                  disabled={saveDesignMutation.isPending || generateMutation.isPending}
                  className="w-full"
                  style={{ background: "#E8734A", borderColor: "#E8734A" }}
                  data-testid="button-generate"
                >
                  {(saveDesignMutation.isPending || generateMutation.isPending) ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Generating…
                    </>
                  ) : (
                    "Generate Invitation"
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 2: Done — share */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <div className="text-center">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ background: "#E8734A20" }}
              >
                <Check className="h-7 w-7" style={{ color: "#E8734A" }} />
              </div>
              <h2 className="text-xl font-bold" style={{ color: "#E8734A" }}>
                Your Invitation is Ready!
              </h2>
            </div>

            {generatedImageUrl && (
              <div className="rounded-xl overflow-hidden shadow-md">
                <img src={generatedImageUrl} alt="Generated Invitation" className="w-full" />
              </div>
            )}

            <div className="grid gap-3">
              <Button onClick={handleDownload} className="w-full" style={{ background: "#E8734A" }} data-testid="button-download">
                <Download className="h-4 w-4 mr-2" />
                Download JPG
              </Button>
              <Button variant="outline" onClick={handleCopyLink} className="w-full" data-testid="button-copy-rsvp">
                <Copy className="h-4 w-4 mr-2" />
                Copy RSVP Link
              </Button>
              <Button variant="outline" onClick={handleShareWhatsApp} className="w-full" data-testid="button-share-whatsapp">
                <Share2 className="h-4 w-4 mr-2" />
                Share on WhatsApp
              </Button>
            </div>

            <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
              <p className="text-sm text-yellow-800">Share the RSVP link with guests so they can respond.</p>
            </div>

            <div className="flex justify-center gap-3">
              <Button
                variant="ghost"
                onClick={() => setCurrentStep(1)}
                data-testid="button-regenerate"
              >
                Regenerate
              </Button>
              <Button
                variant="ghost"
                onClick={() => setLocation(`/parent/${token}`)}
                data-testid="button-done"
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
