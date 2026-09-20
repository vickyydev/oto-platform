import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { BookOpen, CheckCircle, Play, RotateCcw, Award, Book, ExternalLink, GraduationCap, Target, Clock } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import type { TrainingModule, ModuleCompletion, QuizAttempt } from "@shared/schema";

const EXTERNAL_RESOURCES = [
  {
    title: "Franchise Guidebook",
    description: "Complete operations manual and training materials",
    url: "https://franchise-guidebook--revthebellphuke.replit.app",
    icon: Book,
  },
];

interface ModuleWithProgress extends TrainingModule {
  completion?: ModuleCompletion | null;
  bestAttempt?: QuizAttempt | null;
  questionCount: number;
}

export default function LearnPage() {
  const { user } = useAuth();

  const { data: modules, isLoading } = useQuery<ModuleWithProgress[]>({
    queryKey: ["/api/training/modules"],
    enabled: !!user,
  });

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const completedCount = modules?.filter((m) => m.completion).length || 0;
  const totalCount = modules?.length || 0;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <GraduationCap className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Learn</h1>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Complete training modules and pass quizzes (70% required)
          </p>
        </div>

        {totalCount > 0 && (
          <Card className="mb-6 bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 rounded-xl bg-primary flex items-center justify-center">
                  <Award className="h-7 w-7 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-lg">Your Progress</p>
                  <p className="text-sm text-muted-foreground">
                    {completedCount} of {totalCount} modules completed
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-bold text-primary">{Math.round(progressPercent)}%</p>
                </div>
              </div>
              <Progress value={progressPercent} className="mt-4 h-2" />
              {completedCount === totalCount && totalCount > 0 && (
                <div className="flex items-center gap-2 mt-3 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  <span className="font-medium">All modules completed!</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <div className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">RESOURCES</h2>
          <div className="grid gap-3">
            {EXTERNAL_RESOURCES.map((resource) => (
              <a
                key={resource.url}
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`resource-${resource.title.toLowerCase().replace(/\s/g, '-')}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <resource.icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold">{resource.title}</h3>
                        <p className="text-sm text-muted-foreground">{resource.description}</p>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </div>

        <h2 className="text-sm font-semibold text-muted-foreground mb-3">TRAINING MODULES</h2>
        <div className="space-y-4">
          {!modules || modules.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No training modules"
              description="Training content will appear here once available."
            />
          ) : (
            modules.map((module) => {
              const hasAttempt = module.bestAttempt !== null && module.bestAttempt !== undefined;
              const scorePercent = hasAttempt 
                ? Math.round((module.bestAttempt!.score / module.bestAttempt!.totalQuestions) * 100)
                : 0;
              
              return (
                <Card 
                  key={module.id} 
                  className={`overflow-visible ${module.completion ? 'border-green-500/30' : ''}`} 
                  data-testid={`card-module-${module.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold">{module.title}</h3>
                          {module.completion && (
                            <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30">
                              <CheckCircle className="h-3 w-3 mr-1" />
                              Passed
                            </Badge>
                          )}
                        </div>
                        {module.description && (
                          <p className="text-sm text-muted-foreground mb-3">{module.description}</p>
                        )}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Target className="h-3 w-3" />
                            {module.questionCount} questions
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            ~{Math.ceil(module.questionCount * 0.5)} min
                          </span>
                          {hasAttempt && (
                            <span className={`font-medium ${scorePercent >= 70 ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
                              Best: {scorePercent}%
                            </span>
                          )}
                        </div>
                      </div>
                      <Link href={`/learn/${module.id}`}>
                        <Button 
                          variant={module.completion ? "outline" : "default"}
                          className="shrink-0"
                          data-testid={`button-module-${module.id}`}
                        >
                          {module.completion ? (
                            <>
                              <RotateCcw className="mr-2 h-4 w-4" />
                              Review
                            </>
                          ) : (
                            <>
                              <Play className="mr-2 h-4 w-4" />
                              Start
                            </>
                          )}
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </AppLayout>
  );
}
