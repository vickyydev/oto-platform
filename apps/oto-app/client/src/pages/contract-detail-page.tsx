import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ContractInstance, Employee, Template, Setting } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Send,
  Download,
  Clock,
  CheckCircle,
  AlertCircle,
  FileSignature,
  User,
  Briefcase,
  DollarSign,
  Calendar,
  MapPin,
  Loader2,
  Mail,
  Link2,
  Copy,
  CheckCheck,
  PenLine,
  Sparkles,
  ArrowRight,
  Bell,
  X,
} from "lucide-react";
import { formatDate, formatDateTime, formatCurrency } from "@/lib/format-utils";

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
    draft: { variant: "secondary", icon: Clock },
    finalized: { variant: "outline", icon: CheckCircle },
    sent: { variant: "default", icon: Send },
    failed: { variant: "destructive", icon: AlertCircle },
  };

  const config = variants[status] || variants.draft;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className="capitalize">
      <Icon className="h-3 w-3 mr-1" />
      {status}
    </Badge>
  );
}

function DetailItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="font-medium">{value}</p>
      </div>
    </div>
  );
}

function SigningStatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType; label: string }> = {
    not_sent: { variant: "secondary", icon: Clock, label: "Not Sent for Signing" },
    awaiting_signature: { variant: "outline", icon: PenLine, label: "Awaiting Signature" },
    signed: { variant: "default", icon: CheckCheck, label: "Signed" },
    expired: { variant: "destructive", icon: AlertCircle, label: "Link Expired" },
  };

  const config = variants[status] || variants.not_sent;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant}>
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  );
}

