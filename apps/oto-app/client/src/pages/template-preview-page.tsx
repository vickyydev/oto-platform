import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Template, Branch, TemplateAssignment } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, FileText, Building2, Clock } from "lucide-react";
import { Link } from "wouter";
import { formatDate, formatDateTime } from "@/lib/format-utils";
import Handlebars from "handlebars";
import DOMPurify from "isomorphic-dompurify";

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
};

export default function TemplatePreviewPage() {
  const { id } = useParams<{ id: string }>();

  const { data: template, isLoading: templateLoading } = useQuery<Template>({
    queryKey: ["/api/templates", id],
  });

  const { data: assignments } = useQuery<TemplateAssignment[]>({
    queryKey: ["/api/templates", id, "assignments"],
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const getBranchName = (branchId: string) => {
    return branches?.find((b) => b.id === branchId)?.name || "Unknown";
  };

  const renderPreview = () => {
    if (!template?.htmlBody) return "";
    try {
      const compiled = Handlebars.compile(template.htmlBody);
      const html = compiled(sampleData);
      return DOMPurify.sanitize(html);
    } catch {
      return template.htmlBody;
    }
  };

  if (templateLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Card>
          <CardContent className="py-16 text-center">
            <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-medium mb-2">Template not found</h3>
            <Link href="/templates">
              <Button variant="outline">Back to Templates</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/templates">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-medium" data-testid="text-template-name">
              {template.name}
            </h1>
            <Badge variant="secondary" className="font-mono">
              v{template.version}
            </Badge>
            <Badge variant={template.status === "active" ? "default" : "secondary"}>
              {template.status || "active"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Template Preview (Read-only)
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Document Preview</CardTitle>
              <CardDescription>
                How this template looks with sample data
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div 
                className="bg-white border rounded-md p-8 min-h-[600px] prose prose-sm max-w-none"
                style={{
                  width: "100%",
                  aspectRatio: "210 / 297",
                }}
                dangerouslySetInnerHTML={{ __html: renderPreview() }}
                data-testid="template-preview-content"
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground">Last Updated</p>
                <div className="flex items-center gap-2 mt-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {formatDateTime(template.updatedAt)}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Header Settings</p>
                <div className="mt-1 space-y-1 text-sm">
                  <p>Logo: {template.headerShowLogo ? "Shown" : "Hidden"}</p>
                  <p>Address: {template.headerShowAddress ? "Shown" : "Hidden"}</p>
                  <p>Alignment: {template.headerAlignment || "left"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Assigned Branches</CardTitle>
              <CardDescription>
                Branches that can use this template
              </CardDescription>
            </CardHeader>
            <CardContent>
              {assignments && assignments.length > 0 ? (
                <div className="space-y-2">
                  {assignments.map((a) => (
                    <div key={a.branchId} className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{getBranchName(a.branchId)}</span>
                      {a.isDefaultForBranch && (
                        <Badge variant="outline" className="text-xs">Default</Badge>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No branches assigned yet
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
