import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Circle, Lock, User, FileText, Send, PenTool, KeyRound, Camera, Package, AlertCircle, Loader2, ChevronDown, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface OnboardingStep {
  complete: boolean;
  label: string;
  description: string;
  unlocked?: boolean;
  [key: string]: any;
}

interface OnboardingStatus {
  employeeId: string;
  employeeName: string;
  isOnboardingComplete: boolean;
  steps: {
    step1_essentialInfo: OnboardingStep & { missingFields: string[] };
    step2_contractGenerated: OnboardingStep & { contractId: string | null; contractStatus: string | null };
    step3_contractSent: OnboardingStep & { hasSigningToken: boolean; sentAt: string | null };
    step4_contractSigned: OnboardingStep & { signingStatus: string | null; signedAt: string | null };
    step5_loginCreated: OnboardingStep & { provisioningStatus: string | null; coreUserId: string | null };
    step6_faceEnrollment: OnboardingStep & { faceEnrollmentStatus: string; hasActiveEnrollmentQr: boolean };
    step7_companyProperty: OnboardingStep & { assignedAssetsCount: number };
  };
  currentStep: number;
}

interface EmployeeOnboardingStepperProps {
  employeeId: string;
  variant?: "panel" | "inline";
  onGenerateContract?: () => void;
  onSendContract?: () => void;
  onCreateLogin?: () => void;
  onEnrollFace?: () => void;
  onAssignAsset?: () => void;
  showActions?: boolean;
  onGoToStep?: (stepNum: number) => void;
}

const stepIcons = [User, FileText, Send, PenTool, KeyRound, Camera, Package];

const stepLabels = [
  "Essential Info",
  "Contract Created",
  "Contract Sent",
  "Contract Signed",
  "Login Created",
  "Enroll Face",
  "Property Assigned",
];

const stepColors: { bg: string; border: string; text: string }[] = [
  { bg: "bg-blue-500/10", border: "border-l-blue-500", text: "text-blue-600 dark:text-blue-400" },
  { bg: "bg-purple-500/10", border: "border-l-purple-500", text: "text-purple-600 dark:text-purple-400" },
  { bg: "bg-purple-500/10", border: "border-l-purple-500", text: "text-purple-600 dark:text-purple-400" },
  { bg: "bg-purple-500/10", border: "border-l-purple-500", text: "text-purple-600 dark:text-purple-400" },
  { bg: "bg-violet-500/10", border: "border-l-violet-500", text: "text-violet-600 dark:text-violet-400" },
  { bg: "bg-pink-500/10", border: "border-l-pink-500", text: "text-pink-600 dark:text-pink-400" },
  { bg: "bg-orange-500/10", border: "border-l-orange-500", text: "text-orange-600 dark:text-orange-400" },
];

