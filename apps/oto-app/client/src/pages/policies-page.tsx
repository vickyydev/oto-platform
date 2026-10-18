import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PolicyDocument, Setting, PublicHoliday } from "@shared/schema";
import { DatePicker } from "@/components/ui/date-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, FileText, Edit, Eye, Clock, MoreHorizontal, Loader2, Archive, ArchiveRestore, ChevronDown, Send, CheckCircle2, Calendar, RefreshCw, Save, Trash2, Flag } from "lucide-react";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format-utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LeaveTypesManager } from "@/components/leave/leave-types-manager";

function PoliciesTableSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const [, setLocation] = useLocation();
  return (
    <div className="text-center py-16">
      <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
      <h3 className="text-lg font-medium mb-2">No policy documents yet</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        Create your company's Rules & Regulations document to attach to employment contracts.
      </p>
      <Button 
        onClick={() => setLocation("/policies/new")}
        data-testid="button-create-first-policy"
      >
        <Plus className="mr-2 h-4 w-4" />
        Create Policy Document
      </Button>
    </div>
  );
}

const hrPoliciesFormSchema = z.object({
  probationDaysDefault: z.number().min(1, "Must be at least 1 day").max(365, "Cannot exceed 365 days"),
});

type HRPoliciesFormData = z.infer<typeof hrPoliciesFormSchema>;

