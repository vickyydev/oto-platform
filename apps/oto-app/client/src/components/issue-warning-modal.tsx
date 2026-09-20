import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Employee, Branch, Template, templateTypeLabels, templateTypeColors, TemplateType, templateTypes } from "@shared/schema";

const getSafeType = (type: string | null | undefined): TemplateType => {
  return (type && templateTypes.includes(type as TemplateType) ? type : "employment") as TemplateType;
};
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Loader2, AlertTriangle, FileSignature, Copy, Check, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/format-utils";

const warningReasonCodes = [
  { value: "performance", label: "Performance issues" },
  { value: "attendance", label: "Attendance/Punctuality" },
  { value: "conduct", label: "Conduct/Behavior" },
  { value: "policy_violation", label: "Policy violation" },
  { value: "safety_violation", label: "Safety violation" },
  { value: "insubordination", label: "Insubordination" },
  { value: "quality_issues", label: "Quality issues" },
  { value: "other", label: "Other" },
] as const;

const warningSeverityLevels = [
  { value: "verbal", label: "Verbal Warning" },
  { value: "written", label: "Written Warning" },
  { value: "final", label: "Final Warning" },
] as const;

const warningSchema = z.object({
  reasonCode: z.string().min(1, "Reason is required"),
  severity: z.string().min(1, "Severity level is required"),
  incidentDate: z.string().min(1, "Incident date is required"),
  description: z.string().min(10, "Please provide a detailed description"),
  expectedImprovement: z.string().optional(),
  notes: z.string().optional(),
  generateLetter: z.boolean().default(true),
  templateId: z.string().optional(),
});

type WarningFormData = z.infer<typeof warningSchema>;

interface IssueWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee;
  onSuccess?: () => void;
}

