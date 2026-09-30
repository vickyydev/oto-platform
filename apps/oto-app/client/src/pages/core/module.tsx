import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, ArrowRight, CheckCircle, XCircle, RotateCcw, Trophy } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { TrainingModule, QuizQuestion } from "@shared/schema";

interface ModuleWithQuestions extends TrainingModule {
  questions: Omit<QuizQuestion, "correctAnswer">[];
}

export default function ModulePage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [phase, setPhase] = useState<"content" | "quiz" | "results">("content");
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [quizResult, setQuizResult] = useState<{ score: number; total: number; passed: boolean } | null>(null);

  const { data: module, isLoading } = useQuery<ModuleWithQuestions>({
    queryKey: ["/api/training/modules", id],
  });

  const submitQuizMutation = useMutation({
    mutationFn: async (data: { answers: Record<string, number> }) => {
      const res = await apiRequest("POST", `/api/training/modules/${id}/quiz`, data);
      return res.json();
    },
    onSuccess: (data) => {
      setQuizResult(data);
      setPhase("results");
      queryClient.invalidateQueries({ queryKey: ["/api/training/modules"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to submit quiz",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading || !module) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const questions = [...module.questions].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleStartQuiz = () => {
    if (questions.length === 0) {
      submitQuizMutation.mutate({ answers: {} });
      return;
    }
    setPhase("quiz");
    setCurrentQuestion(0);
    setAnswers({});
  };

  const handleAnswer = (questionId: string, answerIndex: number) => {
    setAnswers({ ...answers, [questionId]: answerIndex });
  };

  const handleNext = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
    } else {
      submitQuizMutation.mutate({ answers });
    }
  };

  const handleRetry = () => {
    setPhase("quiz");
    setCurrentQuestion(0);
    setAnswers({});
    setQuizResult(null);
  };

  return (
      <AppLayout>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <Link href="/core/learn">
              <Button size="icon" variant="ghost" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold truncate">{module.title}</h1>
              <p className="text-sm text-muted-foreground capitalize">{phase}</p>
            </div>
          </div>
          {phase === "quiz" && (
            <div className="max-w-lg mx-auto mt-3">
              <Progress value={((currentQuestion + 1) / questions.length) * 100} className="h-2" />
              <p className="text-xs text-muted-foreground text-center mt-1">
                Question {currentQuestion + 1} of {questions.length}
              </p>
            </div>
          )}
        </div>

        <div className="flex-1 p-4 pb-24 max-w-lg mx-auto w-full">
          {phase === "content" && (
            <div className="space-y-6">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <div className="whitespace-pre-wrap">{module.content}</div>
              </div>
              <Button 
                className="w-full h-12" 
                onClick={handleStartQuiz}
                data-testid="button-start-quiz"
              >
                {questions.length ? `Start Quiz (${questions.length} questions)` : "Complete module"}
              </Button>
            </div>
          )}

          {phase === "quiz" && questions[currentQuestion] && (
            <div className="space-y-6">
              <Card>
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold mb-4">
                    {questions[currentQuestion].question}
                  </h2>
                  <RadioGroup
                    value={answers[questions[currentQuestion].id]?.toString() || ""}
                    onValueChange={(value) => handleAnswer(questions[currentQuestion].id, parseInt(value))}
                    className="space-y-3"
                  >
                    {questions[currentQuestion].options.map((option, index) => (
                      <div
                        key={index}
                        className={cn(
                          "flex items-center space-x-3 p-4 rounded-lg border transition-colors",
                          answers[questions[currentQuestion].id] === index 
                            ? "border-primary bg-primary/5" 
                            : "border-border hover:bg-muted/50"
                        )}
                      >
                        <RadioGroupItem 
                          value={index.toString()} 
                          id={`option-${index}`}
                          data-testid={`radio-option-${index}`}
                        />
                        <Label 
                          htmlFor={`option-${index}`} 
                          className="flex-1 cursor-pointer text-base"
                        >
                          {option}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </CardContent>
              </Card>

              <Button
                className="w-full h-12"
                disabled={answers[questions[currentQuestion].id] === undefined || submitQuizMutation.isPending}
                onClick={handleNext}
                data-testid="button-next-question"
              >
                {currentQuestion < questions.length - 1 ? (
                  <>
                    Next Question
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                ) : (
                  "Submit Quiz"
                )}
              </Button>
            </div>
          )}

          {phase === "results" && quizResult && (
            <div className="text-center space-y-6">
              <div className={cn(
                "h-24 w-24 mx-auto rounded-full flex items-center justify-center",
                quizResult.passed ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30"
              )}>
                {quizResult.passed ? (
                  <Trophy className="h-12 w-12 text-green-600 dark:text-green-400" />
                ) : (
                  <XCircle className="h-12 w-12 text-red-600 dark:text-red-400" />
                )}
              </div>

              <div>
                <h2 className="text-2xl font-bold mb-2">
                  {quizResult.passed ? "Congratulations!" : "Not Quite"}
                </h2>
                <p className="text-muted-foreground">
                  {quizResult.total
                    ? `You scored ${quizResult.score} out of ${quizResult.total}`
                    : "Module complete"}
                </p>
              </div>

              <div className="text-6xl font-bold">
                    {quizResult.total ? Math.round((quizResult.score / quizResult.total) * 100) : 100}%
              </div>

              <div className="space-y-3">
                {!quizResult.passed && (
                  <Button 
                    className="w-full h-12" 
                    onClick={handleRetry}
                    data-testid="button-retry-quiz"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Try Again
                  </Button>
                )}
                <Link href="/core/learn">
                  <Button 
                    variant={quizResult.passed ? "default" : "secondary"} 
                    className="w-full h-12"
                    data-testid="button-back-to-modules"
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Back to Modules
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
