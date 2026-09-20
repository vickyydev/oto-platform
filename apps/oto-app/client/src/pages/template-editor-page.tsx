import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Template, templateTypes, templateTypeLabels, templateTypeColors, TemplateType } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ArrowLeft, Save, Eye, FileEdit, Loader2, FileText, AlignLeft, AlignCenter, AlignRight, Briefcase, TrendingUp, AlertTriangle, UserMinus, UserX } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Link } from "wouter";
import { RichTextEditor } from "@/components/rich-text-editor";

const templateFormSchema = z.object({
  name: z.string().min(1, "Template name is required"),
  templateType: z.enum(["employment", "promotion", "warning", "resignation", "termination"]),
  htmlBody: z.string().min(1, "Template body is required"),
  htmlBodyTh: z.string().optional(),
  headerShowLogo: z.boolean().optional(),
  headerShowAddress: z.boolean().optional(),
  headerAlignment: z.enum(["left", "center", "right"]).optional(),
});

const templateTypeIcons: Record<TemplateType, typeof Briefcase> = {
  employment: Briefcase,
  promotion: TrendingUp,
  warning: AlertTriangle,
  resignation: UserMinus,
  termination: UserX,
};

const templateTypeDescriptions: Record<TemplateType, string> = {
  employment: "For new hires joining the company",
  promotion: "For employee promotions and role changes",
  warning: "For disciplinary and warning notices",
  resignation: "For employees leaving voluntarily",
  termination: "For company-initiated departures",
};

type TemplateFormData = z.infer<typeof templateFormSchema>;

const defaultTemplate = `<h1>Employment Contract</h1>

<p>This Employment Contract is entered into between <strong>the Company</strong> and:</p>

<p><strong>Employee:</strong> {{employee.full_name}}<br/>
<strong>Email:</strong> {{employee.email}}</p>

<h2>Position Details</h2>

<p><strong>Position:</strong> {{contract.position_title}}<br/>
<strong>Salary:</strong> {{contract.salary_thb}} THB per month<br/>
<strong>Start Date:</strong> {{contract.start_date}}<br/>
<strong>Work Location:</strong> {{contract.work_location}}</p>

<h2>Terms and Conditions</h2>

<ol>
<li>The Employee agrees to perform the duties and responsibilities of the position.</li>
<li>The Employee shall comply with all company policies and procedures.</li>
<li>This contract is subject to a probationary period as specified by company policy.</li>
</ol>

<h2>Signatures</h2>

<p>_________________________<br/>
Employee Signature</p>

<p>_________________________<br/>
Employer Signature</p>`;

const sampleData = {
  employee: {
    full_name: "John Smith",
    email: "john.smith@example.com",
    phone: "+66 81 234 5678",
    address: "123 Sample Street, Bangkok 10110",
  },
  contract: {
    position_title: "Software Engineer",
    salary_thb: "75,000",
    start_date: "January 15, 2026",
    work_location: "Bangkok Office",
    incentive_title: "Performance Bonus",
    incentive_body: "Up to 2 months salary based on annual review",
    extra_clause_1_title: "Non-Compete",
    extra_clause_1_body: "Employee agrees not to work for competing companies for 12 months after termination.",
    extra_clause_2_title: "Confidentiality",
    extra_clause_2_body: "Employee agrees to maintain confidentiality of all proprietary information.",
  },
  branch: {
    name: "OTO Company Ltd.",
    address: "456 Business Tower, Sukhumvit Road, Bangkok 10110, Thailand",
    logo_url: "",
  },
  document: {
    todays_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
  },
};

interface HeaderConfig {
  showLogo: boolean;
  showAddress: boolean;
  alignment: "left" | "center" | "right";
}

