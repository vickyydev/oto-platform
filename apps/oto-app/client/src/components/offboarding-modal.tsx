import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Employee, Branch, Template, templateTypeLabels, templateTypeColors, TemplateType, templateTypes, EmployeeAsset, offboardingReasons, offboardingReasonLabels } from "@shared/schema";

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
import { Input } from "@/components/ui/input";
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
import { Loader2, UserX, FileSignature, AlertTriangle, Copy, Check, ExternalLink, Calendar, Clock, Users, Package } from "lucide-react";
import { formatDate } from "@/lib/format-utils";

// The form's words for each reason, now kept in shared/schema.ts so the
// employee's Offboarding panel shows the same ones (S2-17b round 6).
const offboardingReasonCodes = offboardingReasons.map((value) => ({ value, label: offboardingReasonLabels[value] }));

const offboardingSchema = z.object({
  offboardingType: z.enum(["resignation", "termination"]),
  reasonCode: z.string().min(1, "Reason is required"),
  reasonText: z.string().optional(),
  noticeDate: z.string().optional(),
  lastWorkingDay: z.string().min(1, "Last working day is required"),
  leavePublicHolidaysDays: z.number().min(0).optional(),
  leaveAnnualDays: z.number().min(0).optional(),
  leaveOtherDays: z.number().min(0).optional(),
  leaveOtherLabel: z.string().optional(),
  notes: z.string().optional(),
  generateLetter: z.boolean().default(true),
  templateId: z.string().optional(),
});

type OffboardingFormData = z.infer<typeof offboardingSchema>;

interface OffboardingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee;
  onSuccess?: () => void;
}

