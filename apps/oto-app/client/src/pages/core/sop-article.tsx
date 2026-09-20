import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { ArrowLeft, Share2, FileText } from "lucide-react";
import { Link } from "wouter";
import { 
  HeroCard, 
  InfoCallout, 
  ChecklistCard, 
  StepTimeline, 
  WarningCard, 
  HelpCard,
  ThreeColumnLayout,
  BodyContent,
  SectionDivider
} from "@/components/sop/sop-components";
import type { SopArticle } from "@shared/schema";

export default function SopArticlePage() {
  const { id } = useParams<{ id: string }>();

  const { data: article, isLoading } = useQuery<SopArticle>({
    queryKey: ["/api/sops", id],
  });

  if (isLoading || !article) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const extendedArticle = article as SopArticle & {
    readingTime?: number;
    coverImageUrl?: string;
    summary?: string;
    steps?: string[];
    rules?: string[];
    commonMistakes?: string[];
    unsureTips?: string[];
    ytdItems?: string[];
    todayItems?: string[];
    tmrItems?: string[];
  };

  const hasSteps = extendedArticle.steps && extendedArticle.steps.length > 0;
  const hasRules = extendedArticle.rules && extendedArticle.rules.length > 0;
  const hasMistakes = extendedArticle.commonMistakes && extendedArticle.commonMistakes.length > 0;
  const hasTips = extendedArticle.unsureTips && extendedArticle.unsureTips.length > 0;
  const hasThreeColumn = extendedArticle.ytdItems && extendedArticle.todayItems && extendedArticle.tmrItems;
  const hasBody = article.body && article.body.trim().length > 0;

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col bg-background">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <div className="flex items-center justify-between p-3 max-w-2xl mx-auto">
            <Link href="/find">
              <Button size="icon" variant="ghost" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <Button size="icon" variant="ghost" data-testid="button-share">
              <Share2 className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <article className="flex-1 pb-8 max-w-2xl mx-auto w-full">
          {extendedArticle.coverImageUrl && (
            <div className="h-40 w-full overflow-hidden">
              <img 
                src={extendedArticle.coverImageUrl} 
                alt={article.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="p-4">
            <HeroCard 
              title={article.title}
              departments={article.departments}
              readingTime={extendedArticle.readingTime}
              icon={<FileText className="h-7 w-7 text-primary" />}
            />

            {extendedArticle.summary && (
              <InfoCallout>
                {extendedArticle.summary}
              </InfoCallout>
            )}

            {hasThreeColumn && (
              <ThreeColumnLayout
                yesterday={extendedArticle.ytdItems!}
                today={extendedArticle.todayItems!}
                tomorrow={extendedArticle.tmrItems!}
              />
            )}

            {hasSteps && (
              <StepTimeline steps={extendedArticle.steps!} />
            )}

            {hasRules && (
              <ChecklistCard items={extendedArticle.rules!} />
            )}

            {hasMistakes && (
              <WarningCard items={extendedArticle.commonMistakes!} />
            )}

            {hasTips && (
              <HelpCard items={extendedArticle.unsureTips!} />
            )}

            {hasBody && (hasSteps || hasRules || hasMistakes || hasTips || extendedArticle.summary) && (
              <SectionDivider />
            )}

            {hasBody && (
              <BodyContent content={article.body} />
            )}
          </div>
        </article>
      </div>
    </AppLayout>
  );
}
