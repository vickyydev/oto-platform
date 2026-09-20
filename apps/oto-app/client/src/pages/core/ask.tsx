import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { 
  MessageCircleQuestion, 
  Send, 
  FileText, 
  Search, 
  ChevronRight,
  BookOpen,
  Sparkles,
  AlertCircle,
  Filter,
  X,
  ListChecks,
  Zap,
  Wrench,
  File,
  ImageIcon,
  Video
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { KbArticle } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { InteractiveChecklist, type ChecklistStep } from "@/components/interactive-checklist";

interface ChecklistData {
  title: string;
  steps: ChecklistStep[];
}

interface MediaFile {
  id: string;
  filename: string;
  title: string;
  fileType: "image" | "video";
  mimeType: string;
}

interface AskResponse {
  answer: string;
  sources: Array<{
    id: string;
    title: string;
    type: string;
  }>;
  noMatch: boolean;
  checklist: ChecklistData | null;
  media?: MediaFile[];
}

const EXAMPLE_PROMPTS = [
  "What do I do if a child gets hurt?",
  "How do I close the café?",
  "What if POS is down?",
  "How do birthday check-ins work?",
  "Gate showing Java error",
];

const DEPARTMENTS = [
  { value: "all", label: "All Departments" },
  { value: "Front Desk", label: "Front Desk" },
  { value: "Cafe", label: "Cafe" },
  { value: "Floor Staff", label: "Floor Staff" },
  { value: "Cleaning", label: "Cleaning" },
  { value: "Maintenance", label: "Maintenance" },
  { value: "Birthday / Events", label: "Birthday/Events" },
  { value: "Management", label: "Management" },
  { value: "Admin", label: "Admin" },
];

const ARTICLE_TYPES = [
  { value: "all", label: "All Types" },
  { value: "SOP", label: "SOPs" },
  { value: "Policy", label: "Policies" },
  { value: "Safety", label: "Safety" },
  { value: "Checklist", label: "Checklists" },
  { value: "Script", label: "Scripts" },
  { value: "FAQ", label: "FAQs" },
  { value: "Training", label: "Training" },
  { value: "Maintenance", label: "Maintenance" },
];

export default function AskOtoPage() {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<KbArticle | null>(null);
  const [showBrowse, setShowBrowse] = useState(false);
  const [browseSearch, setBrowseSearch] = useState("");
  const [browseType, setBrowseType] = useState("all");
  const [browseDepartment, setBrowseDepartment] = useState("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);

  const askMutation = useMutation({
    mutationFn: async (q: string) => {
      const res = await apiRequest("POST", "/api/ask-oto", { question: q });
      return res.json() as Promise<AskResponse>;
    },
    onSuccess: (data) => {
      setError(null);
      setResponse(data);
    },
    onError: (err: Error) => {
      setError(err.message || "Something went wrong. Please try again.");
    },
  });

  const { data: articles, isLoading: articlesLoading } = useQuery<KbArticle[]>({
    queryKey: ["/api/knowledge-base", { status: "published" }],
    enabled: showBrowse,
  });

  const { data: articleDetail } = useQuery<KbArticle>({
    queryKey: ["/api/knowledge-base", selectedArticle?.id],
    enabled: !!selectedArticle?.id,
  });

  const handleAsk = () => {
    if (!question.trim()) return;
    askMutation.mutate(question);
  };

  const handleExampleClick = (prompt: string) => {
    setQuestion(prompt);
    askMutation.mutate(prompt);
  };

  const filteredArticles = articles?.filter((article) => {
    const matchesSearch = browseSearch === "" || 
      article.title.toLowerCase().includes(browseSearch.toLowerCase());
    const matchesType = browseType === "all" || article.type === browseType;
    const matchesDept = browseDepartment === "all" || 
      (article.departments && article.departments.includes(browseDepartment));
    return matchesSearch && matchesType && matchesDept;
  });

  const clearResponse = () => {
    setResponse(null);
    setError(null);
    setQuestion("");
    inputRef.current?.focus();
  };

  return (
    <>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="mb-6 text-center">
          <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <MessageCircleQuestion className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold" data-testid="text-ask-oto-title">Ask OTO</h1>
          <p className="text-sm text-muted-foreground mt-1">How things work at the park</p>
        </div>

        {!response && !askMutation.isPending && (
          <>
            <Card className="mb-6">
              <CardContent className="p-4">
                <div className="flex gap-2">
                  <Input
                    ref={inputRef}
                    type="text"
                    placeholder="Ask OTO anything about the park..."
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                    className="flex-1"
                    data-testid="input-ask-question"
                  />
                  <Button 
                    onClick={handleAsk} 
                    disabled={!question.trim()}
                    data-testid="button-ask-submit"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="mb-6">
              <p className="text-sm text-muted-foreground mb-3">Try asking:</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => handleExampleClick(prompt)}
                    className="text-sm px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground hover-elevate transition-colors"
                    data-testid={`button-example-${i}`}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {askMutation.isPending && (
          <Card className="mb-6">
            <CardContent className="p-8 flex flex-col items-center justify-center">
              <Sparkles className="h-8 w-8 text-primary animate-pulse mb-3" />
              <p className="text-muted-foreground">Finding the answer...</p>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="mb-6 border-destructive">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-destructive">
                    {error}
                  </p>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="mt-2"
                    onClick={() => { setError(null); inputRef.current?.focus(); }}
                  >
                    Try Again
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {response && (
          <>
            <Card className="mb-4">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MessageCircleQuestion className="h-5 w-5 text-primary" />
                    <span className="font-medium text-sm">{question}</span>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={clearResponse}
                    data-testid="button-clear-response"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                
                {response.noMatch ? (
                  <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                        I couldn't find this in the park knowledge yet.
                      </p>
                      <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
                        Please ask your manager.
                      </p>
                    </div>
                  </div>
                ) : (
                  <Accordion 
                    type="single" 
                    collapsible 
                    defaultValue={response.checklist?.steps?.length ? "sop" : "answer"}
                    className="w-full"
                    data-testid="response-accordion"
                  >
                    {/* Quick Answer Mode */}
                    <AccordionItem value="answer" className="border-b">
                      <AccordionTrigger className="py-3 hover:no-underline" data-testid="accordion-answer">
                        <div className="flex items-center gap-2">
                          <Zap className="h-4 w-4 text-amber-500" />
                          <span className="text-sm font-medium">Quick Answer</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div 
                          className="prose prose-sm dark:prose-invert max-w-none pb-2"
                          data-testid="text-answer"
                        >
                          {response.answer.split('\n').map((line, i) => (
                            <p key={i} className="mb-2 last:mb-0">{line}</p>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>

                    {/* SOP Steps Mode */}
                    {response.checklist && response.checklist.steps.length > 0 && (
                      <AccordionItem value="sop" className="border-b">
                        <AccordionTrigger className="py-3 hover:no-underline" data-testid="accordion-sop">
                          <div className="flex items-center gap-2">
                            <ListChecks className="h-4 w-4 text-green-500" />
                            <span className="text-sm font-medium">Step-by-Step Guide</span>
                            <Badge variant="secondary" className="ml-2 text-xs">
                              {response.checklist.steps.length} steps
                            </Badge>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="pb-2" data-testid="interactive-checklist">
                            <InteractiveChecklist
                              title={response.checklist.title}
                              steps={response.checklist.steps}
                            />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    )}

                    {/* Sources Mode */}
                    {response.sources.length > 0 && (
                      <AccordionItem value="sources" className="border-0">
                        <AccordionTrigger className="py-3 hover:no-underline" data-testid="accordion-sources">
                          <div className="flex items-center gap-2">
                            <File className="h-4 w-4 text-blue-500" />
                            <span className="text-sm font-medium">Sources</span>
                            <Badge variant="outline" className="ml-2 text-xs">
                              {response.sources.length}
                            </Badge>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="flex flex-wrap gap-2 pb-2">
                            {response.sources.map((source) => (
                              <button
                                key={source.id}
                                onClick={() => setSelectedArticle({ id: source.id } as KbArticle)}
                                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover-elevate transition-colors"
                                data-testid={`button-source-${source.id}`}
                              >
                                {source.type === "SOP" ? (
                                  <ListChecks className="h-3.5 w-3.5" />
                                ) : source.type === "Document" ? (
                                  <FileText className="h-3.5 w-3.5" />
                                ) : (
                                  <BookOpen className="h-3.5 w-3.5" />
                                )}
                                <span className="max-w-[200px] truncate">{source.title}</span>
                                <Badge variant="outline" className="text-[10px] px-1 py-0">
                                  {source.type}
                                </Badge>
                              </button>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    )}

                    {/* Media Mode - Photos and Videos */}
                    {response.media && response.media.length > 0 && (
                      <AccordionItem value="media" className="border-0">
                        <AccordionTrigger className="py-3 hover:no-underline" data-testid="accordion-media">
                          <div className="flex items-center gap-2">
                            <ImageIcon className="h-4 w-4 text-purple-500" />
                            <span className="text-sm font-medium">Related Media</span>
                            <Badge variant="outline" className="ml-2 text-xs">
                              {response.media.length}
                            </Badge>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-2">
                            {response.media.map((media) => (
                              <div
                                key={media.id}
                                className="rounded-lg border overflow-hidden bg-muted/50"
                                data-testid={`media-${media.id}`}
                              >
                                {media.fileType === "image" ? (
                                  <img
                                    src={`/api/knowledge-files/${media.id}/media`}
                                    alt={media.title}
                                    className="w-full h-40 object-cover"
                                  />
                                ) : (
                                  <video
                                    src={`/api/knowledge-files/${media.id}/media`}
                                    controls
                                    className="w-full h-40 object-cover"
                                  />
                                )}
                                <div className="p-2 flex items-center gap-2">
                                  {media.fileType === "image" ? (
                                    <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                  ) : (
                                    <Video className="h-3.5 w-3.5 text-muted-foreground" />
                                  )}
                                  <span className="text-xs truncate">{media.title}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    )}
                  </Accordion>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <div className="border-t pt-6">
          <button
            onClick={() => setShowBrowse(!showBrowse)}
            className="flex items-center justify-between w-full p-3 rounded-lg bg-secondary/50 hover-elevate"
            data-testid="button-toggle-browse"
          >
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">Browse Knowledge Base</span>
            </div>
            <ChevronRight className={cn(
              "h-5 w-5 text-muted-foreground transition-transform",
              showBrowse && "rotate-90"
            )} />
          </button>

          {showBrowse && (
            <div className="mt-4 space-y-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search articles..."
                    value={browseSearch}
                    onChange={(e) => setBrowseSearch(e.target.value)}
                    className="pl-9"
                    data-testid="input-browse-search"
                  />
                </div>
              </div>
              
              <div className="flex gap-2">
                <Select value={browseDepartment} onValueChange={setBrowseDepartment}>
                  <SelectTrigger className="w-[180px]" data-testid="select-department">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Department" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map((dept) => (
                      <SelectItem key={dept.value} value={dept.value}>
                        {dept.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Select value={browseType} onValueChange={setBrowseType}>
                  <SelectTrigger className="w-[150px]" data-testid="select-type">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {ARTICLE_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {articlesLoading ? (
                <div className="flex justify-center py-8">
                  <LoadingSpinner />
                </div>
              ) : filteredArticles?.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No articles found</p>
              ) : (
                <div className="space-y-2">
                  {filteredArticles?.map((article) => (
                    <button
                      key={article.id}
                      onClick={() => setSelectedArticle(article)}
                      className="w-full text-left p-3 rounded-lg border hover-elevate flex items-center justify-between"
                      data-testid={`button-article-${article.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium truncate">{article.title}</h3>
                        <div className="flex gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">
                            {article.type}
                          </Badge>
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!selectedArticle} onOpenChange={(open) => !open && setSelectedArticle(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{articleDetail?.title || selectedArticle?.title}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            {articleDetail ? (
              <div 
                className="prose prose-sm dark:prose-invert max-w-none p-4"
                dangerouslySetInnerHTML={{ __html: articleDetail.content }}
              />
            ) : (
              <div className="flex justify-center py-8">
                <LoadingSpinner />
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