export default function PoliciesPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [policyToPublish, setPolicyToPublish] = useState<PolicyDocument | null>(null);
  
  // Public holidays state
  const [publicHolidayDialogOpen, setPublicHolidayDialogOpen] = useState(false);
  const [editingHoliday, setEditingHoliday] = useState<PublicHoliday | null>(null);
  const [holidayName, setHolidayName] = useState("");
  const [holidayDate, setHolidayDate] = useState("");
  const [deleteHolidayDialogOpen, setDeleteHolidayDialogOpen] = useState(false);
  const [holidayToDelete, setHolidayToDelete] = useState<PublicHoliday | null>(null);

  const { data: policies, isLoading } = useQuery<PolicyDocument[]>({
    queryKey: ["/api/policies"],
  });

  const { data: publicHolidays, isLoading: publicHolidaysLoading } = useQuery<PublicHoliday[]>({
    queryKey: ["/api/public-holidays"],
  });

  const publishMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/policies/${id}/publish`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policies"] });
      toast({
        title: "Policy published",
        description: "The policy document is now active and will be attached to new contracts.",
      });
      setPublishDialogOpen(false);
      setPolicyToPublish(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Error publishing policy",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/policies/${id}/archive`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policies"] });
      toast({
        title: "Policy archived",
        description: "The policy document has been archived.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error archiving policy",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // HR Policies (probation settings)
  const { data: settings } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
  });

  const hrPoliciesForm = useForm<HRPoliciesFormData>({
    resolver: zodResolver(hrPoliciesFormSchema),
    defaultValues: {
      probationDaysDefault: 120,
    },
  });

  useEffect(() => {
    if (settings) {
      const probationDays = settings.find((s) => s.key === "probation_days_default");
      if (probationDays?.value) {
        hrPoliciesForm.reset({
          probationDaysDefault: parseInt(probationDays.value, 10) || 120,
        });
      }
    }
  }, [settings, hrPoliciesForm]);

  const saveHRPoliciesMutation = useMutation({
    mutationFn: async (data: HRPoliciesFormData) => {
      await apiRequest("POST", "/api/settings", [
        { key: "probation_days_default", value: data.probationDaysDefault.toString() },
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "HR policies saved",
        description: "Default probation period has been updated.",
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

  const recalculateProbationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/employees/recalculate-probation");
      return res.json();
    },
    onSuccess: (data: { message: string; updatedCount: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      toast({
        title: "Probation dates recalculated",
        description: data.message,
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

  const onHRPoliciesSubmit = (data: HRPoliciesFormData) => {
    saveHRPoliciesMutation.mutate(data);
  };

  // Public holiday mutations
  const createPublicHolidayMutation = useMutation({
    mutationFn: async (data: { name: string; date: string }) => {
      const res = await apiRequest("POST", "/api/public-holidays", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/public-holidays"] });
      toast({ title: "Public holiday added" });
      setPublicHolidayDialogOpen(false);
      setHolidayName("");
      setHolidayDate("");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updatePublicHolidayMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; date?: string } }) => {
      const res = await apiRequest("PATCH", `/api/public-holidays/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/public-holidays"] });
      toast({ title: "Public holiday updated" });
      setPublicHolidayDialogOpen(false);
      setEditingHoliday(null);
      setHolidayName("");
      setHolidayDate("");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deletePublicHolidayMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/public-holidays/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/public-holidays"] });
      toast({ title: "Public holiday deleted" });
      setDeleteHolidayDialogOpen(false);
      setHolidayToDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleAddHoliday = () => {
    setEditingHoliday(null);
    setHolidayName("");
    setHolidayDate("");
    setPublicHolidayDialogOpen(true);
  };

  const handleEditHoliday = (holiday: PublicHoliday) => {
    setEditingHoliday(holiday);
    setHolidayName(holiday.name);
    setHolidayDate(holiday.date);
    setPublicHolidayDialogOpen(true);
  };

  const handleSaveHoliday = () => {
    if (!holidayName.trim() || !holidayDate) return;
    
    if (editingHoliday) {
      updatePublicHolidayMutation.mutate({
        id: editingHoliday.id,
        data: { name: holidayName.trim(), date: holidayDate },
      });
    } else {
      createPublicHolidayMutation.mutate({
        name: holidayName.trim(),
        date: holidayDate,
      });
    }
  };

  const handleDeleteHoliday = (holiday: PublicHoliday) => {
    setHolidayToDelete(holiday);
    setDeleteHolidayDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "published":
        return <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />Published</Badge>;
      case "draft":
        return <Badge variant="secondary">Draft</Badge>;
      case "archived":
        return <Badge variant="outline">Archived</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const handlePublishClick = (policy: PolicyDocument) => {
    setPolicyToPublish(policy);
    setPublishDialogOpen(true);
  };

  const confirmPublish = () => {
    if (policyToPublish) {
      publishMutation.mutate(policyToPublish.id);
    }
  };

  const activePolicies = policies?.filter(p => p.status !== "archived") || [];
  const archivedPolicies = policies?.filter(p => p.status === "archived") || [];

  const renderPolicyRow = (policy: PolicyDocument) => (
    <TableRow key={policy.id} data-testid={`policy-row-${policy.id}`}>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
            <FileText className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">{policy.title}</p>
            <p className="text-sm text-muted-foreground font-mono">
              ID: {policy.id.slice(0, 8)}...
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {getStatusBadge(policy.status)}
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="font-mono">
          v{policy.versionInt}
        </Badge>
      </TableCell>
      <TableCell>
        {policy.publishedAt ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Send className="h-4 w-4" />
            <span className="text-sm">
              {formatDate(policy.publishedAt)}
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Not published</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span className="text-sm">
            {formatDate(policy.updatedAt)}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => setLocation(`/policies/${policy.id}/preview`)}
            data-testid={`button-preview-${policy.id}`}
          >
            <Eye className="h-4 w-4" />
          </Button>
          {policy.status !== "archived" && (
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setLocation(`/policies/${policy.id}`)}
              data-testid={`button-edit-${policy.id}`}
            >
              <Edit className="h-4 w-4" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" data-testid={`button-more-${policy.id}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {policy.status === "draft" && (
                <>
                  <DropdownMenuItem 
                    onClick={() => handlePublishClick(policy)}
                    data-testid={`button-publish-${policy.id}`}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Publish
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {policy.status !== "archived" ? (
                <DropdownMenuItem 
                  onClick={() => archiveMutation.mutate(policy.id)}
                  disabled={archiveMutation.isPending}
                  data-testid={`button-archive-${policy.id}`}
                >
                  <Archive className="h-4 w-4 mr-2" />
                  Archive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem 
                  onClick={() => setLocation(`/policies/${policy.id}`)}
                  data-testid={`button-view-${policy.id}`}
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-medium" data-testid="text-policies-title">Rules & Regulations</h1>
          <p className="text-muted-foreground">
            Manage company policy documents that employees must acknowledge when signing contracts
          </p>
        </div>
        <Button 
          onClick={() => setLocation("/policies/new")}
          data-testid="button-new-policy"
        >
          <Plus className="mr-2 h-4 w-4" />
          New Policy Document
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Policy Documents</CardTitle>
              <CardDescription>
                Active and draft policy documents
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <PoliciesTableSkeleton />
          ) : activePolicies.length === 0 ? (
            <EmptyState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activePolicies.map(renderPolicyRow)}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {archivedPolicies.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover-elevate">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Archive className="h-5 w-5" />
                      Archived Policies
                      <Badge variant="secondary">{archivedPolicies.length}</Badge>
                    </CardTitle>
                    <CardDescription>
                      Previously published policy versions
                    </CardDescription>
                  </div>
                  <ChevronDown className={`h-5 w-5 transition-transform ${archivedOpen ? "rotate-180" : ""}`} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Published</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {archivedPolicies.map(renderPolicyRow)}
                  </TableBody>
                </Table>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      <LeaveTypesManager />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-500 text-white">
                <Flag className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Public Holidays</CardTitle>
                <CardDescription>
                  Manage public holidays that employees can earn as additional days off
                </CardDescription>
              </div>
            </div>
            <Button onClick={handleAddHoliday} size="sm" data-testid="button-add-public-holiday">
              <Plus className="mr-1 h-4 w-4" />
              Add Holiday
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {publicHolidaysLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !publicHolidays || publicHolidays.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Flag className="h-10 w-10 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No public holidays configured</p>
              <p className="text-xs mt-1">Add holidays to allow employees to earn additional days off</p>
            </div>
          ) : (
            <div className="space-y-1">
              {publicHolidays.map((holiday) => {
                const holidayDateObj = new Date(holiday.date + "T00:00:00");
                const isPast = holidayDateObj < new Date();
                return (
                  <div
                    key={holiday.id}
                    className={`flex items-center justify-between p-3 rounded-lg border ${isPast ? "bg-muted/30" : "bg-card"}`}
                    data-testid={`public-holiday-row-${holiday.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`text-center min-w-[60px] ${isPast ? "text-muted-foreground" : ""}`}>
                        <div className="text-lg font-semibold">
                          {holidayDateObj.getDate()}
                        </div>
                        <div className="text-xs uppercase">
                          {holidayDateObj.toLocaleDateString("en-GB", { month: "short" })}
                        </div>
                      </div>
                      <div>
                        <p className={`font-medium ${isPast ? "text-muted-foreground" : ""}`}>
                          {holiday.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {holidayDateObj.toLocaleDateString("en-GB", { weekday: "long" })}
                          {isPast && " (passed)"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEditHoliday(holiday)}
                        data-testid={`button-edit-holiday-${holiday.id}`}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteHoliday(holiday)}
                        data-testid={`button-delete-holiday-${holiday.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Form {...hrPoliciesForm}>
        <form onSubmit={hrPoliciesForm.handleSubmit(onHRPoliciesSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Calendar className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>HR Policies</CardTitle>
                  <CardDescription>
                    Configure default employment policies
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={hrPoliciesForm.control}
                name="probationDaysDefault"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default Probation Period (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="120"
                        data-testid="input-probation-days-default"
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value, 10) || 0)}
                      />
                    </FormControl>
                    <FormDescription>
                      Default probation period in days for new employees. Common values: 90 days (3 months) or 120 days (4 months).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="pt-4 border-t">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-medium">Recalculate Probation End Dates</p>
                    <p className="text-xs text-muted-foreground">
                      Update probation end dates for all employees with a start date but no calculated end date
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => recalculateProbationMutation.mutate()}
                    disabled={recalculateProbationMutation.isPending}
                    data-testid="button-recalculate-probation"
                  >
                    {recalculateProbationMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Calculating...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Recalculate All
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saveHRPoliciesMutation.isPending}
              data-testid="button-save-hr-policies"
            >
              {saveHRPoliciesMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save HR Policies
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>

      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish Policy Document?</DialogTitle>
            <DialogDescription>
              Publishing this policy makes it available to attach to new contracts. A contract carries one policy document: when several are published for the same branch or company, the one with the highest version number is used. Employees must acknowledge it when signing.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm">
              <strong>Title:</strong> {policyToPublish?.title}
            </p>
            <p className="text-sm">
              <strong>Version:</strong> v{policyToPublish?.versionInt}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={confirmPublish}
              disabled={publishMutation.isPending}
              data-testid="button-confirm-publish"
            >
              {publishMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publicHolidayDialogOpen} onOpenChange={(open) => {
        setPublicHolidayDialogOpen(open);
        if (!open) {
          setEditingHoliday(null);
          setHolidayName("");
          setHolidayDate("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingHoliday ? "Edit Public Holiday" : "Add Public Holiday"}</DialogTitle>
            <DialogDescription>
              {editingHoliday 
                ? "Update the name or date of this public holiday." 
                : "Add a new public holiday for employees to earn as additional days off."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="holiday-name">Holiday Name</Label>
              <Input
                id="holiday-name"
                placeholder="e.g., New Year's Day"
                value={holidayName}
                onChange={(e) => setHolidayName(e.target.value)}
                data-testid="input-holiday-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="holiday-date">Date</Label>
              <DatePicker
                value={holidayDate}
                onChange={setHolidayDate}
                data-testid="input-holiday-date"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublicHolidayDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveHoliday}
              disabled={!holidayName.trim() || !holidayDate || createPublicHolidayMutation.isPending || updatePublicHolidayMutation.isPending}
              data-testid="button-submit-holiday"
            >
              {(createPublicHolidayMutation.isPending || updatePublicHolidayMutation.isPending) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editingHoliday ? "Update" : "Add Holiday"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteHolidayDialogOpen} onOpenChange={setDeleteHolidayDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Public Holiday?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this public holiday? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {holidayToDelete && (
            <div className="py-4">
              <p className="text-sm"><strong>Holiday:</strong> {holidayToDelete.name}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {new Date(holidayToDelete.date + "T00:00:00").toLocaleDateString("en-GB", { 
                  weekday: "long", 
                  day: "numeric",
                  month: "long",
                  year: "numeric" 
                })}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteHolidayDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => holidayToDelete && deletePublicHolidayMutation.mutate(holidayToDelete.id)}
              disabled={deletePublicHolidayMutation.isPending}
              data-testid="button-confirm-delete-holiday"
            >
              {deletePublicHolidayMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