export default function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { user } = useAuth();
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [signingLink, setSigningLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [showNextSteps, setShowNextSteps] = useState(true);
  
  // Staff role has read-only access
  const canEdit = user?.role !== "staff";

  const { data: contract, isLoading: contractLoading } = useQuery<ContractInstance>({
    queryKey: ["/api/contracts", id],
  });

  const { data: employee } = useQuery<Employee>({
    queryKey: ["/api/employees", contract?.employeeId],
    enabled: !!contract?.employeeId,
  });

  const { data: template } = useQuery<Template>({
    queryKey: ["/api/templates", contract?.templateId],
    enabled: !!contract?.templateId,
  });

  const { data: settings } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/contracts/${id}/finalize`);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      toast({
        title: "Contract finalized",
        description: "The contract PDF has been generated.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const sendEmailMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/contracts/${id}/send`, {
        to: emailTo,
        subject: emailSubject,
        body: emailBody,
      });
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      setEmailDialogOpen(false);
      toast({
        title: "Email sent",
        description: `Contract sent to ${emailTo}. Message ID: ${data.emailMessageId || "N/A"}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to send email",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateSigningLinkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/contracts/${id}/generate-signing-link`);
      return await res.json();
    },
    onSuccess: (data) => {
      setSigningLink(data.signingLink);
      queryClient.invalidateQueries({ queryKey: ["/api/contracts", id] });
      toast({
        title: "Signing link generated",
        description: "You can now copy and share this link with the employee.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Auto-populate signing link if contract already has one
  useEffect(() => {
    if (contract?.signingToken && contract.signingStatus === "awaiting_signature") {
      const baseUrl = window.location.origin;
      setSigningLink(`${baseUrl}/sign/${contract.signingToken}`);
    }
  }, [contract?.signingToken, contract?.signingStatus]);

  const copyToClipboard = async () => {
    const linkToCopy = signingLink;
    try {
      await navigator.clipboard.writeText(linkToCopy);
      setLinkCopied(true);
      toast({
        title: "Link copied",
        description: "Signing link copied to clipboard. Share it via WhatsApp, email, or any messenger.",
      });
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (err) {
      toast({
        title: "Failed to copy",
        description: "Please select and copy the link manually.",
        variant: "destructive",
      });
    }
  };

  const openEmailDialog = () => {
    const emailSubjectSetting = settings?.find((s) => s.key === "email_subject");
    const emailBodySetting = settings?.find((s) => s.key === "email_body");

    setEmailTo(employee?.email || "");
    setEmailSubject(
      emailSubjectSetting?.value?.replace("{{employee.full_name}}", employee?.fullName || "") ||
        `Your Employment Contract - ${employee?.fullName}`
    );
    setEmailBody(
      emailBodySetting?.value?.replace("{{employee.full_name}}", employee?.fullName || "") ||
        `Dear ${employee?.fullName},\n\nPlease find attached your employment contract.\n\nBest regards,\nHR Department`
    );
    setEmailDialogOpen(true);
  };

  if (contractLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-[400px]" />
          <Skeleton className="h-[400px] lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="text-center py-16">
          <FileSignature className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
          <h3 className="text-lg font-medium mb-2">Contract not found</h3>
          <p className="text-muted-foreground mb-6">
            The contract you're looking for doesn't exist.
          </p>
          <Link href="/contracts">
            <Button>Back to Contracts</Button>
          </Link>
        </div>
      </div>
    );
  }

  const mergeData = contract.mergeDataJson;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/contracts">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-medium" data-testid="text-contract-title">
              {mergeData.positionTitle}
            </h1>
            <StatusBadge status={contract.status} />
          </div>
          <p className="text-muted-foreground font-mono text-sm">
            Contract ID: {contract.id}
          </p>
        </div>
      </div>

      {/* Next Steps Panel - shown for finalized/awaiting signature contracts */}
      {showNextSteps && canEdit && contract.status === "finalized" && contract.signingStatus !== "signed" && (
        <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent" data-testid="card-next-steps">
          <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Next Steps</CardTitle>
                <CardDescription>Complete these actions to get the contract signed</CardDescription>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowNextSteps(false)}
              data-testid="button-dismiss-next-steps"
            >
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-card">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex-shrink-0">
                  <span className="text-sm font-semibold">1</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">Share signing link</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {contract.signingToken 
                      ? "Copy the signing link and send it to the employee via email or messaging"
                      : "Generate a signing link below to share with the employee"}
                  </p>
                  {contract.signingToken && (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="mt-2"
                      onClick={() => {
                        const link = `${window.location.origin}/sign/${contract.signingToken}`;
                        navigator.clipboard.writeText(link);
                        toast({ title: "Link copied to clipboard" });
                      }}
                      data-testid="button-copy-link-quick"
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      Copy Link
                    </Button>
                  )}
                </div>
              </div>
              
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-card">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex-shrink-0">
                  <span className="text-sm font-semibold">2</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">Track signing status</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Monitor the contract status below. You'll see when the employee views and signs the contract.
                  </p>
                  <Badge variant="outline" className="mt-2">
                    <Clock className="h-3 w-3 mr-1" />
                    {contract.signingStatus === "awaiting_signature" ? "Awaiting signature" : "Pending"}
                  </Badge>
                </div>
              </div>
              
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-card">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex-shrink-0">
                  <span className="text-sm font-semibold">3</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">After signing</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Once signed, the contract will be stored permanently. You can download the signed PDF anytime.
                  </p>
                  <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                    <CheckCircle className="h-3 w-3" />
                    Auto-saved to employee record
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Contract Details</CardTitle>
            <CardDescription>Information about this contract</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <DetailItem
              icon={User}
              label="Employee"
              value={employee?.fullName || "Unknown"}
            />
            <DetailItem
              icon={Mail}
              label="Email"
              value={employee?.email || "—"}
            />
            <DetailItem
              icon={Briefcase}
              label="Position"
              value={mergeData.positionTitle}
            />
            <DetailItem
              icon={DollarSign}
              label="Salary"
              value={`${mergeData.salaryThb.toLocaleString()} THB / month`}
            />
            <DetailItem
              icon={Calendar}
              label="Start Date"
              value={mergeData.startDate}
            />
            <DetailItem
              icon={MapPin}
              label="Work Location"
              value={mergeData.workLocation || "—"}
            />
            <DetailItem
              icon={FileSignature}
              label="Template"
              value={`${template?.name || "Unknown"} (v${contract.templateSnapshotVersion})`}
            />
            <DetailItem
              icon={Clock}
              label="Created"
              value={formatDateTime(contract.createdAt)}
            />
            {contract.sentAt && (
              <DetailItem
                icon={Send}
                label="Sent"
                value={formatDateTime(contract.sentAt)}
              />
            )}
            {contract.signedAt && (
              <DetailItem
                icon={CheckCheck}
                label="Signed"
                value={formatDateTime(contract.signedAt)}
              />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 lg:row-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Digital Signing</CardTitle>
              <CardDescription>
                Generate a link for the employee to sign this contract digitally
              </CardDescription>
            </div>
            <SigningStatusBadge status={contract.signingStatus} />
          </CardHeader>
          <CardContent className="space-y-4">
            {contract.signingStatus === "signed" ? (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-4">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCheck className="h-5 w-5 text-green-600" />
                  <span className="font-medium text-green-800 dark:text-green-200">Contract Signed</span>
                </div>
                <p className="text-sm text-green-700 dark:text-green-300">
                  Signed by: {contract.signatureName}
                  {contract.signedAt && ` on ${formatDateTime(contract.signedAt)}`}
                </p>
                {contract.signedPdfPath && (
                  <Button variant="outline" size="sm" className="mt-3" asChild>
                    <a href={`/api/contracts/${contract.id}/download-signed-pdf-auth`} download data-testid="button-download-signed-pdf">
                      <Download className="mr-2 h-4 w-4" />
                      Download Signed PDF
                    </a>
                  </Button>
                )}
              </div>
            ) : contract.signingStatus === "awaiting_signature" ? (
              <div className="space-y-3">
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <PenLine className="h-5 w-5 text-amber-600" />
                    <span className="font-medium text-amber-800 dark:text-amber-200">Awaiting Signature</span>
                  </div>
                  <p className="text-sm text-amber-700 dark:text-amber-300 mb-3">
                    The contract has been sent for signing. Share the link below with the employee.
                  </p>
                  {signingLink ? (
                    <div className="flex gap-2">
                      <Input 
                        value={signingLink} 
                        readOnly 
                        className="font-mono text-xs"
                        data-testid="input-signing-link"
                      />
                      <Button variant="outline" onClick={copyToClipboard} data-testid="button-copy-link">
                        {linkCopied ? <CheckCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  ) : canEdit ? (
                    <Button 
                      onClick={() => generateSigningLinkMutation.mutate()}
                      disabled={generateSigningLinkMutation.isPending}
                      size="sm"
                      data-testid="button-regenerate-link"
                    >
                      {generateSigningLinkMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Link2 className="mr-2 h-4 w-4" />
                      )}
                      Generate New Link
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Generate a secure link that allows the employee to view and sign this contract directly in their browser. 
                  You can share this link via WhatsApp, email, or any messaging app.
                </p>
                {signingLink ? (
                  <div className="space-y-2">
                    <Label>Signing Link</Label>
                    <div className="flex gap-2">
                      <Input 
                        value={signingLink} 
                        readOnly 
                        className="font-mono text-xs"
                        data-testid="input-signing-link"
                      />
                      <Button variant="outline" onClick={copyToClipboard} data-testid="button-copy-link">
                        {linkCopied ? <CheckCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This link expires in 7 days. Copy and share it with the employee.
                    </p>
                  </div>
                ) : canEdit ? (
                  <Button 
                    onClick={() => generateSigningLinkMutation.mutate()}
                    disabled={generateSigningLinkMutation.isPending || contract.status === "draft"}
                    data-testid="button-get-signing-link"
                  >
                    {generateSigningLinkMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Link2 className="mr-2 h-4 w-4" />
                        Get Signing Link
                      </>
                    )}
                  </Button>
                ) : null}
                {contract.status === "draft" && (
                  <p className="text-sm text-amber-600">
                    Please finalize the contract before generating a signing link.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Contract Preview</CardTitle>
              <CardDescription>
                {contract.status === "finalized" || contract.status === "sent"
                  ? "View the finalized contract"
                  : "Preview of the contract (not yet finalized)"}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {contract.status === "draft" && canEdit && (
                <Button
                  onClick={() => finalizeMutation.mutate()}
                  disabled={finalizeMutation.isPending}
                  data-testid="button-finalize-contract"
                >
                  {finalizeMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Finalizing...
                    </>
                  ) : (
                    <>
                      <FileSignature className="mr-2 h-4 w-4" />
                      Finalize
                    </>
                  )}
                </Button>
              )}
              {(contract.status === "finalized" || contract.status === "sent") && contract.pdfPath && (
                <>
                  <Button variant="outline" asChild data-testid="button-download-pdf">
                    <a href={`/api/contracts/${contract.id}/pdf`} download>
                      <Download className="mr-2 h-4 w-4" />
                      Download PDF
                    </a>
                  </Button>
                  {contract.status === "finalized" && canEdit && (
                    <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
                      <DialogTrigger asChild>
                        <Button onClick={openEmailDialog} data-testid="button-send-email">
                          <Send className="mr-2 h-4 w-4" />
                          Send Email
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-[500px]">
                        <DialogHeader>
                          <DialogTitle>Send Contract via Email</DialogTitle>
                          <DialogDescription>
                            Send the finalized contract PDF to the employee
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label htmlFor="email-to">Recipient Email</Label>
                            <Input
                              id="email-to"
                              value={emailTo}
                              onChange={(e) => setEmailTo(e.target.value)}
                              placeholder="employee@company.com"
                              data-testid="input-email-to"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="email-subject">Subject</Label>
                            <Input
                              id="email-subject"
                              value={emailSubject}
                              onChange={(e) => setEmailSubject(e.target.value)}
                              placeholder="Your Employment Contract"
                              data-testid="input-email-subject"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="email-body">Message</Label>
                            <Textarea
                              id="email-body"
                              value={emailBody}
                              onChange={(e) => setEmailBody(e.target.value)}
                              placeholder="Email message..."
                              className="min-h-[150px]"
                              data-testid="input-email-body"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setEmailDialogOpen(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => sendEmailMutation.mutate()}
                            disabled={sendEmailMutation.isPending || !emailTo}
                            data-testid="button-confirm-send"
                          >
                            {sendEmailMutation.isPending ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Sending...
                              </>
                            ) : (
                              <>
                                <Send className="mr-2 h-4 w-4" />
                                Send Email
                              </>
                            )}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md bg-white min-h-[500px]">
              <iframe
                srcDoc={contract.templateSnapshotHtml}
                className="w-full min-h-[500px]"
                title="Contract Preview"
                data-testid="iframe-contract-detail"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {mergeData.customClauses && mergeData.customClauses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Special Terms / Custom Clauses</CardTitle>
            <CardDescription>Additional terms included in this contract</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {mergeData.customClauses.map((clause, index) => (
              <div key={index}>
                <p className="text-sm font-medium mb-1">A.{index + 1} {clause.title}</p>
                <p className="text-sm bg-muted p-3 rounded-md">{clause.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
