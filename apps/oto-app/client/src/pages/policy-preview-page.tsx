import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { PolicyDocument } from "@shared/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Clock, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import { formatDate } from "@/lib/format-utils";

export default function PolicyPreviewPage() {
  const { id } = useParams<{ id: string }>();

  const { data: policy, isLoading } = useQuery<PolicyDocument>({
    queryKey: ["/api/policies", id],
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[600px]" />
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground">Policy document not found</p>
            <Link href="/policies">
              <Button className="mt-4">Back to Policies</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/policies">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-medium" data-testid="text-policy-title">
            {policy.title}
          </h1>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <Badge variant="secondary" className="font-mono">v{policy.versionInt}</Badge>
            <Badge variant={policy.status === "published" ? "default" : "secondary"} className="gap-1">
              {policy.status === "published" && <CheckCircle2 className="h-3 w-3" />}
              {policy.status}
            </Badge>
            {policy.publishedAt && (
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Published {formatDate(policy.publishedAt)}
              </span>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Policy Content</CardTitle>
          <CardDescription>
            This is how the policy document will appear to employees
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div 
            className="bg-white rounded-md border p-8 prose prose-sm max-w-none"
            style={{ 
              minHeight: 500,
              fontFamily: "'Times New Roman', Times, serif",
            }}
            dangerouslySetInnerHTML={{ __html: policy.contentHtml || "" }}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <Link href="/policies">
          <Button variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Policies
          </Button>
        </Link>
        {policy.status !== "archived" && (
          <Link href={`/policies/${policy.id}`}>
            <Button data-testid="button-edit-policy">
              Edit Policy
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