export function IssueWarningModal({ open, onOpenChange, employee, onSuccess }: IssueWarningModalProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<"details" | "letter" | "complete">("details");
  const [signingLink, setSigningLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: branch } = useQuery<Branch>({
    queryKey: ["/api/branches", employee.branchId],
    enabled: !!employee.branchId,
  });

  const { data: templates } = useQuery<Template[]>({
    queryKey: ["/api/templates"],
  });

  const form = useForm<WarningFormData>({
    resolver: zodResolver(warningSchema),
    defaultValues: {
      reasonCode: "",
      severity: "written",
      incidentDate: new Date().toISOString().split('T')[0],
      description: "",
      expectedImprovement: "",
      notes: "",
      generateLetter: true,
      templateId: "",
    },
  });

  const createWarningMutation = useMutation({
    mutationFn: async (data: WarningFormData) => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/warnings`, data);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "letters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      
      if (form.getValues("generateLetter")) {
        setStep("letter");
      } else {
        setStep("complete");
        toast({
          title: "Warning recorded",
          description: `Warning has been recorded for ${employee.fullName}.`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createLetterMutation = useMutation({
    mutationFn: async () => {
      const templateId = form.getValues("templateId");
      const res = await apiRequest("POST", `/api/employees/${employee.id}/letters`, {
        letterType: "warning",
        templateId: templateId || undefined,
      });
      return await res.json();
    },
    onSuccess: (letter) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "letters"] });
      const link = `${window.location.origin}/letter-sign/${letter.signingToken}`;
      setSigningLink(link);
      setStep("complete");
      toast({
        title: "Warning letter created",
        description: "Signing link has been generated.",
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

  const onSubmit = (data: WarningFormData) => {
    createWarningMutation.mutate(data);
  };

  const handleCopyLink = () => {
    if (signingLink) {
      navigator.clipboard.writeText(signingLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: "Link copied",
        description: "Signing link has been copied to clipboard.",
      });
    }
  };

  const handleClose = () => {
    form.reset();
    setStep("details");
    setSigningLink(null);
    setCopied(false);
    onOpenChange(false);
    if (step === "complete") {
      onSuccess?.();
    }
  };

  const filteredTemplates = templates?.filter(t => {
    if (t.status !== "active") return false;
    const type = t.templateType || "employment";
    return type === "warning";
  });

  const severity = form.watch("severity");
  const severityLabel = warningSeverityLevels.find(s => s.value === severity)?.label || "Warning";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {step === "complete" ? "Warning Issued" : "Issue Warning"}
          </DialogTitle>
          <DialogDescription>
            {step === "details" && `Record a warning for ${employee.fullName}.`}
            {step === "letter" && `Generate a warning letter for the employee to acknowledge.`}
            {step === "complete" && "The warning has been recorded."}
          </DialogDescription>
        </DialogHeader>

        {step === "details" && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="severity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Severity Level *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-warning-severity">
                            <SelectValue placeholder="Select level" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {warningSeverityLevels.map(level => (
                            <SelectItem key={level.value} value={level.value}>
                              {level.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="incidentDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Incident Date *</FormLabel>
                      <FormControl>
                        <DatePicker
                          value={field.value || ""}
                          onChange={field.onChange}
                          data-testid="input-incident-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="reasonCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-warning-reason">
                          <SelectValue placeholder="Select reason" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {warningReasonCodes.map(reason => (
                          <SelectItem key={reason.value} value={reason.value}>
                            {reason.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description *</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Describe the incident or behavior that led to this warning..."
                        data-testid="input-warning-description"
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="expectedImprovement"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected Improvement</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="What improvements or changes are expected from the employee..."
                        data-testid="input-expected-improvement"
                        rows={2}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Internal Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Notes for HR reference (not included in letter)..."
                        data-testid="input-warning-notes"
                        rows={2}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>These notes are for internal reference only.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createWarningMutation.isPending}
                  data-testid="button-submit-warning"
                >
                  {createWarningMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Continue
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}

        {step === "letter" && (
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileSignature className="h-4 w-4" />
                  {severityLabel}
                </CardTitle>
                <CardDescription>
                  Generate a warning letter for the employee to acknowledge and sign.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {filteredTemplates && filteredTemplates.length > 0 ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Select Template</label>
                    <Select
                      value={form.watch("templateId") || ""}
                      onValueChange={(value) => form.setValue("templateId", value)}
                    >
                      <SelectTrigger data-testid="select-warning-template">
                        <SelectValue placeholder="Choose a template" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredTemplates.map(template => {
                          const safeType = getSafeType(template.templateType);
                          return (
                            <SelectItem key={template.id} value={template.id}>
                              <div className="flex items-center gap-2">
                                <Badge className={`${templateTypeColors[safeType]} text-xs`}>
                                  {templateTypeLabels[safeType]}
                                </Badge>
                                <span>{template.name}</span>
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="rounded-md bg-muted p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
                      <div>
                        <p className="font-medium">No templates available</p>
                        <p className="text-muted-foreground mt-1">
                          No warning letter templates have been created yet.
                          A basic warning letter will be generated.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-md border p-3 space-y-2">
                  <p className="text-sm font-medium">Warning Details</p>
                  <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                    <div>Employee: <span className="text-foreground">{employee.fullName}</span></div>
                    <div>Branch: <span className="text-foreground">{branch?.name || "N/A"}</span></div>
                    <div>Severity: <span className="text-foreground">{severityLabel}</span></div>
                    <div>Date: <span className="text-foreground">{formatDate(form.getValues("incidentDate"))}</span></div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("details")}>
                Back
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep("complete");
                  toast({
                    title: "Warning recorded",
                    description: "You can generate a letter later from the employee profile.",
                  });
                }}
              >
                Skip Letter
              </Button>
              <Button
                onClick={() => createLetterMutation.mutate()}
                disabled={createLetterMutation.isPending}
                data-testid="button-generate-warning-letter"
              >
                {createLetterMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Generate Letter
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "complete" && (
          <div className="space-y-4">
            <div className="rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-4 text-center">
              <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-amber-500" />
              <p className="font-medium text-lg">Warning Recorded</p>
              <p className="text-sm text-muted-foreground mt-1">
                The warning has been added to {employee.fullName}'s record.
              </p>
            </div>

            {signingLink && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Signing Link</CardTitle>
                  <CardDescription>
                    Share this link with {employee.fullName} to acknowledge the warning.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={signingLink}
                      readOnly
                      className="font-mono text-xs"
                      data-testid="input-signing-link"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleCopyLink}
                      data-testid="button-copy-signing-link"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => window.open(signingLink, "_blank")}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Signing Page
                  </Button>
                </CardContent>
              </Card>
            )}

            <DialogFooter>
              <Button onClick={handleClose} data-testid="button-close-warning-modal">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
