import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Template, Employee, MergeData, mergeDataSchema, TemplateAssignment, templateTypeLabels, templateTypeColors, TemplateType, templateTypes } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const getSafeType = (type: string | null | undefined): TemplateType => {
  return (type && templateTypes.includes(type as TemplateType) ? type : "employment") as TemplateType;
};
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm, useFieldArray, UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ArrowLeft, ArrowRight, Eye, FileSignature, Loader2, Check, Plus, Trash2, ChevronUp, ChevronDown, LinkIcon, AlertTriangle, User } from "lucide-react";
import { Link } from "wouter";

const customClauseSchema = z.object({
  title: z.string(),
  body: z.string(),
});

const contractFormSchema = z.object({
  employeeId: z.string().min(1, "Please select an employee"),
  templateId: z.string().min(1, "Please select a template"),
  language: z.enum(["en", "th"]).default("en"),
  positionTitle: z.string().min(1, "Position title is required"),
  salaryThb: z.coerce.number().min(1, "Salary must be greater than 0"),
  startDate: z.string().min(1, "Start date is required"),
  incentiveClause: z.string().optional(),
  customClauses: z.array(customClauseSchema).optional(),
  employeeFullName: z.string().min(1, "Full name is required"),
  employeeNickname: z.string().optional(),
  employeeEmail: z.string().email("Valid email is required"),
  employeePhone: z.string().optional(),
  employeeAddress: z.string().optional(),
  employeeNationalId: z.string().optional(),
});

type ContractFormData = z.infer<typeof contractFormSchema>;

