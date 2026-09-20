import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ArrowLeft, Phone, MessageCircle, Copy, CheckCircle, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { LoadingSpinner, LoadingScreen } from "@/components/ui/loading-spinner";
import type { Branch } from "@shared/schema";

const escalationSchema = z.object({
  reason: z.string().min(10, "Please describe the reason for escalation (at least 10 characters)"),
});

type EscalationFormData = z.infer<typeof escalationSchema>;

export default function EscalatePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [showContact, setShowContact] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const { data: branch, isLoading: branchLoading } = useQuery<Branch>({
    queryKey: ["/api/branches", user?.branchId],
    enabled: !!user?.branchId,
  });

  const form = useForm<EscalationFormData>({
    resolver: zodResolver(escalationSchema),
    defaultValues: {
      reason: "",
    },
  });

  const createEscalationMutation = useMutation({
    mutationFn: async (data: EscalationFormData) => {
      const res = await apiRequest("POST", "/api/escalations", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/escalations"] });
      setShowContact(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create escalation",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: EscalationFormData) => {
    createEscalationMutation.mutate(data);
  };

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(null), 2000);
  };

  if (branchLoading) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

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
            <div>
              <h1 className="text-lg font-semibold text-destructive">Escalate to Manager</h1>
              <p className="text-sm text-muted-foreground">{branch?.name}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 pb-8 max-w-lg mx-auto w-full">
          {!showContact ? (
            <div className="space-y-6">
              <Card className="border-destructive/30 bg-destructive/5">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-6 w-6 text-destructive shrink-0" />
                    <div>
                      <p className="font-semibold text-destructive">This will alert the manager</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Use escalation for urgent issues that need immediate manager attention.
                        For non-urgent issues, please use the Report Issue feature instead.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="reason"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Reason for Escalation</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="Describe why you need to escalate this issue..."
                            className="min-h-32"
                            data-testid="textarea-reason"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button 
                    type="submit" 
                    className="w-full h-12 text-base font-semibold bg-destructive hover:bg-destructive/90"
                    disabled={createEscalationMutation.isPending}
                    data-testid="button-escalate"
                  >
                    {createEscalationMutation.isPending ? (
                      <LoadingSpinner size="sm" className="text-destructive-foreground" />
                    ) : (
                      <>
                        <AlertTriangle className="mr-2 h-5 w-5" />
                        Escalate Now
                      </>
                    )}
                  </Button>
                </form>
              </Form>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="text-center py-6">
                <div className="h-16 w-16 mx-auto rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
                  <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
                <h2 className="text-xl font-bold mb-2">Escalation Created</h2>
                <p className="text-muted-foreground">Contact the manager using the details below</p>
              </div>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <h3 className="font-semibold">Manager Contact</h3>
                  
                  {branch?.managerPhone && (
                    <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted">
                      <div className="flex items-center gap-3">
                        <Phone className="h-5 w-5 text-primary" />
                        <div>
                          <p className="text-sm text-muted-foreground">Phone</p>
                          <p className="font-medium">{branch.managerPhone}</p>
                        </div>
                      </div>
                      <Button 
                        size="icon" 
                        variant="ghost"
                        onClick={() => copyToClipboard(branch.managerPhone!, "phone")}
                        data-testid="button-copy-phone"
                      >
                        {copied === "phone" ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  )}

                  {branch?.managerWhatsapp && (
                    <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted">
                      <div className="flex items-center gap-3">
                        <MessageCircle className="h-5 w-5 text-green-500" />
                        <div>
                          <p className="text-sm text-muted-foreground">WhatsApp</p>
                          <p className="font-medium">{branch.managerWhatsapp}</p>
                        </div>
                      </div>
                      <Button 
                        size="icon" 
                        variant="ghost"
                        onClick={() => copyToClipboard(branch.managerWhatsapp!, "whatsapp")}
                        data-testid="button-copy-whatsapp"
                      >
                        {copied === "whatsapp" ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  )}

                  {!branch?.managerPhone && !branch?.managerWhatsapp && (
                    <p className="text-muted-foreground text-center py-4">
                      No manager contact information available. Please ask your supervisor.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Link href="/today">
                <Button variant="secondary" className="w-full h-12" data-testid="button-done">
                  Done
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