export function EmployeeOnboardingStepper({
  employeeId,
  variant = "panel",
  onGenerateContract,
  onSendContract,
  onCreateLogin,
  onEnrollFace,
  onAssignAsset,
  showActions = true,
  onGoToStep,
}: EmployeeOnboardingStepperProps) {
  const [isOpen, setIsOpen] = useState(true);
  
  const { data: status, isLoading, error } = useQuery<OnboardingStatus>({
    queryKey: ["/api/employees", employeeId, "onboarding-status"],
    enabled: !!employeeId,
  });

  // Auto-collapse when onboarding is 100% complete
  useEffect(() => {
    if (status?.isOnboardingComplete) {
      setIsOpen(false);
    }
  }, [status?.isOnboardingComplete]);

  if (!employeeId) {
    return null;
  }

  if (isLoading) {
    return (
      <Card className={cn(variant === "panel" ? "h-fit" : "")}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading onboarding status...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !status) {
    return (
      <Card className={cn(variant === "panel" ? "h-fit" : "")}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            Error loading onboarding status
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const steps = [
    { ...status.steps.step1_essentialInfo, stepNum: 1 },
    { ...status.steps.step2_contractGenerated, stepNum: 2 },
    { ...status.steps.step3_contractSent, stepNum: 3 },
    { ...status.steps.step4_contractSigned, stepNum: 4 },
    { ...status.steps.step5_loginCreated, stepNum: 5 },
    { ...status.steps.step6_faceEnrollment, stepNum: 6 },
    { ...status.steps.step7_companyProperty, stepNum: 7 },
  ];

  const completedCount = steps.filter((s) => s.complete).length;
  const progress = Math.round((completedCount / 7) * 100);

  const getStepAction = (stepNum: number, step: typeof steps[number]) => {
    if (!showActions || step.complete) return null;
    if (step.unlocked === false) return null;

    switch (stepNum) {
      case 2:
        return onGenerateContract ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onGenerateContract}
            data-testid="button-generate-contract"
          >
            Create Contract
          </Button>
        ) : null;
      case 3:
        return onSendContract && status.steps.step2_contractGenerated.contractId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onSendContract}
            data-testid="button-send-contract"
          >
            Generate Link
          </Button>
        ) : null;
      case 5:
        return onCreateLogin ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onCreateLogin}
            data-testid="button-create-login"
          >
            Create Login
          </Button>
        ) : null;
      case 6:
        return onEnrollFace ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onEnrollFace}
            data-testid="button-enroll-face"
          >
            {status.steps.step6_faceEnrollment.hasActiveEnrollmentQr ? "View QR" : "Generate QR"}
          </Button>
        ) : null;
      case 7:
        return onAssignAsset ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onAssignAsset}
            data-testid="button-assign-asset"
          >
            Assign Property
          </Button>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className={cn(variant === "panel" ? "h-fit" : "")} data-testid="card-onboarding-progress">
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-3 cursor-pointer hover-elevate">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Onboarding Progress</CardTitle>
                <ChevronDown className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform duration-200",
                  isOpen && "rotate-180"
                )} />
              </div>
              <Badge
                variant={status.isOnboardingComplete ? "default" : "secondary"}
                className={cn(
                  status.isOnboardingComplete && "bg-green-600 hover:bg-green-700"
                )}
              >
                {progress}% Complete
              </Badge>
            </div>
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden mt-2">
              <div
                className={cn(
                  "h-full transition-all duration-500",
                  status.isOnboardingComplete ? "bg-green-600" : "bg-primary"
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="space-y-1">
              {steps.map((step, idx) => {
                const Icon = stepIcons[idx];
                const isLocked = step.unlocked === false;
                const isCurrent = status.currentStep === idx + 1;

                const color = stepColors[idx];

                return (
                  <div
                    key={idx}
                    className={cn(
                      "flex items-center gap-3 p-2 rounded-md border-l-4 transition-colors",
                      !isLocked && color.border + " " + color.bg,
                      step.complete && "opacity-75",
                      isLocked && "border-l-muted bg-transparent opacity-60"
                    )}
                    data-testid={`step-${idx + 1}-${step.complete ? "complete" : "incomplete"}`}
                  >
                    <div
                      className={cn(
                        "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center",
                        step.complete && "bg-green-600 text-white",
                        !step.complete && !isLocked && color.text + " bg-background border border-current",
                        isLocked && "bg-muted text-muted-foreground"
                      )}
                    >
                      {step.complete ? (
                        <Check className="h-4 w-4" />
                      ) : isLocked ? (
                        <Lock className="h-3 w-3" />
                      ) : (
                        <Icon className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className={cn(
                          "text-sm font-medium truncate",
                          isLocked && "text-muted-foreground"
                        )}
                      >
                        {stepLabels[idx]}
                      </p>
                      {isCurrent && !step.complete && step.description && (
                        <p className="text-xs text-muted-foreground truncate">
                          {step.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {getStepAction(idx + 1, step)}
                      {!step.complete && !isLocked && onGoToStep && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onGoToStep(idx + 1)}
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          data-testid={`button-goto-step-${idx + 1}`}
                        >
                          Go to
                          <ArrowRight className="ml-1 h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
