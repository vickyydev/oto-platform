import { useState, useCallback } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, FileSignature, CheckCircle, AlertCircle, Download, Briefcase, Calendar, MapPin, User, Mail, Phone, Gift, BookOpen, ExternalLink, Plane } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import SignaturePad from "@/components/signature-pad";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// OTO Brand Theme Colors
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

interface VisaPolicy {
  companyHandles: boolean;
  companyPays: boolean;
  costThb: number | null;
  repaymentIfFailProbation: boolean;
  repaymentIfLeaveBefore1y: boolean;
  repaymentTermsText: string | null;
  notes: string | null;
}

interface ContractData {
  contractHtml: string;
  employeeName: string;
  employeeEmail: string;
  employeePhone: string | null;
  mergeData: {
    positionTitle: string;
    salaryThb: number;
    startDate: string;
    workLocation: string;
    incentiveClause?: string;
    customClauses?: Array<{ title: string; body: string }>;
  };
  incentiveClauseText: string | null;
  foodAllowancePerDay: number | null;
  branchLogoUrl: string | null;
  branchName: string | null;
  visaPolicy: VisaPolicy | null;
}

interface PolicyData {
  id: string;
  title: string;
  contentHtml: string;
  versionInt: number;
  publishedAt: string | null;
  contentHash: string | null;
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

function ThaiBalhtIcon({ className }: { className?: string }) {
  return (
    <span className={className} style={{ fontWeight: 500 }}>฿</span>
  );
}

function InfoRow({ icon: Icon, label, value, isBalht }: { icon?: any; label: string; value: string; isBalht?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="h-5 w-5 mt-0.5 flex-shrink-0 flex items-center justify-center" style={{ color: otoTheme.brandSecondary }}>
        {isBalht ? <ThaiBalhtIcon className="text-lg" /> : Icon && <Icon className="h-5 w-5" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: otoTheme.textMuted }}>{label}</p>
        <p className="font-medium" style={{ color: otoTheme.textPrimary }}>{value}</p>
      </div>
    </div>
  );
}

