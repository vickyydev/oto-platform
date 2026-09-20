import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Template, Branch, TemplateAssignment, templateTypes, templateTypeLabels, templateTypeColors, TemplateType } from "@shared/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Plus, FileText, Edit, Eye, Clock, MoreHorizontal, Loader2, Building2, GitFork, CheckCircle2, AlertTriangle, Archive, ArchiveRestore, ChevronDown, Briefcase, TrendingUp, UserMinus, UserX } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useLocation } from "wouter";
import { formatDate } from "@/lib/format-utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface TemplateWithAssignments extends Template {
  assignments: TemplateAssignment[];
}

function TemplatesTableSkeleton() {
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
  return (
    <div className="text-center py-16">
      <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
      <h3 className="text-lg font-medium mb-2">No templates yet</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        Create your first contract template to start generating employee contracts.
      </p>
      <Link href="/templates/new">
        <Button data-testid="button-create-first-template">
          <Plus className="mr-2 h-4 w-4" />
          Create Template
        </Button>
      </Link>
    </div>
  );
}

const templateTypeIcons: Record<TemplateType, typeof Briefcase> = {
  employment: Briefcase,
  promotion: TrendingUp,
  warning: AlertTriangle,
  resignation: UserMinus,
  termination: UserX,
};

export default function TemplatesPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateWithAssignments | null>(null);
  const [pendingAssignments, setPendingAssignments] = useState<Set<string>>(new Set());
  const [editWarningOpen, setEditWarningOpen] = useState(false);
  const [templateToEdit, setTemplateToEdit] = useState<TemplateWithAssignments | null>(null);
  const [contractCount, setContractCount] = useState(0);
  const [isCheckingContracts, setIsCheckingContracts] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TemplateType | "all">("all");

  const { data: templatesWithAssignments, isLoading } = useQuery<TemplateWithAssignments[]>({
    queryKey: ["/api/templates/with-assignments"],
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const assignMutation = useMutation({
    mutationFn: async ({ templateId, branchId }: { templateId: string; branchId: string }) => {
      const res = await apiRequest("POST", `/api/templates/${templateId}/assignments`, { branchId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error assigning template",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const unassignMutation = useMutation({
    mutationFn: async ({ templateId, branchId }: { templateId: string; branchId: string }) => {
      const res = await apiRequest("DELETE", `/api/templates/${templateId}/assignments/${branchId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error unassigning template",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await apiRequest("PATCH", `/api/templates/${templateId}`, { status: "archived" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to archive template");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
      toast({
        title: "Template archived",
        description: "The template has been archived and is no longer available for new contracts.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot archive template",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await apiRequest("PATCH", `/api/templates/${templateId}`, { status: "active" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to restore template");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/with-assignments"] });
      toast({
        title: "Template restored",
        description: "The template has been restored and is now available for new contracts.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot restore template",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openAssignDialog = (template: TemplateWithAssignments) => {
    setSelectedTemplate(template);
    setPendingAssignments(new Set(template.assignments.map(a => a.branchId)));
    setAssignDialogOpen(true);
  };

  const handleBranchToggle = (branchId: string, checked: boolean) => {
    const newAssignments = new Set(pendingAssignments);
    if (checked) {
      newAssignments.add(branchId);
    } else {
      newAssignments.delete(branchId);
    }
    setPendingAssignments(newAssignments);
  };

  const handleSaveAssignments = async () => {
    if (!selectedTemplate) return;

    const currentAssignments = new Set(selectedTemplate.assignments.map(a => a.branchId));
    const toAdd = Array.from(pendingAssignments).filter(id => !currentAssignments.has(id));
    const toRemove = Array.from(currentAssignments).filter(id => !pendingAssignments.has(id));

    try {
      await Promise.all([
        ...toAdd.map(branchId => assignMutation.mutateAsync({ templateId: selectedTemplate.id, branchId })),
        ...toRemove.map(branchId => unassignMutation.mutateAsync({ templateId: selectedTemplate.id, branchId })),
      ]);
      
      setAssignDialogOpen(false);
      setSelectedTemplate(null);
      toast({
        title: "Assignments updated",
        description: "Template branch assignments have been saved.",
      });
    } catch {
      // Errors handled in mutation callbacks
    }
  };

  const getBranchName = (branchId: string) => {
    return branches?.find((b) => b.id === branchId)?.name || "Unknown";
  };

  const getAssignedBranchBadges = (assignments: TemplateAssignment[]) => {
    if (assignments.length === 0) {
      return <span className="text-muted-foreground text-sm">No branches assigned</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {assignments.slice(0, 3).map((a) => (
          <Badge key={a.branchId} variant="outline" className="gap-1">
            <Building2 className="h-3 w-3" />
            {getBranchName(a.branchId)}
          </Badge>
        ))}
        {assignments.length > 3 && (
          <Badge variant="secondary">+{assignments.length - 3} more</Badge>
        )}
      </div>
    );
  };

  const handleEditClick = async (template: TemplateWithAssignments) => {
    setIsCheckingContracts(true);
    try {
      const response = await fetch(`/api/templates/${template.id}/contract-count`, {
        credentials: "include",
      });
      const { count } = await response.json();
      
      if (count > 0) {
        setTemplateToEdit(template);
        setContractCount(count);
        setEditWarningOpen(true);
      } else {
        setLocation(`/templates/${template.id}`);
      }
    } catch {
      setLocation(`/templates/${template.id}`);
    } finally {
      setIsCheckingContracts(false);
    }
  };

  const handleContinueEdit = () => {
    if (templateToEdit) {
      setLocation(`/templates/${templateToEdit.id}`);
    }
    setEditWarningOpen(false);
    setTemplateToEdit(null);
  };

  const handleFork = () => {
    if (templateToEdit) {
      setEditWarningOpen(false);
      openAssignDialog(templateToEdit);
    }
  };

  const isSaving = assignMutation.isPending || unassignMutation.isPending;

  // Filter templates by type and status
  const filteredByType = templatesWithAssignments?.filter(t => 
    typeFilter === "all" || t.templateType === typeFilter
  ) || [];
  const activeTemplates = filteredByType.filter(t => t.status !== "archived");
  const archivedTemplates = filteredByType.filter(t => t.status === "archived");

  const getTypeBadge = (type: TemplateType | string | null | undefined) => {
    const safeType = (type && templateTypes.includes(type as TemplateType) ? type : "employment") as TemplateType;
    const Icon = templateTypeIcons[safeType];
    return (
      <Badge className={`${templateTypeColors[safeType]} gap-1`}>
        <Icon className="h-3 w-3" />
        {templateTypeLabels[safeType]}
      </Badge>
    );
  };

  const renderTemplateRow = (template: TemplateWithAssignments) => (
    <TableRow key={template.id} data-testid={`template-row-${template.id}`}>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
            <FileText className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{template.name}</p>
              {template.forkedFromTemplateId && (
                <GitFork className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
            <p className="text-sm text-muted-foreground font-mono">
              ID: {template.id.slice(0, 8)}...
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {getTypeBadge(template.templateType)}
      </TableCell>
      <TableCell>
        {getAssignedBranchBadges(template.assignments)}
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="font-mono">
          v{template.version}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span className="text-sm">
            {formatDate(template.updatedAt)}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Link href={`/templates/${template.id}/preview`}>
            <Button variant="ghost" size="icon" data-testid={`button-preview-${template.id}`}>
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => handleEditClick(template)}
            disabled={isCheckingContracts}
            data-testid={`button-edit-${template.id}`}
          >
            <Edit className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" data-testid={`button-more-${template.id}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openAssignDialog(template)}>
                <Building2 className="h-4 w-4 mr-2" />
                Manage Branch Assignments
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {template.status !== "archived" ? (
                <DropdownMenuItem 
                  onClick={() => archiveMutation.mutate(template.id)}
                  disabled={archiveMutation.isPending}
                  data-testid={`button-archive-${template.id}`}
                >
                  <Archive className="h-4 w-4 mr-2" />
                  Archive Template
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem 
                  onClick={() => unarchiveMutation.mutate(template.id)}
                  disabled={unarchiveMutation.isPending}
                  data-testid={`button-unarchive-${template.id}`}
                >
                  <ArchiveRestore className="h-4 w-4 mr-2" />
                  Restore Template
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
          <h1 className="text-3xl font-medium" data-testid="text-templates-title">Template Library</h1>
          <p className="text-muted-foreground">
            Manage company-wide contract templates and assign them to branches
          </p>
        </div>
        <Link href="/templates/new">
          <Button data-testid="button-new-template">
            <Plus className="mr-2 h-4 w-4" />
            New Template
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground mr-2">Filter by type:</span>
        <Button
          variant={typeFilter === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setTypeFilter("all")}
          data-testid="filter-all"
        >
          All Types
        </Button>
        {templateTypes.map((type) => {
          const Icon = templateTypeIcons[type];
          return (
            <Button
              key={type}
              variant={typeFilter === type ? "default" : "outline"}
              size="sm"
              onClick={() => setTypeFilter(type)}
              className="gap-1"
              data-testid={`filter-${type}`}
            >
              <Icon className="h-3 w-3" />
              {templateTypeLabels[type]}
            </Button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Active Templates</CardTitle>
              <CardDescription>
                Templates available for creating new contracts
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TemplatesTableSkeleton />
          ) : activeTemplates.length === 0 ? (
            <EmptyState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Assigned Branches</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeTemplates.map(renderTemplateRow)}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {archivedTemplates.length > 0 && (
        <Collapsible defaultOpen={false}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover-elevate">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Archive className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Archived Templates</CardTitle>
                      <CardDescription>
                        {archivedTemplates.length} template{archivedTemplates.length !== 1 ? "s" : ""} no longer available for new contracts
                      </CardDescription>
                    </div>
                  </div>
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Assigned Branches</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Last Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {archivedTemplates.map(renderTemplateRow)}
                  </TableBody>
                </Table>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage Branch Assignments</DialogTitle>
            <DialogDescription>
              Select which branches can use "{selectedTemplate?.name}"
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3 max-h-[300px] overflow-y-auto">
            {branches?.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No branches available. Create a branch first.
              </p>
            ) : (
              branches?.map((branch) => (
                <div 
                  key={branch.id} 
                  className="flex items-center gap-3 p-3 rounded-md hover-elevate"
                >
                  <Checkbox
                    id={`branch-${branch.id}`}
                    checked={pendingAssignments.has(branch.id)}
                    onCheckedChange={(checked) => handleBranchToggle(branch.id, checked as boolean)}
                    data-testid={`checkbox-branch-${branch.id}`}
                  />
                  <label 
                    htmlFor={`branch-${branch.id}`}
                    className="flex-1 flex items-center gap-2 cursor-pointer"
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{branch.name}</span>
                  </label>
                  {pendingAssignments.has(branch.id) && (
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                  )}
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAssignments}
              disabled={isSaving}
              data-testid="button-save-assignments"
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Assignments
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editWarningOpen} onOpenChange={setEditWarningOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Template in Use
            </DialogTitle>
            <DialogDescription>
              This template has been used to generate {contractCount} contract{contractCount !== 1 ? "s" : ""}. 
              Editing will create a new version that affects future contracts only.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="text-sm">
              <p className="font-medium mb-2">You can:</p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>
                  <strong className="text-foreground">Continue Editing</strong> - Creates version {(templateToEdit?.version || 0) + 1} of this template
                </li>
                <li>
                  <strong className="text-foreground">Create a Fork</strong> - Makes a copy for specific branches without affecting the original
                </li>
              </ul>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setEditWarningOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={handleFork}
              data-testid="button-fork-template"
            >
              <GitFork className="h-4 w-4 mr-2" />
              Create Fork
            </Button>
            <Button
              onClick={handleContinueEdit}
              data-testid="button-continue-edit"
            >
              <Edit className="h-4 w-4 mr-2" />
              Continue Editing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
