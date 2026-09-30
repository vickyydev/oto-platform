import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Search, FileText, ChevronRight, Clock, QrCode, ExternalLink, CheckCircle } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { SopArticle } from "@shared/schema";

const EXTERNAL_TOOLS = [
  {
    title: "QR Code Generator",
    description: "Create QR codes for park operations",
    url: "https://oto-qr-forge--bymat.replit.app/",
    icon: QrCode,
  },
];

const DEPARTMENTS = [
  { value: "all", label: "All" },
  { value: "reception", label: "Reception" },
  { value: "barista", label: "Barista" },
  { value: "waiters", label: "Waiters" },
  { value: "nanny_cleaners", label: "Nanny/Cleaners" },
  { value: "kitchen", label: "Kitchen" },
  { value: "maintenance", label: "Maintenance" },
];

export default function FindPage() {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState("all");

  const { data: articles, isLoading } = useQuery<SopArticle[]>({
    queryKey: ["/api/sops"],
    enabled: !!user,
  });

  const filteredArticles = articles?.filter((article) => {
    const matchesSearch = searchQuery === "" || 
      article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (article.body || "").toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesDepartment = selectedDepartment === "all" || 
      (article.departments || []).includes(selectedDepartment);
    
    return matchesSearch && matchesDepartment;
  });

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Search className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Find & Learn</h1>
            </div>
          </div>
          <Card className="bg-primary/5 border-primary/20 mt-4">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground mb-3">
                Not just a document library. A <span className="font-semibold text-foreground">learning guide</span> designed to help our team:
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  <span>Easy to scan</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  <span>Easy to remember</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  <span>Follow during work</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  <span>Less mistakes</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="sticky top-14 z-30 bg-background pb-4 -mx-4 px-4">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search SOPs and guides..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-12"
              data-testid="input-search"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-hide">
            {DEPARTMENTS.map((dept) => (
              <Badge
                key={dept.value}
                variant={selectedDepartment === dept.value ? "default" : "secondary"}
                className={cn(
                  "cursor-pointer whitespace-nowrap px-3 py-1.5 text-sm",
                  selectedDepartment === dept.value && "bg-primary text-primary-foreground"
                )}
                onClick={() => setSelectedDepartment(dept.value)}
                data-testid={`filter-${dept.value}`}
              >
                {dept.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">QUICK TOOLS</h2>
          <div className="grid gap-3">
            {EXTERNAL_TOOLS.map((tool) => (
              <a
                key={tool.url}
                href={tool.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`tool-${tool.title.toLowerCase().replace(/\s/g, '-')}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <tool.icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold">{tool.title}</h3>
                        <p className="text-sm text-muted-foreground">{tool.description}</p>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </div>

        <h2 className="text-sm font-semibold text-muted-foreground mb-3">SOP ARTICLES</h2>
        <div className="space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : !filteredArticles || filteredArticles.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No articles found"
              description={searchQuery ? "Try adjusting your search terms" : "SOP articles will appear here"}
            />
          ) : (
            filteredArticles.map((article) => (
              <Link key={article.id} href={`/core/sop/${article.id}`}>
                <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-article-${article.id}`}>
                  <CardContent className="p-0">
                    {(article as any).coverImageUrl && (
                      <div className="h-32 w-full overflow-hidden rounded-t-lg">
                        <img 
                          src={(article as any).coverImageUrl} 
                          alt={article.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold mb-1">{article.title}</h3>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {(article as any).summary || (article.body || "").substring(0, 120)}...
                          </p>
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            {(article.departments || []).slice(0, 2).map((dept) => (
                              <Badge key={dept} variant="secondary" className="text-xs capitalize">
                                {dept.replace("_", "/")}
                              </Badge>
                            ))}
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {(article as any).readingTime || 3} min read
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 mt-1" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </div>
      </div>
    </AppLayout>
  );
}
