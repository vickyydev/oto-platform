import { useState, useCallback } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, FileSignature, CheckCircle, AlertCircle, Calendar, User, Building2, MapPin } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import SignaturePad from "@/components/signature-pad";

const otoTheme = {
  bgInk: '#1a1625',
  surfaceCard: '#252131',
  surfacePaper: '#fefefe',
  textPrimary: '#ffffff',
  textMuted: '#9ca3af',
  divider: 'rgba(255,255,255,0.08)',
  brandPrimary: '#ff7b5c',
  brandSecondary: '#5cd6c8',
  brandAccent: '#a78bfa',
  brandLime: '#bef264',
};

interface LetterData {
  letter: {
    id: string;
    letterType: "resignation" | "termination";
    status: string;
    renderedHtmlSnapshot: string;
    metadataJson: {
      employeeName: string;
      offboardingType: string;
      reasonCode: string;
      reasonText: string;
      lastWorkingDay: string;
    };
  };
  employee: {
    fullName: string;
    email: string;
  } | null;
  branch: {
    name: string;
    address: string;
    logoUrl: string | null;
  } | null;
  offboarding: {
    offboardingType: string;
    reasonText: string;
    lastWorkingDay: string;
  } | null;
}

function formatDateDDMMYYYY(dateStr: string): string {
  if (!dateStr) return "—";
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

function InfoRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="h-5 w-5 mt-0.5 flex-shrink-0 flex items-center justify-center" style={{ color: otoTheme.brandSecondary }}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: otoTheme.textMuted }}>{label}</p>
        <p className="font-medium" style={{ color: otoTheme.textPrimary }}>{value}</p>
      </div>
    </div>
  );
}