function renderPreviewHtml(htmlBody: string, headerConfig: HeaderConfig, branch: typeof sampleData.branch): string {
  let content = htmlBody;
  
  Object.entries(sampleData.employee).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{employee\\.${key}\\}\\}`, 'g');
    content = content.replace(regex, value);
  });
  
  Object.entries(sampleData.contract).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{contract\\.${key}\\}\\}`, 'g');
    content = content.replace(regex, value);
  });
  
  Object.entries(branch).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{branch\\.${key}\\}\\}`, 'g');
    content = content.replace(regex, value);
  });
  
  Object.entries(sampleData.document).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{document\\.${key}\\}\\}`, 'g');
    content = content.replace(regex, value);
  });

  const showHeader = headerConfig.showLogo || headerConfig.showAddress;
  
  let headerHtml = '';
  if (showHeader) {
    const justifyStyle = headerConfig.alignment === "left" 
      ? "flex-start" 
      : headerConfig.alignment === "center" 
        ? "center" 
        : "flex-end";
    
    const textAlign = headerConfig.alignment;
    
    headerHtml = `
    <div style="display: flex; align-items: flex-start; justify-content: ${justifyStyle}; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #1a365d; gap: 20px;">
      ${headerConfig.showLogo ? `
      <div style="flex: 0 0 auto;">
        ${branch.logo_url ? `<img src="${branch.logo_url}" alt="Company Logo" style="max-height: 60px; max-width: 150px;" />` : `<div style="width: 80px; height: 60px; background: #e2e8f0; display: flex; align-items: center; justify-content: center; border-radius: 4px; color: #64748b; font-size: 10px;">Logo</div>`}
      </div>
      ` : ''}
      ${headerConfig.showAddress ? `
      <div style="text-align: ${textAlign}; ${headerConfig.showLogo ? 'flex: 1;' : ''}">
        <div style="font-weight: 700; font-size: 16px; color: #1a365d;">${branch.name}</div>
        <div style="font-size: 12px; color: #64748b; margin-top: 4px;">${branch.address}</div>
      </div>
      ` : ''}
    </div>
  `;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    @page {
      size: A4;
      margin: 20mm;
    }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a202c;
      max-width: 210mm;
      margin: 0 auto;
      padding: 40px;
      background: white;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #1a365d;
      margin-bottom: 16px;
      margin-top: 24px;
      page-break-after: avoid;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 12px;
      margin-top: 20px;
      page-break-after: avoid;
    }
    h3 {
      font-size: 16px;
      font-weight: 600;
      color: #4a5568;
      margin-bottom: 8px;
      margin-top: 16px;
      page-break-after: avoid;
    }
    p {
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    ul, ol {
      margin-left: 24px;
      margin-bottom: 12px;
    }
    li {
      margin-bottom: 6px;
    }
    strong {
      font-weight: 600;
    }
    a {
      color: #3182ce;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  ${headerHtml}
  ${content}
</body>
</html>`;
}

export default function TemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { selectedBranch } = useBranchContext();
  const { toast } = useToast();
  const isNew = id === "new";
  const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");

  const { data: template, isLoading } = useQuery<Template>({
    queryKey: ["/api/templates", id],
    enabled: !isNew,
  });

  const form = useForm<TemplateFormData>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: {
      name: "",
      templateType: "employment",
      htmlBody: defaultTemplate,
      htmlBodyTh: "",
      headerShowLogo: true,
      headerShowAddress: true,
      headerAlignment: "right",
    },
  });

  useEffect(() => {
    if (template) {
      form.reset({
        name: template.name,
        templateType: (template.templateType as TemplateType) || "employment",
        htmlBody: template.htmlBody,
        htmlBodyTh: template.htmlBodyTh || "",
        headerShowLogo: template.headerShowLogo ?? true,
        headerShowAddress: template.headerShowAddress ?? true,
        headerAlignment: (template.headerAlignment as "left" | "center" | "right") ?? "right",
      });
    }
  }, [template, form]);

  const createMutation = useMutation({
    mutationFn: async (data: TemplateFormData) => {
      const res = await apiRequest("POST", "/api/templates", {
        name: data.name,
        templateType: data.templateType,
        htmlBody: data.htmlBody,
        htmlBodyTh: data.htmlBodyTh || null,
        headerShowLogo: data.headerShowLogo,
        headerShowAddress: data.headerShowAddress,
        headerAlignment: data.headerAlignment,
        updatedBy: user?.id,
      });
      return await res.json();
    },
    onSuccess: (newTemplate: Template) => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
      toast({
        title: "Template created",
        description: `Template "${newTemplate.name}" has been created successfully.`,
      });
      setLocation("/templates");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: TemplateFormData) => {
      const res = await apiRequest("PATCH", `/api/templates/${id}`, {
        name: data.name,
        templateType: data.templateType,
        htmlBody: data.htmlBody,
        htmlBodyTh: data.htmlBodyTh || null,
        headerShowLogo: data.headerShowLogo,
        headerShowAddress: data.headerShowAddress,
        headerAlignment: data.headerAlignment,
        updatedBy: user?.id,
      });
      return await res.json();
    },
    onSuccess: (updatedTemplate: Template) => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/templates", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
      toast({
        title: "Template updated",
        description: `Template is now at version ${updatedTemplate.version}.`,
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

  const onSubmit = (data: TemplateFormData) => {
    if (isNew) {
      createMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const htmlBody = form.watch("htmlBody");

  const previewBranch = selectedBranch ? {
    name: selectedBranch.name,
    address: selectedBranch.address || sampleData.branch.address,
    logo_url: (selectedBranch as any).logoUrl || "",
  } : sampleData.branch;

  if (!isNew && isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/templates">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-medium" data-testid="text-editor-title">
            {isNew ? "New Template" : "Edit Template"}
          </h1>
          <p className="text-muted-foreground">
            {isNew ? "Create a new contract template" : `Editing template • Currently at version ${template?.version}`}
          </p>
        </div>
        {!isNew && (
          <Badge variant="secondary" className="font-mono text-sm">
            v{template?.version}
          </Badge>
        )}
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template Details</CardTitle>
              <CardDescription>
                Give your template a descriptive name
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Template Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., Standard Employment Contract"
                        data-testid="input-template-name"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="templateType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document Type</FormLabel>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {templateTypes.map((type) => {
                        const Icon = templateTypeIcons[type];
                        const isSelected = field.value === type;
                        return (
                          <div
                            key={type}
                            onClick={() => field.onChange(type)}
                            className={`cursor-pointer rounded-md border-2 p-3 transition-all hover-elevate ${
                              isSelected 
                                ? "border-primary bg-primary/5" 
                                : "border-muted"
                            }`}
                            data-testid={`type-${type}`}
                          >
                            <div className="flex flex-col items-center gap-2 text-center">
                              <div className={`rounded-full p-2 ${templateTypeColors[type]}`}>
                                <Icon className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">{templateTypeLabels[type]}</p>
                                <p className="text-xs text-muted-foreground">
                                  {templateTypeDescriptions[type]}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="border rounded-md p-4 space-y-4">
                <h4 className="text-sm font-medium">Document Header Configuration</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="headerShowLogo"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-3 space-y-0">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="switch-show-logo"
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-normal">Show branch logo</FormLabel>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="headerShowAddress"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-3 space-y-0">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="switch-show-address"
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-normal">Show branch address</FormLabel>
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="headerAlignment"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm">Header Alignment</FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value}
                          onValueChange={field.onChange}
                          className="flex gap-2"
                          data-testid="radio-header-alignment"
                        >
                          <div className="flex items-center gap-1">
                            <RadioGroupItem value="left" id="align-left" />
                            <Label htmlFor="align-left" className="flex items-center gap-1 cursor-pointer">
                              <AlignLeft className="h-4 w-4" />
                              Left
                            </Label>
                          </div>
                          <div className="flex items-center gap-1">
                            <RadioGroupItem value="center" id="align-center" />
                            <Label htmlFor="align-center" className="flex items-center gap-1 cursor-pointer">
                              <AlignCenter className="h-4 w-4" />
                              Center
                            </Label>
                          </div>
                          <div className="flex items-center gap-1">
                            <RadioGroupItem value="right" id="align-right" />
                            <Label htmlFor="align-right" className="flex items-center gap-1 cursor-pointer">
                              <AlignRight className="h-4 w-4" />
                              Right
                            </Label>
                          </div>
                        </RadioGroup>
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <CardTitle>Template Body</CardTitle>
                  <CardDescription>
                    Design your contract using the rich text editor. Insert variables using the toolbar.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "edit" | "preview")}>
                    <TabsList>
                      <TabsTrigger value="edit" data-testid="tab-edit">
                        <FileEdit className="h-4 w-4 mr-2" />
                        Edit
                      </TabsTrigger>
                      <TabsTrigger value="preview" data-testid="tab-preview">
                        <Eye className="h-4 w-4 mr-2" />
                        Preview
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {activeTab === "edit" ? (
                  <FormField
                    control={form.control}
                    name="htmlBody"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <RichTextEditor
                            content={field.value}
                            onChange={field.onChange}
                            placeholder="Start writing your contract template..."
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4" />
                    <span>Preview with sample data • A4 format</span>
                  </div>
                  <div className="border rounded-md bg-gray-100 dark:bg-gray-900 p-4">
                    <div className="bg-white shadow-lg mx-auto" style={{ maxWidth: '210mm', minHeight: '297mm' }}>
                      <iframe
                        srcDoc={renderPreviewHtml(htmlBody, {
                          showLogo: form.watch("headerShowLogo") ?? true,
                          showAddress: form.watch("headerShowAddress") ?? true,
                          alignment: form.watch("headerAlignment") ?? "right",
                        }, previewBranch)}
                        className="w-full"
                        style={{ minHeight: '800px' }}
                        title="Template Preview"
                        data-testid="iframe-preview"
                      />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-4">
            <Link href="/templates">
              <Button variant="outline" type="button" data-testid="button-cancel">
                Cancel
              </Button>
            </Link>
            <Button type="submit" disabled={isPending} data-testid="button-save">
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {isNew ? "Create Template" : "Save Changes"}
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
