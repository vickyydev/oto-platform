import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { PolicyDocument } from "@shared/schema";
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
import { ArrowLeft, Save, Eye, FileEdit, Loader2, FileText, Send } from "lucide-react";
import { Link } from "wouter";
import { RichTextEditor } from "@/components/rich-text-editor";

const policyFormSchema = z.object({
  title: z.string().min(1, "Policy title is required"),
  contentHtml: z.string().min(1, "Policy content is required"),
});

type PolicyFormData = z.infer<typeof policyFormSchema>;

const defaultPolicyContent = `<h1>Rules & Regulations</h1>

<p>This document outlines the company's rules and regulations that all employees must follow.</p>

<h2>1. Working Hours</h2>

<p>Standard working hours are from 9:00 AM to 6:00 PM, Monday through Friday. Employees are expected to be punctual and present during these hours unless otherwise arranged.</p>

<h2>2. Code of Conduct</h2>

<p>All employees are expected to:</p>
<ul>
<li>Maintain professional behavior at all times</li>
<li>Treat colleagues with respect and courtesy</li>
<li>Follow company policies and procedures</li>
<li>Report any violations or concerns to HR</li>
</ul>

<h2>3. Confidentiality</h2>

<p>Employees must maintain confidentiality of all proprietary information, trade secrets, and sensitive company data.</p>

<h2>4. Leave Policy</h2>

<p>Employees are entitled to annual leave, sick leave, and other types of leave as specified in the employee handbook.</p>

<h2>5. Disciplinary Actions</h2>

<p>Violations of these rules may result in disciplinary action, up to and including termination of employment.</p>`;

export default function PolicyEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const isNew = id === "new";

  const { data: policy, isLoading } = useQuery<PolicyDocument>({
    queryKey: ["/api/policies", id],
    enabled: !isNew,
  });

  const form = useForm<PolicyFormData>({
    resolver: zodResolver(policyFormSchema),
    defaultValues: {
      title: "Rules & Regulations",
      contentHtml: defaultPolicyContent,
    },
  });

  useEffect(() => {
    if (policy) {
      form.reset({
        title: policy.title,
        contentHtml: policy.contentHtml || defaultPolicyContent,
      });
    }
  }, [policy, form]);

  const saveMutation = useMutation({
    mutationFn: async (data: PolicyFormData) => {
      if (isNew) {
        const res = await apiRequest("POST", "/api/policies", data);
        return res.json();
      } else {
        const res = await apiRequest("PATCH", `/api/policies/${id}`, data);
        return res.json();
      }
    },
    onSuccess: (savedPolicy: PolicyDocument) => {
      queryClient.invalidateQueries({ queryKey: ["/api/policies"] });
      toast({
        title: isNew ? "Policy created" : "Policy saved",
        description: isNew 
          ? "Your policy document has been created as a draft."
          : "Your changes have been saved.",
      });
      if (isNew) {
        setLocation(`/policies/${savedPolicy.id}`);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error saving policy",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/policies/${id}/publish`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policies"] });
      toast({
        title: "Policy published",
        description: "The policy is now active and will be attached to new contracts.",
      });
      setLocation("/policies");
    },
    onError: (error: Error) => {
      toast({
        title: "Error publishing policy",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: PolicyFormData) => {
    saveMutation.mutate(data);
  };

  const handleSaveAndPublish = async () => {
    const isValid = await form.trigger();
    if (isValid) {
      const data = form.getValues();
      saveMutation.mutate(data, {
        onSuccess: () => {
          publishMutation.mutate();
        },
      });
    }
  };

  if (!isNew && isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[600px]" />
      </div>
    );
  }

  const contentHtml = form.watch("contentHtml");

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link href="/policies">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-medium" data-testid="text-policy-title">
              {isNew ? "New Policy Document" : policy?.title || "Edit Policy"}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              {policy && (
                <>
                  <Badge variant="secondary" className="font-mono">v{policy.versionInt}</Badge>
                  <Badge variant={policy.status === "published" ? "default" : "secondary"}>
                    {policy.status}
                  </Badge>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={mode} onValueChange={(v) => setMode(v as "edit" | "preview")}>
            <TabsList>
              <TabsTrigger value="edit" className="gap-2">
                <FileEdit className="h-4 w-4" />
                Edit
              </TabsTrigger>
              <TabsTrigger value="preview" className="gap-2">
                <Eye className="h-4 w-4" />
                Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Policy Details</CardTitle>
              <CardDescription>
                {mode === "edit" 
                  ? "Edit your policy document content"
                  : "Preview how the policy will appear to employees"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {mode === "edit" && (
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Policy Title</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="Rules & Regulations" 
                          {...field}
                          data-testid="input-policy-title"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {mode === "edit" ? (
                <FormField
                  control={form.control}
                  name="contentHtml"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Content</FormLabel>
                      <FormControl>
                        <RichTextEditor
                          content={field.value}
                          onChange={field.onChange}
                          placeholder="Enter policy content..."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <div className="bg-white rounded-md border p-8" style={{ minHeight: 500 }}>
                  <div 
                    className="prose prose-sm max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{ __html: contentHtml }}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <Link href="/policies">
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Button 
                type="submit"
                variant="outline"
                disabled={saveMutation.isPending}
                data-testid="button-save-draft"
              >
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Save className="mr-2 h-4 w-4" />
                Save Draft
              </Button>
              {!isNew && policy?.status === "draft" && (
                <Button 
                  type="button"
                  onClick={handleSaveAndPublish}
                  disabled={saveMutation.isPending || publishMutation.isPending}
                  data-testid="button-save-publish"
                >
                  {(saveMutation.isPending || publishMutation.isPending) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Send className="mr-2 h-4 w-4" />
                  Save & Publish
                </Button>
              )}
            </div>
          </div>
        </form>
      </Form>
    </div>
  );
}