function CustomClausesField({ form }: { form: UseFormReturn<ContractFormData> }) {
  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "customClauses",
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <FormLabel>Custom Clauses (Special Terms)</FormLabel>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ title: "", body: "" })}
          data-testid="button-add-clause"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Clause
        </Button>
      </div>
      
      {fields.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No custom clauses. Add clauses to include Special Terms in the contract.
        </p>
      )}
      
      {fields.map((field, index) => (
        <div key={field.id} className="space-y-2 p-4 border rounded-md bg-muted/20">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              A.{index + 1}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => index > 0 && move(index, index - 1)}
                disabled={index === 0}
                data-testid={`button-move-up-${index}`}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => index < fields.length - 1 && move(index, index + 1)}
                disabled={index === fields.length - 1}
                data-testid={`button-move-down-${index}`}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(index)}
                data-testid={`button-remove-clause-${index}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
          <FormField
            control={form.control}
            name={`customClauses.${index}.title`}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="Clause title"
                    data-testid={`input-clause-title-${index}`}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name={`customClauses.${index}.body`}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    placeholder="Clause content"
                    className="min-h-[80px]"
                    data-testid={`input-clause-body-${index}`}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      ))}
    </div>
  );
}

export default function ContractWizardPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const [step, setStep] = useState(1);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [preselectedEmployeeId, setPreselectedEmployeeId] = useState<string | null>(null);
  const [employeeVersion, setEmployeeVersion] = useState<number | null>(null);
  const [versionConflict, setVersionConflict] = useState<boolean>(false);
  const [hasEmployeeEdits, setHasEmployeeEdits] = useState(false);

  // Parse URL query params for pre-selected employee
  const urlParams = new URLSearchParams(searchString);
  const urlEmployeeId = urlParams.get("employeeId");

  interface TemplateWithAssignments extends Template {
    assignments: TemplateAssignment[];
  }

  const { data: templatesWithAssignments, isLoading: templatesLoading } = useQuery<TemplateWithAssignments[]>({
    queryKey: ["/api/templates/with-assignments"],
  });

  const { data: employees, isLoading: employeesLoading } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  // Get the pre-selected employee from URL (if any)
  const preselectedEmployee = urlEmployeeId ? employees?.find(e => e.id === urlEmployeeId) : null;
  
  // Use employee's branch when coming from employee page, otherwise use sidebar selection
  const effectiveBranchId = preselectedEmployee?.branchId || selectedBranchId;
  const hasValidBranch = preselectedEmployee?.branchId || !isAllBranches;

  // Filter employees to only show those in the effective branch
  const filteredEmployees = employees?.filter((emp) => {
    if (preselectedEmployee) {
      // When coming from employee page, only show that employee's branch
      return emp.branchId === preselectedEmployee.branchId;
    }
    if (isAllBranches) return true;
    return emp.branchId === selectedBranchId;
  }) || [];

  const form = useForm<ContractFormData>({
    resolver: zodResolver(contractFormSchema),
    defaultValues: {
      employeeId: "",
      templateId: "",
      language: "en" as const,
      positionTitle: "",
      salaryThb: 0,
      startDate: "",
      incentiveClause: "",
      customClauses: [],
      employeeFullName: "",
      employeeNickname: "",
      employeeEmail: "",
      employeePhone: "",
      employeeAddress: "",
      employeeNationalId: "",
    },
  });

  const selectedEmployeeId = form.watch("employeeId");
  const selectedEmployee = filteredEmployees.find((e) => e.id === selectedEmployeeId);

  // Pre-select employee from URL when data is loaded
  useEffect(() => {
    if (urlEmployeeId && employees && !preselectedEmployeeId) {
      const employee = employees.find(e => e.id === urlEmployeeId);
      if (employee) {
        setPreselectedEmployeeId(urlEmployeeId);
        handleEmployeeChange(urlEmployeeId);
      }
    }
  }, [urlEmployeeId, employees, preselectedEmployeeId]);

  const filteredTemplates = templatesWithAssignments?.filter((template) => {
    if (template.status !== "active") return false;
    
    if (!selectedEmployee?.branchId) {
      return true;
    }
    return template.assignments.some(a => a.branchId === selectedEmployee.branchId);
  }) || [];

  const selectedTemplateId = form.watch("templateId");
  const selectedTemplateObj = filteredTemplates.find(t => t.id === selectedTemplateId);

  const handleEmployeeChange = (employeeId: string) => {
    const employee = filteredEmployees.find((e) => e.id === employeeId);
    const defaults = employee?.defaultMergeData as any;
    form.setValue("templateId", "");
    
    form.setValue("employeeId", employeeId);
    form.setValue("positionTitle", defaults?.positionTitle || employee?.positionTitle || "");
    form.setValue("salaryThb", defaults?.salaryThb || employee?.salary || 0);
    form.setValue("startDate", defaults?.startDate || employee?.startDate || "");
    
    form.setValue("employeeFullName", employee?.fullName || "");
    form.setValue("employeeNickname", employee?.nickname || "");
    form.setValue("employeeEmail", employee?.email || "");
    form.setValue("employeePhone", employee?.phone || "");
    form.setValue("employeeAddress", employee?.address || "");
    form.setValue("employeeNationalId", employee?.nationalId || "");
    
    setEmployeeVersion(employee?.version || 1);
    setVersionConflict(false);
    setHasEmployeeEdits(false);
    
    form.setValue("incentiveClause", employee?.incentiveClauseText || "");
    
    let customClauses = defaults?.customClauses || [];
    if (customClauses.length === 0) {
      if (defaults?.extraClause1Title?.trim() || defaults?.extraClause1Body?.trim()) {
        customClauses.push({
          title: defaults.extraClause1Title || "",
          body: defaults.extraClause1Body || "",
        });
      }
      if (defaults?.extraClause2Title?.trim() || defaults?.extraClause2Body?.trim()) {
        customClauses.push({
          title: defaults.extraClause2Title || "",
          body: defaults.extraClause2Body || "",
        });
      }
    }
    customClauses = customClauses.filter((c: { title: string; body: string }) => 
      c.title?.trim() || c.body?.trim()
    );
    form.setValue("customClauses", customClauses);
  };

  const checkEmployeeEdits = () => {
    if (!selectedEmployee) return false;
    const formValues = form.getValues();
    return (
      formValues.employeeFullName !== (selectedEmployee.fullName || "") ||
      formValues.employeeNickname !== (selectedEmployee.nickname || "") ||
      formValues.employeeEmail !== (selectedEmployee.email || "") ||
      formValues.employeePhone !== (selectedEmployee.phone || "") ||
      formValues.employeeAddress !== (selectedEmployee.address || "") ||
      formValues.employeeNationalId !== (selectedEmployee.nationalId || "")
    );
  };

  const previewMutation = useMutation({
    mutationFn: async (data: ContractFormData) => {
      const res = await apiRequest("POST", "/api/contracts/preview", data);
      return await res.json();
    },
    onSuccess: (data: { html: string }) => {
      setPreviewHtml(data.html);
      setStep(4);
    },
    onError: (error: Error) => {
      toast({
        title: "Preview failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ContractFormData) => {
      const mergeData: MergeData = {
        positionTitle: data.positionTitle,
        salaryThb: data.salaryThb,
        startDate: data.startDate,
        // workLocation is derived from branch on server
        incentiveClause: data.incentiveClause,
        customClauses: data.customClauses,
      };

      const res = await apiRequest("POST", "/api/contracts", {
        employeeId: data.employeeId,
        templateId: data.templateId,
        language: data.language,
        mergeDataJson: mergeData,
        createdBy: user?.id,
        status: "draft",
      });
      return await res.json();
    },
    onSuccess: (contract) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      toast({
        title: "Contract created",
        description: "The contract has been created as a draft.",
      });
      setLocation(`/contracts/${contract.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async ({ data, generateSigningLink }: { data: ContractFormData; generateSigningLink?: boolean }) => {
      const mergeData: MergeData = {
        positionTitle: data.positionTitle,
        salaryThb: data.salaryThb,
        startDate: data.startDate,
        incentiveClause: data.incentiveClause,
        customClauses: data.customClauses,
      };

      const employeeUpdates = checkEmployeeEdits() ? {
        fullName: data.employeeFullName,
        nickname: data.employeeNickname || null,
        email: data.employeeEmail,
        phone: data.employeePhone || null,
        address: data.employeeAddress || null,
        nationalId: data.employeeNationalId || null,
      } : undefined;

      const res = await apiRequest("POST", "/api/contracts/generate", {
        employeeId: data.employeeId,
        templateId: data.templateId,
        language: data.language,
        mergeDataJson: mergeData,
        employeeUpdates,
        expectedVersion: employeeVersion,
        createdBy: user?.id,
        generateSigningLink,
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        if (errorData.error === "VERSION_CONFLICT") {
          setVersionConflict(true);
          throw new Error("This employee was modified by another user. Please refresh and try again.");
        }
        throw new Error(errorData.message || "Failed to generate contract");
      }
      
      return await res.json();
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      
      const messages: string[] = [];
      if (result.employeeUpdated) {
        messages.push(`Employee profile updated (${result.changedFields.join(", ")})`);
      }
      if (variables.generateSigningLink) {
        messages.push("Signing link created");
      }
      messages.push("Contract PDF generated");
      
      toast({
        title: "Contract finalized",
        description: messages.join(". "),
      });
      setLocation(`/contracts/${result.contract.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePreview = () => {
    const data = form.getValues();
    previewMutation.mutate(data);
  };

  const isFinalizingRef = useRef(false);
  const handleFinalize = (generateSigningLink = false) => {
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;
    const data = form.getValues();
    finalizeMutation.mutate({ data, generateSigningLink }, {
      onSettled: () => { isFinalizingRef.current = false; }
    });
  };

  const handleSaveDraft = () => {
    const data = form.getValues();
    createMutation.mutate(data);
  };

  const isLoading = templatesLoading || employeesLoading;
  const isPending = previewMutation.isPending || createMutation.isPending || finalizeMutation.isPending;

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (!hasValidBranch) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/contracts">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-3xl font-medium" data-testid="text-wizard-title">Generate Contract</h1>
            <p className="text-muted-foreground">
              Create a new contract for an employee
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="py-16 text-center">
            <FileSignature className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-medium mb-2">Select a Branch First</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
              To generate a contract, please select a specific branch from the sidebar. Contracts are created for employees within a branch.
            </p>
            <Link href="/contracts">
              <Button variant="outline" data-testid="button-back-to-contracts">
                Back to Contracts
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/contracts">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-medium" data-testid="text-wizard-title">Generate Contract</h1>
          <p className="text-muted-foreground">
            Create a new contract for an employee
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
        {[
          { num: 1, label: "Select" },
          { num: 2, label: "Employee" },
          { num: 3, label: "Contract" },
          { num: 4, label: "Finalize" },
        ].map((s, idx, arr) => (
          <div key={s.num} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 ${
                  step >= s.num
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted text-muted-foreground"
                }`}
              >
                {step > s.num ? <Check className="h-5 w-5" /> : s.num}
              </div>
              <span className="text-xs text-muted-foreground hidden sm:block">{s.label}</span>
            </div>
            {idx < arr.length - 1 && (
              <div
                className={`w-12 sm:w-16 h-0.5 mt-[-16px] sm:mt-[-20px] ${
                  step > s.num ? "bg-primary" : "bg-muted"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      <Form {...form}>
        <form className="space-y-6">
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Step 1: Select Employee & Template</CardTitle>
                <CardDescription>
                  Choose the employee and contract template to use
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="employeeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Employee *</FormLabel>
                      <Select onValueChange={handleEmployeeChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-employee">
                            <SelectValue placeholder="Select an employee" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filteredEmployees.length === 0 ? (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                              No employees in this branch
                            </div>
                          ) : (
                            filteredEmployees.map((employee) => (
                              <SelectItem key={employee.id} value={employee.id}>
                                {employee.fullName} ({employee.email})
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Default contract values will be pre-filled if available
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="templateId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contract Template *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value} disabled={filteredTemplates.length === 0}>
                        <FormControl>
                          <SelectTrigger data-testid="select-template">
                            <SelectValue placeholder={filteredTemplates.length === 0 ? "No templates available" : "Select a template"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filteredTemplates.map((template) => {
                            const safeType = getSafeType(template.templateType);
                            return (
                              <SelectItem key={template.id} value={template.id}>
                                <div className="flex items-center gap-2">
                                  <Badge className={`${templateTypeColors[safeType]} text-xs`}>
                                    {templateTypeLabels[safeType]}
                                  </Badge>
                                  <span>{template.name}</span>
                                  <span className="text-muted-foreground">(v{template.version})</span>
                                </div>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {selectedEmployee?.branchId && filteredTemplates.length === 0 && (
                        <FormDescription className="text-amber-600 dark:text-amber-500">
                          No templates are assigned to this employee's branch
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end pt-4">
                  <Button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={!form.watch("employeeId") || !form.watch("templateId")}
                    data-testid="button-next-step1"
                  >
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Step 2: Review Employee Details
                </CardTitle>
                <CardDescription>
                  Review and optionally update employee information for {selectedEmployee?.fullName}. 
                  Changes here will be saved to the employee profile.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {versionConflict && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Conflict Detected</AlertTitle>
                    <AlertDescription>
                      This employee was modified by another user. Please go back and reselect the employee to load the latest data.
                    </AlertDescription>
                  </Alert>
                )}
                
                {checkEmployeeEdits() && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Pending Changes</AlertTitle>
                    <AlertDescription>
                      You have modified employee details. These changes will be saved to the employee profile when you finalize the contract.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="employeeFullName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Name *</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Full legal name"
                            data-testid="input-employee-fullname"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="employeeNickname"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nickname</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Preferred name"
                            data-testid="input-employee-nickname"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="employeeEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email *</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="email@example.com"
                            data-testid="input-employee-email"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="employeePhone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="+66 812 345 678"
                            data-testid="input-employee-phone"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="employeeNationalId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>National ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="ID number"
                            data-testid="input-employee-nationalid"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="md:col-span-2">
                    <FormField
                      control={form.control}
                      name="employeeAddress"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Address</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Full address"
                              className="min-h-[80px]"
                              data-testid="input-employee-address"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                <div className="flex justify-between pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep(1)}
                    data-testid="button-back-step2"
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(3)}
                    data-testid="button-next-step2"
                  >
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Step 3: Contract Details</CardTitle>
                <CardDescription>
                  Fill in the contract information for {selectedEmployee?.fullName}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="positionTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Position Title *</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="e.g., Software Engineer"
                            data-testid="input-position"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="salaryThb"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{selectedEmployee?.employmentBasis === "PART_TIME" ? "Daily Rate (THB)" : "Salary (THB)"} *</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">฿</span>
                            <CurrencyInput
                              placeholder={selectedEmployee?.employmentBasis === "PART_TIME" ? "500" : "50,000"}
                              className="pl-8"
                              data-testid="input-salary"
                              value={field.value}
                              onChange={field.onChange}
                            />
                          </div>
                        </FormControl>
                        {selectedEmployee?.employmentBasis === "PART_TIME" && (
                          <p className="text-xs text-muted-foreground">Amount paid per day worked.</p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="startDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Start Date *</FormLabel>
                        <FormControl>
                          <DatePicker
                            value={field.value || ""}
                            onChange={field.onChange}
                            data-testid="input-start-date"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Work Location is now derived from employee's branch */}
                  {selectedEmployee?.branchId && (
                    <div className="space-y-2">
                      <FormLabel>Work Location</FormLabel>
                      <p className="text-sm text-muted-foreground">
                        Derived from employee's branch assignment
                      </p>
                    </div>
                  )}
                </div>

                <FormField
                  control={form.control}
                  name="incentiveClause"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Incentive / Commission Clause (Optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g., Monthly commission of 2% on sales exceeding THB 100,000"
                          className="min-h-[80px]"
                          data-testid="input-incentive-clause"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Will appear under salary in the contract. Pre-filled from employee profile.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <CustomClausesField form={form} />

                <div className="flex justify-between pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep(2)}
                    data-testid="button-back-step3"
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={handlePreview}
                    disabled={previewMutation.isPending}
                    data-testid="button-preview"
                  >
                    {previewMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Eye className="mr-2 h-4 w-4" />
                        Preview Contract
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 4 && previewHtml && (
            <Card>
              <CardHeader>
                <CardTitle>Step 4: Preview & Finalize</CardTitle>
                <CardDescription>
                  Review the contract before finalizing
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="border rounded-md bg-gray-100 dark:bg-gray-900 p-4 overflow-auto">
                  <div className="bg-white shadow-lg mx-auto" style={{ maxWidth: '210mm', minHeight: '297mm' }}>
                    <iframe
                      srcDoc={previewHtml}
                      className="w-full"
                      style={{ minHeight: '800px' }}
                      title="Contract Preview"
                      data-testid="iframe-contract-preview"
                    />
                  </div>
                </div>

                <div className="flex justify-between pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep(3)}
                    data-testid="button-back-step4"
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Edit Contract Details
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSaveDraft}
                      disabled={isPending}
                      data-testid="button-save-draft"
                    >
                      {createMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Save as Draft
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleFinalize(false)}
                      disabled={isPending}
                      data-testid="button-finalize"
                    >
                      {finalizeMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Generating PDF...
                        </>
                      ) : (
                        <>
                          <FileSignature className="mr-2 h-4 w-4" />
                          Finalize
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => handleFinalize(true)}
                      disabled={isPending}
                      data-testid="button-finalize-signing"
                    >
                      {finalizeMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <LinkIcon className="mr-2 h-4 w-4" />
                          Finalize + Signing Link
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </form>
      </Form>
    </div>
  );
}