function Section({ title, children, number }: { title: string; children: React.ReactNode; number?: string }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2" style={{ color: otoTheme.brandAccent }}>
        {number && <span style={{ color: otoTheme.brandAccent }}>{number}.</span>}
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export default function SigningPage() {
  const { token } = useParams<{ token: string }>();
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreedToPolicy, setAgreedToPolicy] = useState(false);
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [signed, setSigned] = useState(false);
  const [signedAt, setSignedAt] = useState<Date | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [downloadToken, setDownloadToken] = useState<string | null>(null);

  const handleSignatureChange = useCallback((dataUrl: string | null) => {
    setSignatureImage(dataUrl);
  }, []);

  const { data: contractData, isLoading, error } = useQuery<ContractData>({
    queryKey: ["/api/signing", token],
    queryFn: async () => {
      const response = await fetch(`/api/signing/${token}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to load contract");
      }
      return response.json();
    },
    retry: false,
  });

  const { data: policyData } = useQuery<PolicyData | null>({
    queryKey: ["/api/signing", token, "policy"],
    queryFn: async () => {
      const response = await fetch(`/api/signing/${token}/policy`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!contractData,
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/signing/${token}/sign`, {
        signatureImage,
        agreedToTerms,
        agreedToPolicy: policyData ? agreedToPolicy : null,
      });
      return response.json();
    },
    onSuccess: (data) => {
      setSigned(true);
      setSignedAt(new Date(data.signedAt));
      setContractId(data.contractId);
      setDownloadToken(data.downloadToken);
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: otoTheme.brandPrimary }} />
          <p style={{ color: otoTheme.textMuted }}>Loading your contract...</p>
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
          <h2 className="text-xl font-semibold mb-2" style={{ color: otoTheme.textPrimary }}>Unable to Load Contract</h2>
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

  const handleDownloadPdf = () => {
    if (contractId && downloadToken) {
      window.open(`/api/contracts/${contractId}/download-signed-pdf?token=${encodeURIComponent(downloadToken)}`, '_blank');
    }
  };

  if (signed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: otoTheme.bgInk }}>
        <div className="rounded-2xl p-8 max-w-md w-full text-center shadow-xl" style={{ backgroundColor: otoTheme.surfaceCard }}>
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full" style={{ backgroundColor: `${otoTheme.brandSecondary}15` }}>
              <CheckCircle className="h-12 w-12" style={{ color: otoTheme.brandSecondary }} />
            </div>
          </div>
          <h2 className="text-xl font-semibold mb-2" style={{ color: otoTheme.textPrimary }}>Contract Signed Successfully</h2>
          <p className="mb-4" style={{ color: otoTheme.textMuted }}>
            Thank you, {contractData?.employeeName}! Your contract has been signed.
          </p>
          <p className="text-sm mb-6" style={{ color: otoTheme.textMuted }}>
            Signed on {signedAt ? formatDateDDMMYYYY(signedAt.toISOString()) : ""}
            {signedAt && ` at ${signedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
          <Button 
            onClick={handleDownloadPdf}
            className="w-full text-white border-0"
            size="lg"
            style={{ backgroundColor: otoTheme.brandPrimary }}
            data-testid="button-download-signed-pdf"
          >
            <Download className="mr-2 h-4 w-4" />
            Download Signed Contract
          </Button>
        </div>
      </div>
    );
  }

  // Can sign only if: has signature, agreed to terms, and (no policy OR agreed to policy)
  const canSign = signatureImage !== null && agreedToTerms && (!policyData || agreedToPolicy);
  const mergeData = contractData?.mergeData;

  return (
    <div className="min-h-screen" style={{ backgroundColor: otoTheme.bgInk }}>
      {/* Subtle Gradient Glow Header */}
      <div 
        className="absolute top-0 left-0 right-0 h-64 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 80% 50% at 50% 0%, ${otoTheme.brandAccent}12 0%, transparent 50%), 
                       radial-gradient(ellipse 60% 40% at 30% 10%, ${otoTheme.brandPrimary}10 0%, transparent 50%),
                       radial-gradient(ellipse 60% 40% at 70% 10%, ${otoTheme.brandSecondary}10 0%, transparent 50%)`,
        }}
      />

      {/* Header with Logo */}
      <header className="relative py-6 px-3">
        <div className="flex justify-center">
          {contractData?.branchLogoUrl ? (
            <img 
              src={contractData.branchLogoUrl} 
              alt={contractData.branchName || "Company Logo"} 
              className="h-14 max-w-[200px] object-contain"
              width="200"
              height="56"
            />
          ) : (
            <div className="flex items-center gap-3">
              <div 
                className="flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: otoTheme.brandPrimary }}
              >
                <FileSignature className="h-6 w-6 text-white" />
              </div>
              {contractData?.branchName && (
                <span className="text-xl font-semibold" style={{ color: otoTheme.textPrimary }}>{contractData.branchName}</span>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Key Details Section - Centered Card */}
      <section className="relative px-2 sm:px-4 max-w-2xl mx-auto">
        <div 
          className="rounded-2xl shadow-xl overflow-hidden mb-6"
          style={{ backgroundColor: otoTheme.surfaceCard }}
        >
          {/* Contract Title */}
          <div 
            className="px-4 sm:px-6 py-5"
            style={{ 
              background: `linear-gradient(135deg, ${otoTheme.brandPrimary}20 0%, ${otoTheme.brandAccent}15 50%, ${otoTheme.brandSecondary}10 100%)`,
              borderBottom: `1px solid ${otoTheme.divider}`,
            }}
          >
            <h1 className="text-2xl font-bold text-center" style={{ color: otoTheme.textPrimary }}>Employment Contract</h1>
            <p className="text-center text-sm mt-1" style={{ color: otoTheme.textMuted }}>Please review and sign below</p>
          </div>

          {/* Key Details */}
          <div className="p-4 sm:p-6 space-y-6">
            {/* Employee Information */}
            <Section title="Employee Information" number="1">
              <div 
                className="rounded-xl p-4"
                style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderTop: `1px solid ${otoTheme.divider}` }}
              >
                <div style={{ borderBottom: `1px solid ${otoTheme.divider}` }}>
                  <InfoRow icon={User} label="Full Name" value={contractData?.employeeName || ""} />
                </div>
                <div style={{ borderBottom: contractData?.employeePhone ? `1px solid ${otoTheme.divider}` : 'none' }}>
                  <InfoRow icon={Mail} label="Email" value={contractData?.employeeEmail || ""} />
                </div>
                {contractData?.employeePhone && (
                  <InfoRow icon={Phone} label="Phone" value={contractData.employeePhone} />
                )}
              </div>
            </Section>

            {/* Position & Compensation */}
            <Section title="Position & Compensation" number="2">
              <div 
                className="rounded-xl p-4"
                style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderTop: `1px solid ${otoTheme.divider}` }}
              >
                <div style={{ borderBottom: `1px solid ${otoTheme.divider}` }}>
                  <InfoRow icon={Briefcase} label="Position Title" value={mergeData?.positionTitle || "—"} />
                </div>
                <div style={{ borderBottom: `1px solid ${otoTheme.divider}` }}>
                  <InfoRow 
                    isBalht 
                    label="Monthly Salary" 
                    value={mergeData?.salaryThb ? `฿${mergeData.salaryThb.toLocaleString()} / month` : "—"} 
                  />
                </div>
                <div style={{ borderBottom: `1px solid ${otoTheme.divider}` }}>
                  <InfoRow icon={Calendar} label="Start Date" value={formatDateDDMMYYYY(mergeData?.startDate || "")} />
                </div>
                <InfoRow icon={MapPin} label="Work Location" value={contractData?.branchName || mergeData?.workLocation || "—"} />
              </div>
              
              {/* Incentives & Bonus */}
              {(contractData?.incentiveClauseText || contractData?.foodAllowancePerDay) && (
                <div 
                  className="mt-3 rounded-xl p-4"
                  style={{ 
                    backgroundColor: `${otoTheme.brandLime}10`,
                    border: `1px solid ${otoTheme.brandLime}30`,
                  }}
                >
                  <div className="flex items-start gap-3">
                    <Gift className="h-5 w-5 mt-0.5 flex-shrink-0" style={{ color: otoTheme.brandLime }} />
                    <div className="space-y-2">
                      <p className="font-medium text-sm" style={{ color: otoTheme.brandLime }}>Incentive/Commission and Allowance</p>
                      {contractData?.foodAllowancePerDay && (
                        <p className="text-sm leading-relaxed" style={{ color: otoTheme.textMuted }}>
                          Food Allowance: <strong>฿{contractData.foodAllowancePerDay.toLocaleString()}</strong> per day worked
                        </p>
                      )}
                      {contractData?.incentiveClauseText && (
                        <p className="text-sm leading-relaxed" style={{ color: otoTheme.textMuted }}>{contractData.incentiveClauseText}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Visa & Work Permit Policy */}
              {contractData?.visaPolicy && (
                <div 
                  className="mt-3 rounded-xl p-4"
                  style={{ 
                    backgroundColor: `${otoTheme.brandSecondary}10`,
                    border: `1px solid ${otoTheme.brandSecondary}30`,
                  }}
                >
                  <div className="flex items-start gap-3">
                    <Plane className="h-5 w-5 mt-0.5 flex-shrink-0" style={{ color: otoTheme.brandSecondary }} />
                    <div className="flex-1">
                      <p className="font-medium text-sm mb-2" style={{ color: otoTheme.brandSecondary }}>Visa & Work Permit</p>
                      <div className="space-y-1">
                        {contractData.visaPolicy.companyHandles && (
                          <p className="text-sm" style={{ color: otoTheme.textMuted }}>
                            The company will handle visa and work permit arrangements.
                          </p>
                        )}
                        {contractData.visaPolicy.companyPays && (
                          <p className="text-sm" style={{ color: otoTheme.textMuted }}>
                            The company will cover the cost of visa and work permit
                            {contractData.visaPolicy.costThb && ` (estimated: ฿${contractData.visaPolicy.costThb.toLocaleString()})`}.
                          </p>
                        )}
                        {(contractData.visaPolicy.repaymentIfFailProbation || contractData.visaPolicy.repaymentIfLeaveBefore1y) && (
                          <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${otoTheme.brandSecondary}30` }}>
                            <p className="text-sm font-medium mb-1" style={{ color: otoTheme.textMuted }}>Repayment Terms:</p>
                            <ul className="text-sm space-y-1" style={{ color: otoTheme.textMuted }}>
                              {contractData.visaPolicy.repaymentIfFailProbation && (
                                <li>Cost is repayable if probation is not passed</li>
                              )}
                              {contractData.visaPolicy.repaymentIfLeaveBefore1y && (
                                <li>Cost is repayable if leaving within 1 year</li>
                              )}
                            </ul>
                          </div>
                        )}
                        {contractData.visaPolicy.repaymentTermsText && (
                          <p className="text-sm mt-2 italic" style={{ color: otoTheme.textMuted }}>
                            {contractData.visaPolicy.repaymentTermsText}
                          </p>
                        )}
                        {contractData.visaPolicy.notes && (
                          <p className="text-sm mt-2" style={{ color: otoTheme.textMuted }}>
                            {contractData.visaPolicy.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Section>
          </div>
        </div>
      </section>

      {/* Contract Terms - Edge-to-Edge Document Mode */}
      <section className="mb-6">
        {/* Section Header */}
        <div 
          className="px-4 sm:px-6 py-4"
          style={{ 
            borderTop: `1px solid ${otoTheme.divider}`,
            backgroundColor: `${otoTheme.surfaceCard}80`,
          }}
        >
          <h3 className="text-lg font-semibold flex items-center gap-2 max-w-2xl mx-auto" style={{ color: otoTheme.brandAccent }}>
            <span style={{ color: otoTheme.brandAccent }}>3.</span>
            Contract Terms
          </h3>
        </div>
        
        {/* Full-Width Document Content */}
        <div style={{ backgroundColor: otoTheme.surfacePaper }}>
          <div 
            className="px-4 sm:px-8 md:px-12 py-6 sm:py-8 prose prose-base max-w-none"
            style={{ 
              fontSize: '17px',
              lineHeight: '1.8',
              color: '#1f2937',
            }}
            dangerouslySetInnerHTML={{ __html: contractData?.contractHtml || "" }}
            data-testid="contract-content"
          />
        </div>
      </section>

      {/* Signature Section - Centered Card */}
      <section className="px-2 sm:px-4 pb-8 max-w-2xl mx-auto">
        <div 
          className="rounded-2xl shadow-xl overflow-hidden"
          style={{ backgroundColor: otoTheme.surfaceCard }}
        >
          <div className="p-4 sm:p-6">
            {/* Sign Header */}
            <div className="text-center mb-6">
              <div className="flex justify-center mb-3">
                <div 
                  className="p-3 rounded-full"
                  style={{ backgroundColor: `${otoTheme.brandPrimary}15` }}
                >
                  <FileSignature className="h-8 w-8" style={{ color: otoTheme.brandPrimary }} />
                </div>
              </div>
              <h2 className="text-xl font-semibold" style={{ color: otoTheme.textPrimary }}>Sign Here</h2>
              <p className="text-sm mt-1" style={{ color: otoTheme.textMuted }}>Draw your signature in the box below</p>
            </div>

            {/* Signature Pad */}
            <div className="mb-6">
              <SignaturePad 
                onSignatureChange={handleSignatureChange}
                disabled={signMutation.isPending}
                value={signatureImage}
              />
            </div>

            {/* Agreement Checkbox */}
            <div 
              className="flex items-start gap-3 p-4 rounded-xl mb-4"
              style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
            >
              <Checkbox
                id="agree"
                checked={agreedToTerms}
                onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
                className="mt-0.5"
                style={{ 
                  borderColor: otoTheme.textMuted,
                  '--checkbox-checked-bg': otoTheme.brandSecondary,
                } as any}
                data-testid="checkbox-agree"
              />
              <label htmlFor="agree" className="cursor-pointer">
                <span className="text-sm font-medium block" style={{ color: otoTheme.textPrimary }}>
                  I have read and agree to all terms in this employment contract
                </span>
                <span className="text-xs block mt-1" style={{ color: otoTheme.textMuted }}>
                  By checking this box, you confirm that you understand and accept all conditions.
                </span>
              </label>
            </div>

            {/* Policy Acknowledgment Checkbox - only shown if there's a policy */}
            {policyData && (
              <div 
                className="flex items-start gap-3 p-4 rounded-xl mb-6"
                style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
              >
                <Checkbox
                  id="agreePolicy"
                  checked={agreedToPolicy}
                  onCheckedChange={(checked) => setAgreedToPolicy(checked === true)}
                  className="mt-0.5"
                  style={{ 
                    borderColor: otoTheme.textMuted,
                    '--checkbox-checked-bg': otoTheme.brandAccent,
                  } as any}
                  data-testid="checkbox-agree-policy"
                />
                <div className="flex-1">
                  <label htmlFor="agreePolicy" className="cursor-pointer">
                    <span className="text-sm font-medium block" style={{ color: otoTheme.textPrimary }}>
                      I have read and acknowledge the company Rules & Regulations
                    </span>
                    <span className="text-xs block mt-1" style={{ color: otoTheme.textMuted }}>
                      By checking this box, you confirm that you have reviewed and will comply with the company policies.
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPolicyDialogOpen(true)}
                    className="mt-2 h-auto py-1 px-2"
                    style={{ color: otoTheme.brandAccent }}
                    data-testid="button-view-policy"
                  >
                    <BookOpen className="mr-1 h-3 w-3" />
                    View {policyData.title} (v{policyData.versionInt})
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}

            {/* Requirements checklist before signing */}
            {!canSign && !signMutation.isPending && (
              <div 
                className="mb-4 p-3 rounded-xl text-sm"
                style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: `1px solid ${otoTheme.divider}` }}
              >
                <p className="font-medium mb-2" style={{ color: otoTheme.textMuted }}>
                  Please complete the following to sign:
                </p>
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2" style={{ color: signatureImage ? otoTheme.brandSecondary : otoTheme.textMuted }}>
                    {signatureImage ? (
                      <CheckCircle className="h-4 w-4" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border flex items-center justify-center text-xs" style={{ borderColor: otoTheme.textMuted }}>1</span>
                    )}
                    Draw your signature above
                  </li>
                  <li className="flex items-center gap-2" style={{ color: agreedToTerms ? otoTheme.brandSecondary : otoTheme.textMuted }}>
                    {agreedToTerms ? (
                      <CheckCircle className="h-4 w-4" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border flex items-center justify-center text-xs" style={{ borderColor: otoTheme.textMuted }}>2</span>
                    )}
                    Agree to contract terms
                  </li>
                  {policyData && (
                    <li className="flex items-center gap-2" style={{ color: agreedToPolicy ? otoTheme.brandSecondary : otoTheme.textMuted }}>
                      {agreedToPolicy ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <span className="h-4 w-4 rounded-full border flex items-center justify-center text-xs" style={{ borderColor: otoTheme.textMuted }}>3</span>
                      )}
                      Acknowledge company policies
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* Sign Button */}
            <Button
              className="w-full h-12 text-base font-medium text-white border-0 transition-all"
              size="lg"
              onClick={() => signMutation.mutate()}
              disabled={!canSign || signMutation.isPending}
              style={{ 
                backgroundColor: canSign ? otoTheme.brandPrimary : `${otoTheme.brandPrimary}60`,
                boxShadow: canSign ? `0 4px 14px ${otoTheme.brandPrimary}40` : 'none',
                cursor: !canSign ? 'not-allowed' : 'pointer',
              }}
              data-testid="button-sign-contract"
            >
              {signMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Generating your signed contract...
                </>
              ) : (
                <>
                  <FileSignature className="mr-2 h-5 w-5" />
                  Sign Contract
                </>
              )}
            </Button>

            {/* Processing message during signing */}
            {signMutation.isPending && (
              <p className="text-sm text-center mt-3" style={{ color: otoTheme.textMuted }}>
                This may take a few moments. Please don't close this page.
              </p>
            )}

            {signMutation.error && (
              <p className="text-sm text-red-400 text-center mt-4">
                {(signMutation.error as Error).message || "Failed to sign contract. Please try again."}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Policy Viewer Dialog */}
      <Dialog open={policyDialogOpen} onOpenChange={setPolicyDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              {policyData?.title} (Version {policyData?.versionInt})
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            <div 
              className="bg-white rounded-md p-6 prose prose-sm max-w-none"
              style={{ 
                fontFamily: "'Times New Roman', Times, serif",
                color: '#1f2937',
              }}
              dangerouslySetInnerHTML={{ __html: policyData?.contentHtml || "" }}
              data-testid="policy-content"
            />
          </div>
          <div className="flex justify-end pt-4 border-t">
            <Button 
              onClick={() => setPolicyDialogOpen(false)}
              data-testid="button-close-policy"
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