export function OffboardingModal({ open, onOpenChange, employee, onSuccess }: OffboardingModalProps) {
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

  const { data: assets } = useQuery<EmployeeAsset[]>({
    queryKey: ["/api/employees", employee.id, "assets"],
  });

  const unreturnedAssets = assets?.filter(a => a.returnRequired && !a.returnedAt) || [];

  const form = useForm<OffboardingFormData>({
    resolver: zodResolver(offboardingSchema),
    defaultValues: {
      offboardingType: "resignation",
      reasonCode: "",
      reasonText: "",
      noticeDate: new Date().toISOString().split('T')[0],
      lastWorkingDay: "",
      leavePublicHolidaysDays: 0,
      leaveAnnualDays: 0,
      leaveOtherDays: 0,
      leaveOtherLabel: "",
      notes: "",
      generateLetter: true,
      templateId: "",
    },
  });

  const offboardingType = form.watch("offboardingType");

  const createOffboardingMutation = useMutation({
    mutationFn: async (data: OffboardingFormData) => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/offboarding`, data);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      
      if (form.getValues("generateLetter")) {
        setStep("letter");
      } else {
        setStep("complete");
        toast({
          title: "Offboarding started",
          description: `${employee.fullName} has been marked as ${offboardingType}.`,
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
      const letterType = offboardingType === "resignation" ? "resignation" : "termination";
      const templateId = form.getValues("templateId");
      const res = await apiRequest("POST", `/api/employees/${employee.id}/letters`, {
        letterType,
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
        title: "Letter created",
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

  const onSubmit = (data: OffboardingFormData) => {
    createOffboardingMutation.mutate(data);
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
    // Only show active templates with matching type
    if (t.status !== "active") return false;
    const type = t.templateType || "employment";
    if (offboardingType === "resignation") return type === "resignation";
    if (offboardingType === "termination") return type === "termination";
    return false;
  });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX className="h-5 w-5" />
            {step === "complete" ? "Offboarding Complete" : "Offboard Employee"}
          </DialogTitle>
          <DialogDescription>
            {step === "details" && `Record ${employee.fullName}'s departure from the company.`}
            {step === "letter" && `Generate a ${offboardingType} letter for signing.`}
            {step === "complete" && "The offboarding process has been initiated."}
          </DialogDescription>
        </DialogHeader>

        {step === "details" && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="offboardingType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-offboarding-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="resignation">Resignation</SelectItem>
                        <SelectItem value="termination">Termination</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reasonCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-reason-code">
                          <SelectValue placeholder="Select reason" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {offboardingReasonCodes.map(reason => (
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
                name="reasonText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Additional Details</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Enter any additional details about the departure..."
                        data-testid="input-reason-text"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="noticeDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notice Date</FormLabel>
                      <FormControl>
                        <DatePicker
                          value={field.value || ""}
                          onChange={field.onChange}
                          data-testid="input-notice-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="lastWorkingDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Working Day *</FormLabel>
                      <FormControl>
                        <DatePicker
                          value={field.value || ""}
                          onChange={field.onChange}
                          data-testid="input-last-working-day"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-3 pt-2">
                <p className="text-sm font-medium">Leave Balances (days)</p>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={form.control}
                    name="leavePublicHolidaysDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Public Holidays</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            data-testid="input-leave-public-holidays"
                            {...field}
                            onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="leaveAnnualDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Annual Leave</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            data-testid="input-leave-annual"
                            {...field}
                            onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="leaveOtherDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Other</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            data-testid="input-leave-other"
                            {...field}
                            onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Internal Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Notes for HR reference (not included in letter)..."
                        data-testid="input-notes"
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
                  disabled={createOffboardingMutation.isPending}
                  data-testid="button-submit-offboarding"
                >
                  {createOffboardingMutation.isPending && (
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
                  {offboardingType === "resignation" ? "Resignation" : "Termination"} Letter
                </CardTitle>
                <CardDescription>
                  Generate a letter for the employee to sign electronically.
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
                      <SelectTrigger data-testid="select-letter-template">
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
                          No {offboardingType} letter templates have been created yet.
                          A basic letter will be generated.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-md border p-3 space-y-2">
                  <p className="text-sm font-medium">Employee Details</p>
                  <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                    <div>Name: <span className="text-foreground">{employee.fullName}</span></div>
                    <div>Branch: <span className="text-foreground">{branch?.name || "N/A"}</span></div>
                    <div>Type: <span className="text-foreground capitalize">{offboardingType}</span></div>
                    <div>Last Day: <span className="text-foreground">{formatDate(form.getValues("lastWorkingDay"))}</span></div>
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
                    title: "Offboarding saved",
                    description: "You can generate a letter later from the employee profile.",
                  });
                }}
              >
                Skip Letter
              </Button>
              <Button
                onClick={() => createLetterMutation.mutate()}
                disabled={createLetterMutation.isPending}
                data-testid="button-generate-letter"
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
            <div className="rounded-md bg-muted/50 p-4 text-center space-y-2">
              <Badge variant="default" className="bg-green-600">
                <Check className="h-3 w-3 mr-1" />
                Offboarding Complete
              </Badge>
              <p className="text-sm text-muted-foreground">
                {employee.fullName} has been marked as {offboardingType}.
              </p>
            </div>

            {unreturnedAssets.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Company Property to Return ({unreturnedAssets.length})
                  </CardTitle>
                  <CardDescription>
                    The following items need to be returned by the employee's last working day.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {unreturnedAssets.map(asset => (
                      <div 
                        key={asset.id} 
                        className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50"
                        data-testid={`offboard-asset-${asset.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">{asset.assetNameSnapshot}</span>
                          {asset.serialNumber && (
                            <span className="text-xs text-muted-foreground">(SN: {asset.serialNumber})</span>
                          )}
                        </div>
                        <Badge variant="outline" className="text-amber-600 border-amber-500/50">
                          Pending
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    You can mark items as returned from the employee's profile page.
                  </p>
                </CardContent>
              </Card>
            )}

            {signingLink && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Signing Link</CardTitle>
                  <CardDescription>
                    Share this link with the employee to sign their letter.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={signingLink}
                      className="text-sm"
                      data-testid="input-signing-link"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={handleCopyLink}
                      data-testid="button-copy-link"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => window.open(signingLink, "_blank")}
                      data-testid="button-open-link"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This link allows the employee to view and sign their {offboardingType} letter.
                  </p>
                </CardContent>
              </Card>
            )}

            <DialogFooter>
              <Button onClick={handleClose} data-testid="button-done">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