export default function LetterSigningPage() {
  const { token } = useParams<{ token: string }>();
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [signed, setSigned] = useState(false);
  const [signedAt, setSignedAt] = useState<Date | null>(null);

  const handleSignatureChange = useCallback((dataUrl: string | null) => {
    setSignatureImage(dataUrl);
  }, []);

  const { data: letterData, isLoading, error } = useQuery<LetterData>({
    queryKey: ["/api/letter-sign", token],
    queryFn: async () => {
      const response = await fetch(`/api/letter-sign/${token}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to load letter");
      }
      return response.json();
    },
    retry: false,
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/letter-sign/${token}`, {
        signatureImage,
        signedName: letterData?.employee?.fullName || "",
      });
      return response.json();
    },
    onSuccess: () => {
      setSigned(true);
      setSignedAt(new Date());
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: otoTheme.brandPrimary }} />
          <p style={{ color: otoTheme.textMuted }}>Loading your letter...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="rounded-2xl p-8 max-w-md w-full text-center shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}>
              <AlertCircle className="h-12 w-12 text-red-500" />
            </div>
          </div>
          <h2 className="text-xl font-semibold mb-2" style={{ color: otoTheme.textPrimary }}>Unable to Load Letter</h2>
          <p className="mb-4" style={{ color: otoTheme.textMuted }}>
            {(error as Error).message || "This signing link may have expired or already been used."}
          </p>
          <p className="text-sm" style={{ color: otoTheme.textMuted }}>
            Please contact HR if you need a new signing link.
          </p>
        </div>
      </div>
    );
  }

  if (letterData?.letter.status === "signed") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="rounded-2xl p-8 max-w-md w-full text-center shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full" style={{ backgroundColor: `${otoTheme.brandSecondary}15` }}>
              <CheckCircle className="h-12 w-12" style={{ color: otoTheme.brandSecondary }} />
            </div>
          </div>
          <h2 className="text-xl font-semibold mb-2" style={{ color: otoTheme.textPrimary }}>Letter Already Signed</h2>
          <p className="mb-4" style={{ color: otoTheme.textMuted }}>
            This {letterData.letter.letterType} letter has already been signed.
          </p>
        </div>
      </div>
    );
  }

  if (signed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="rounded-2xl p-8 max-w-md w-full text-center shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full" style={{ backgroundColor: `${otoTheme.brandSecondary}15` }}>
              <CheckCircle className="h-12 w-12" style={{ color: otoTheme.brandSecondary }} />
            </div>
          </div>
          <h2 className="text-xl font-semibold mb-2" style={{ color: otoTheme.textPrimary }}>Letter Signed Successfully</h2>
          <p className="mb-4" style={{ color: otoTheme.textMuted }}>
            Thank you, {letterData?.employee?.fullName}! Your {letterData?.letter.letterType} letter has been signed.
          </p>
          <p className="text-sm mb-6" style={{ color: otoTheme.textMuted }}>
            Signed on {signedAt ? formatDateDDMMYYYY(signedAt.toISOString()) : ""}
            {signedAt && ` at ${signedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
          <p className="text-sm" style={{ color: otoTheme.textMuted }}>
            A copy of this letter will be kept in your HR records.
          </p>
        </div>
      </div>
    );
  }

  const letterType = letterData?.letter.letterType === "resignation" ? "Resignation" : "Termination";
  const lastWorkingDay = letterData?.offboarding?.lastWorkingDay || letterData?.letter.metadataJson?.lastWorkingDay;

  return (
    <div className="min-h-screen" style={{ backgroundColor: otoTheme.bgInk }}>
      <div className="max-w-2xl mx-auto p-4 sm:p-6 lg:p-8">
        {letterData?.branch?.logoUrl && (
          <div className="flex justify-center mb-6">
            <img 
              src={letterData.branch.logoUrl} 
              alt={letterData.branch.name || "Company Logo"} 
              className="h-16 object-contain"
              width="200"
              height="64"
            />
          </div>
        )}

        <div className="rounded-2xl p-6 mb-6 shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <div className="flex items-center gap-3 mb-6">
            <FileSignature className="h-6 w-6" style={{ color: otoTheme.brandPrimary }} />
            <h1 className="text-2xl font-bold" style={{ color: otoTheme.textPrimary }}>
              {letterType} Letter
            </h1>
          </div>

          <div className="space-y-1 mb-6" style={{ borderBottom: `1px solid ${otoTheme.divider}`, paddingBottom: '1rem' }}>
            <InfoRow icon={User} label="Employee Name" value={letterData?.employee?.fullName || "—"} />
            <InfoRow icon={Building2} label="Company" value={letterData?.branch?.name || "—"} />
            {letterData?.branch?.address && (
              <InfoRow icon={MapPin} label="Branch Address" value={letterData.branch.address} />
            )}
            {lastWorkingDay && (
              <InfoRow icon={Calendar} label="Last Working Day" value={formatDateDDMMYYYY(lastWorkingDay)} />
            )}
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-3" style={{ color: otoTheme.brandAccent }}>
              Letter Content
            </h3>
            {letterData?.letter.renderedHtmlSnapshot ? (
              <div 
                className="prose prose-sm max-w-none rounded-lg p-4"
                style={{ backgroundColor: otoTheme.surfacePaper, color: '#1f2937' }}
                dangerouslySetInnerHTML={{ __html: letterData.letter.renderedHtmlSnapshot }}
              />
            ) : (
              <div className="rounded-lg p-4" style={{ backgroundColor: otoTheme.surfacePaper }}>
                <p className="text-gray-600 mb-4">
                  This is to confirm that <strong>{letterData?.employee?.fullName}</strong> is leaving the company
                  {letterData?.letter.letterType === "resignation" ? " voluntarily" : ""}.
                </p>
                {letterData?.offboarding?.reasonText && (
                  <p className="text-gray-600 mb-4">
                    Reason: {letterData.offboarding.reasonText}
                  </p>
                )}
                {lastWorkingDay && (
                  <p className="text-gray-600">
                    Last working day: {formatDateDDMMYYYY(lastWorkingDay)}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl p-6 shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <h2 className="text-xl font-semibold mb-4" style={{ color: otoTheme.textPrimary }}>
            Sign This Letter
          </h2>

          <div className="mb-6">
            <label className="block text-sm mb-2" style={{ color: otoTheme.textMuted }}>
              Your Signature
            </label>
            <div className="rounded-xl overflow-hidden" style={{ border: `2px dashed ${otoTheme.divider}` }}>
              <SignaturePad 
                onSignatureChange={handleSignatureChange}
                value={signatureImage}
              />
            </div>
            <p className="text-xs mt-2" style={{ color: otoTheme.textMuted }}>
              Please sign in the box above using your mouse or touch screen
            </p>
          </div>

          <div className="flex items-start gap-3 mb-6 p-4 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <Checkbox
              id="agree-terms"
              checked={agreedToTerms}
              onCheckedChange={(checked) => setAgreedToTerms(!!checked)}
              data-testid="checkbox-agree-terms"
            />
            <label 
              htmlFor="agree-terms" 
              className="text-sm cursor-pointer leading-relaxed"
              style={{ color: otoTheme.textPrimary }}
            >
              I, <strong>{letterData?.employee?.fullName}</strong>, acknowledge that I have read and understand 
              this {letterType.toLowerCase()} letter. I confirm that the information is accurate and I am signing 
              this document voluntarily.
            </label>
          </div>

          <Button
            className="w-full py-6 text-lg font-semibold"
            style={{ 
              backgroundColor: otoTheme.brandPrimary,
              color: '#ffffff',
            }}
            disabled={!signatureImage || !agreedToTerms || signMutation.isPending}
            onClick={() => signMutation.mutate()}
            data-testid="button-sign-letter"
          >
            {signMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Signing...
              </>
            ) : (
              <>
                <FileSignature className="mr-2 h-5 w-5" />
                Sign {letterType} Letter
              </>
            )}
          </Button>

          {signMutation.error && (
            <div className="mt-4 p-4 rounded-lg text-center" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}>
              <p className="text-red-400 text-sm">
                {(signMutation.error as Error).message || "Failed to sign letter. Please try again."}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
