import { useState } from "react";
import { useLocation } from "wouter";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  BookOpen, Globe, MapPin, Plus, Search, Clock, Check, 
  Archive, FileText, Shield, List, MessageSquare, GraduationCap, 
  Wrench, HelpCircle, History, Send, Upload
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useBranchContext } from "@/hooks/use-branch-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { KnowledgeFiles } from "@/components/studio/knowledge-files";
import type { KbArticle, KbArticleVersion } from "@shared/schema";
import { format } from "date-fns";

const ARTICLE_TYPES = [
  { value: "SOP", label: "SOP", icon: FileText },
  { value: "Policy", label: "Policy", icon: Shield },
  { value: "Safety", label: "Safety", icon: Shield },
  { value: "Checklist", label: "Checklist", icon: List },
  { value: "Script", label: "Script", icon: MessageSquare },
  { value: "FAQ", label: "FAQ", icon: HelpCircle },
  { value: "Training", label: "Training", icon: GraduationCap },
  { value: "Maintenance", label: "Maintenance", icon: Wrench },
] as const;

const DEPARTMENTS = [
  "Front Desk",
  "Cafe",
  "Floor Staff",
  "Cleaning",
  "Maintenance",
  "Birthday / Events",
  "Management",
  "Admin",
] as const;

const ROLES = [
  "Reception",
  "Barista",
  "Party Host",
  "Floor Staff",
  "Cleaner",
  "Technician",
  "Supervisor",
  "Manager",
] as const;

