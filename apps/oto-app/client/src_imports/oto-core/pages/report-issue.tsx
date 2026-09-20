import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ArrowLeft, Send, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const CATEGORIES = [
  { value: "maintenance", label: "Maintenance" },
  { value: "cleaning", label: "Cleaning" },
  { value: "pos_it", label: "POS/IT" },
  { value: "safety", label: "Safety" },
  { value: "customer_incident", label: "Customer Incident" },
  { value: "inventory", label: "Inventory" },
  { value: "other", label: "Other" },
];

const DEPARTMENTS = [
  { value: "reception", label: "Reception" },
  { value: "barista", label: "Barista" },
  { value: "waiters", label: "Waiters" },
  { value: "nanny_cleaners", label: "Nanny/Cleaners" },
  { value: "kitchen", label: "Kitchen" },
  { value: "maintenance", label: "Maintenance" },
  { value: "general", label: "General" },
];

const URGENCY = [
  { value: "low", label: "Low - Can wait" },
  { value: "medium", label: "Medium - Needs attention today" },
  { value: "high", label: "High - Urgent!" },
];

const issueSchema = z.object({
  department: z.string().min(1, "Please select a department"),
  category: z.string().min(1, "Please select a category"),
  urgency: z.string().min(1, "Please select urgency level"),
  title: z.string().min(3, "Title must be at least 3 characters"),
  description: z.string().optional(),
});

type IssueFormData = z.infer<typeof issueSchema>;

export default function ReportIssuePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();

  const form = useForm<IssueFormData>({
    resolver: zodResolver(issueSchema),
    defaultValues: {
      department: user?.department || "",
      category: "",
      urgency: "medium",
      title: "",
      description: "",
    },
  });

  const createIssueMutation = useMutation({
    mutationFn: async (data: IssueFormData) => {
      const res = await apiRequest("POST", "/api/issues", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      toast({
        title: "Issue reported",
        description: "Your issue has been submitted successfully.",
      });
      setLocation("/today");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to submit issue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: IssueFormData) => {
    createIssueMutation.mutate(data);
  };

  const watchUrgency = form.watch("urgency");

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <Link href="/today">
              <Button size="icon" variant="ghost" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-lg font-semibold">Report Issue</h1>
          </div>
        </div>

        <div className="flex-1 p-4 pb-8 max-w-lg mx-auto w-full">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Issue Title</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="Brief description of the issue"
                        className="h-12"
                        data-testid="input-title"
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-12" data-testid="select-category">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORIES.map((cat) => (
                          <SelectItem key={cat.value} value={cat.value}>
                            {cat.label}
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
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-12" data-testid="select-department">
                          <SelectValue placeholder="Select department" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DEPARTMENTS.map((dept) => (
                          <SelectItem key={dept.value} value={dept.value}>
                            {dept.label}
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
                name="urgency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Urgency</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-12" data-testid="select-urgency">
                          <SelectValue placeholder="Select urgency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {URGENCY.map((urg) => (
                          <SelectItem key={urg.value} value={urg.value}>
                            {urg.label}
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
                    <FormLabel>Additional Details (Optional)</FormLabel>
                    <FormControl>
                      <Textarea 
                        placeholder="Provide more details about the issue..."
                        className="min-h-24"
                        data-testid="textarea-description"
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {watchUrgency === "high" && (
                <Card className="border-destructive/30 bg-destructive/5">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-destructive">High Urgency Selected</p>
                        <p className="text-sm text-muted-foreground">
                          Consider escalating directly if this requires immediate manager attention.
                        </p>
                        <Link href="/escalate">
                          <Button variant="link" className="p-0 h-auto text-destructive" data-testid="link-escalate">
                            Escalate instead
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Button 
                type="submit" 
                className="w-full h-12 text-base font-semibold"
                disabled={createIssueMutation.isPending}
                data-testid="button-submit-issue"
              >
                {createIssueMutation.isPending ? (
                  <LoadingSpinner size="sm" className="text-primary-foreground" />
                ) : (
                  <>
                    <Send className="mr-2 h-5 w-5" />
                    Submit Issue
                  </>
                )}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </AppLayout>
  );
}