export default function KnowledgeBasePage() {
  const { user } = useAuth();
  const { branches } = useBranchContext();
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const isManager = user?.role === "admin" || user?.role === "manager" || user?.role === "global_admin" || user?.role === "operator_admin";
  const isAdmin = user?.role === "admin" || user?.role === "global_admin";
  const activeTab = location.endsWith("/files") ? "files" : "articles";
  
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isVersionDialogOpen, setIsVersionDialogOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<KbArticle | null>(null);
  const [viewingVersions, setViewingVersions] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("SOP");
  const [content, setContent] = useState("");
  const [quickAnswer, setQuickAnswer] = useState("");
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [branchScope, setBranchScope] = useState<"ALL" | "SELECTED">("ALL");
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);

  // Build URL with query parameters
  const buildUrl = () => {
    const params = new URLSearchParams();
    if (filterType !== "all") params.set("type", filterType);
    if (filterStatus !== "all") params.set("status", filterStatus);
    if (searchQuery) params.set("search", searchQuery);
    const queryString = params.toString();
    return queryString ? `/api/knowledge-base?${queryString}` : "/api/knowledge-base";
  };

  const { data: articles = [], isLoading } = useQuery<KbArticle[]>({
    queryKey: ["/api/knowledge-base", filterType, filterStatus, searchQuery],
    queryFn: async () => {
      const res = await fetch(buildUrl(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch articles");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: versions = [] } = useQuery<KbArticleVersion[]>({
    queryKey: ["/api/knowledge-base", viewingVersions, "versions"],
    queryFn: async () => {
      const res = await fetch(`/api/knowledge-base/${viewingVersions}/versions`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch versions");
      return res.json();
    },
    enabled: !!viewingVersions,
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<KbArticle>) => {
      const res = await apiRequest("POST", "/api/knowledge-base", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      toast({ title: "Article created successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create article", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<KbArticle> }) => {
      const res = await apiRequest("PATCH", `/api/knowledge-base/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      toast({ title: "Article updated successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update article", description: error.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async ({ id, changeNotes }: { id: string; changeNotes?: string }) => {
      const res = await apiRequest("POST", `/api/knowledge-base/${id}/publish`, { changeNotes });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      toast({ title: "Article published successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to publish article", description: error.message, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/knowledge-base/${id}/archive`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      toast({ title: "Article archived successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to archive article", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/knowledge-base/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      toast({ title: "Article deleted successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete article", description: error.message, variant: "destructive" });
    },
  });

  const openDialog = (article?: KbArticle) => {
    if (article) {
      setEditingArticle(article);
      setTitle(article.title);
      setType(article.type);
      setContent(article.content || "");
      setQuickAnswer(article.quickAnswer?.join("\n") || "");
      setSelectedDepartments(article.departments || []);
      setSelectedRoles(article.roles || []);
      setTags(article.tags?.join(", ") || "");
      setBranchScope(article.branchScope);
      setSelectedBranchIds(article.branchIds || []);
    } else {
      setEditingArticle(null);
      setTitle("");
      setType("SOP");
      setContent("");
      setQuickAnswer("");
      setSelectedDepartments([]);
      setSelectedRoles([]);
      setTags("");
      setBranchScope("ALL");
      setSelectedBranchIds([]);
    }
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setEditingArticle(null);
  };

  const handleSubmit = () => {
    const data = {
      title,
      type,
      content,
      quickAnswer: quickAnswer.split("\n").filter(Boolean),
      departments: selectedDepartments,
      roles: selectedRoles,
      tags: tags.split(",").map(t => t.trim()).filter(Boolean),
      branchScope,
      branchIds: branchScope === "SELECTED" ? selectedBranchIds : [],
    };

    if (editingArticle) {
      updateMutation.mutate({ id: editingArticle.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handlePublish = () => {
    if (!editingArticle) return;
    const notes = prompt("Enter change notes (optional):");
    publishMutation.mutate({ id: editingArticle.id, changeNotes: notes || undefined });
  };

  const toggleDepartment = (dept: string) => {
    setSelectedDepartments(prev =>
      prev.includes(dept) ? prev.filter(d => d !== dept) : [...prev, dept]
    );
  };

  const toggleRole = (role: string) => {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  };

  const toggleBranch = (branchId: string) => {
    setSelectedBranchIds(prev =>
      prev.includes(branchId) ? prev.filter(id => id !== branchId) : [...prev, branchId]
    );
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary">Draft</Badge>;
      case "published":
        return <Badge className="bg-green-600 text-white">Published</Badge>;
      case "archived":
        return <Badge variant="outline">Archived</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getTypeIcon = (articleType: string) => {
    const typeInfo = ARTICLE_TYPES.find(t => t.value === articleType);
    const Icon = typeInfo?.icon || FileText;
    return <Icon className="h-4 w-4" />;
  };

  if (isLoading) {
    return (
      <StudioLayout>
        <LoadingScreen />
      </StudioLayout>
    );
  }

  return (
    <StudioLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            ASK OTO
          </h1>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Manage knowledge base content for the ASK OTO AI assistant. Articles and uploaded files are searchable by staff.
        </p>

        <Tabs value={activeTab} onValueChange={(v) => navigate(v === "files" ? "/studio/kb/files" : "/studio/kb")} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="articles" className="flex items-center gap-2" data-testid="tab-articles">
              <FileText className="h-4 w-4" />
              Articles
            </TabsTrigger>
            <TabsTrigger value="files" className="flex items-center gap-2" data-testid="tab-files">
              <Upload className="h-4 w-4" />
              Files
            </TabsTrigger>
          </TabsList>

          <TabsContent value="articles">
            <div className="flex items-center justify-end mb-4">
              {isManager && (
                <Button size="sm" onClick={() => openDialog()} data-testid="button-create-article">
                  <Plus className="h-4 w-4 mr-1" />
                  Add Article
                </Button>
              )}
            </div>

            <div className="flex gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search articles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-articles"
            />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[130px]" data-testid="select-filter-type">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {ARTICLE_TYPES.map(t => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[130px]" data-testid="select-filter-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {articles.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No articles"
              description={searchQuery ? "No matching articles found" : "No knowledge base articles have been created yet"}
            />
          ) : (
            articles.map((article) => (
              <Card 
                key={article.id} 
                className={`overflow-visible ${isManager ? 'hover-elevate cursor-pointer' : ''}`}
                data-testid={`card-article-${article.id}`}
                onClick={() => isManager && openDialog(article)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-md bg-muted">
                      {getTypeIcon(article.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold">{article.title}</h3>
                        {getStatusBadge(article.status)}
                        <Badge variant="outline" className="text-xs">{article.type}</Badge>
                        {article.version > 1 && (
                          <Badge variant="secondary" className="text-xs">v{article.version}</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
                        {article.branchScope === "ALL" && (
                          <span className="flex items-center gap-1">
                            <Globe className="h-3 w-3" />
                            All branches
                          </span>
                        )}
                        {article.branchScope === "SELECTED" && (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {article.branchIds?.length || 0} branches
                          </span>
                        )}
                        {article.updatedAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(article.updatedAt), "d MMM yyyy")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-2 flex-wrap">
                        {article.roles?.slice(0, 3).map(role => (
                          <Badge key={role} variant="secondary" className="text-xs">{role}</Badge>
                        ))}
                        {(article.roles?.length || 0) > 3 && (
                          <Badge variant="secondary" className="text-xs">+{article.roles!.length - 3}</Badge>
                        )}
                      </div>
                    </div>
                    {isManager && article.version > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewingVersions(article.id);
                          setIsVersionDialogOpen(true);
                        }}
                        data-testid={`button-versions-${article.id}`}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
          </TabsContent>

          <TabsContent value="files">
            <KnowledgeFiles isAdmin={isAdmin} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingArticle ? "Edit Article" : "Create Article"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Article title"
                  data-testid="input-article-title"
                />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger data-testid="select-article-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ARTICLE_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Article content..."
                rows={6}
                data-testid="textarea-article-content"
              />
            </div>

            <div className="space-y-2">
              <Label>Quick Answer (one bullet per line)</Label>
              <Textarea
                value={quickAnswer}
                onChange={(e) => setQuickAnswer(e.target.value)}
                placeholder="Enter 2-5 quick points..."
                rows={3}
                data-testid="textarea-quick-answer"
              />
            </div>

            <div className="space-y-2">
              <Label>Departments</Label>
              <div className="flex flex-wrap gap-2">
                {DEPARTMENTS.map(dept => (
                  <Badge
                    key={dept}
                    variant={selectedDepartments.includes(dept) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleDepartment(dept)}
                    data-testid={`badge-dept-${dept.replace(/\s+/g, "-").toLowerCase()}`}
                  >
                    {selectedDepartments.includes(dept) && <Check className="h-3 w-3 mr-1" />}
                    {dept}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Roles (required)</Label>
              <div className="flex flex-wrap gap-2">
                {ROLES.map(role => (
                  <Badge
                    key={role}
                    variant={selectedRoles.includes(role) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleRole(role)}
                    data-testid={`badge-role-${role.replace(/\s+/g, "-").toLowerCase()}`}
                  >
                    {selectedRoles.includes(role) && <Check className="h-3 w-3 mr-1" />}
                    {role}
                  </Badge>
                ))}
              </div>
              {selectedRoles.length === 0 && (
                <p className="text-sm text-destructive">Select at least one role</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Tags (comma separated)</Label>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="opening, closing, safety..."
                data-testid="input-tags"
              />
            </div>

            <div className="space-y-2">
              <Label>Branch Scope</Label>
              <Select value={branchScope} onValueChange={(v) => setBranchScope(v as "ALL" | "SELECTED")}>
                <SelectTrigger data-testid="select-branch-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      All branches
                    </div>
                  </SelectItem>
                  <SelectItem value="SELECTED">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      Selected branches
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {branchScope === "SELECTED" && (
              <div className="space-y-2">
                <Label>Select Branches</Label>
                <div className="border rounded-md p-2 max-h-32 overflow-y-auto space-y-1">
                  {branches.map((branch) => (
                    <div
                      key={branch.id}
                      className={`flex items-center gap-2 p-2 rounded-md cursor-pointer hover-elevate ${
                        selectedBranchIds.includes(branch.id) ? 'bg-primary/10' : ''
                      }`}
                      onClick={() => toggleBranch(branch.id)}
                    >
                      <div className={`h-4 w-4 rounded border flex items-center justify-center ${
                        selectedBranchIds.includes(branch.id) 
                          ? 'bg-primary border-primary text-primary-foreground' 
                          : 'border-muted-foreground/30'
                      }`}>
                        {selectedBranchIds.includes(branch.id) && <Check className="h-3 w-3" />}
                      </div>
                      <span className="text-sm">{branch.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-2 flex-wrap">
              {editingArticle && isAdmin && (
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (confirm("Delete this article? This cannot be undone.")) {
                      deleteMutation.mutate(editingArticle.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  data-testid="button-delete-article"
                >
                  Delete
                </Button>
              )}
              {editingArticle && editingArticle.status !== "archived" && isAdmin && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (confirm("Archive this article?")) {
                      archiveMutation.mutate(editingArticle.id);
                    }
                  }}
                  disabled={archiveMutation.isPending}
                  data-testid="button-archive-article"
                >
                  <Archive className="h-4 w-4 mr-1" />
                  Archive
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="outline" onClick={closeDialog} data-testid="button-cancel">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!title || selectedRoles.length === 0 || createMutation.isPending || updateMutation.isPending}
                data-testid="button-save-article"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save Draft"}
              </Button>
              {editingArticle && editingArticle.status !== "archived" && (
                <Button
                  onClick={handlePublish}
                  disabled={!title || selectedRoles.length === 0 || publishMutation.isPending}
                  data-testid="button-publish-article"
                >
                  <Send className="h-4 w-4 mr-1" />
                  {publishMutation.isPending ? "Publishing..." : "Publish"}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Version History Dialog */}
      <Dialog open={isVersionDialogOpen} onOpenChange={setIsVersionDialogOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Version History
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {versions.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No version history</p>
            ) : (
              versions.map((version) => (
                <Card key={version.id}>
                  <CardHeader className="p-3">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Version {version.version}</span>
                      <Badge variant="secondary" className="text-xs">
                        {format(new Date(version.publishedAt), "d MMM yyyy HH:mm")}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 pt-0 text-sm text-muted-foreground">
                    <p>Published by: {version.publishedByName || "Unknown"}</p>
                    {version.changeNotes && (
                      <p className="mt-1 italic">"{version.changeNotes}"</p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
