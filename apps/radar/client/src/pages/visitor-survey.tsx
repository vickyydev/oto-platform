import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, ArrowLeft, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  visitorTypes,
  discoveryChannels,
  type VisitorType,
  type DiscoveryChannel,
  type VisitorSurveyBranch,
} from "@shared/schema";

const VISITOR_LABELS: Record<VisitorType, { label: string; emoji: string }> = {
  Tourist: { label: "Tourist", emoji: "🏖️" },
  Expat: { label: "Expat", emoji: "🌍" },
  WinterBird: { label: "Seasonal Resident", emoji: "❄️" },
  Thai: { label: "Thai", emoji: "🇹🇭" },
};

const CHANNEL_LABELS: Record<DiscoveryChannel, { label: string; emoji: string }> = {
  Booth: { label: "Sales Booth", emoji: "🎪" },
  WordOfMouth: { label: "Word of Mouth", emoji: "💬" },
  Google: { label: "Google", emoji: "🔎" },
  Aquarium: { label: "Aquarium", emoji: "🐠" },
  Meta: { label: "Facebook/Instagram", emoji: "📱" },
};

const STORAGE_KEY = "visitor_survey_branch";

type Step = "visitor" | "channel" | "thanks";

export default function VisitorSurveyPage() {
  const { data: branches } = useQuery<Array<{ key: VisitorSurveyBranch; name: string }>>({
    queryKey: ["/api/visitor-survey/branches"],
  });

  const [branch, setBranch] = useState<VisitorSurveyBranch | null>(null);
  const [step, setStep] = useState<Step>("visitor");
  const [visitorType, setVisitorType] = useState<VisitorType | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "floresta" || saved === "chalong") setBranch(saved);
    } catch {}
  }, []);

  const setBranchPersist = (b: VisitorSurveyBranch) => {
    setBranch(b);
    try {
      localStorage.setItem(STORAGE_KEY, b);
    } catch {}
  };

  const submitMutation = useMutation({
    mutationFn: async (payload: {
      branch: VisitorSurveyBranch;
      visitorType: VisitorType;
      discoveryChannel: DiscoveryChannel;
    }) => {
      const res = await apiRequest("POST", "/api/visitor-survey", payload);
      return res.json();
    },
    onSuccess: () => {
      setStep("thanks");
      setTimeout(() => {
        setVisitorType(null);
        setStep("visitor");
      }, 1500);
    },
  });

  const reset = () => {
    setVisitorType(null);
    setStep("visitor");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white dark:from-slate-950 dark:to-slate-900 flex flex-col">
      <header className="px-4 py-3 border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-md mx-auto">
          <h1 className="text-base font-semibold text-center" data-testid="text-survey-title">
            Welcome! Quick visit survey
          </h1>
          <div className="mt-2 flex gap-2" data-testid="branch-toggle">
            {(branches ?? []).map((b) => (
              <button
                key={b.key}
                onClick={() => setBranchPersist(b.key)}
                className={cn(
                  "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors border",
                  branch === b.key
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700",
                )}
                data-testid={`button-branch-${b.key}`}
              >
                <MapPin className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                {b.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 flex flex-col">
        <div className="max-w-md mx-auto w-full flex-1 flex flex-col">
          {!branch && (
            <div className="text-center text-slate-500 mt-12" data-testid="text-select-branch">
              Please select a branch above to begin.
            </div>
          )}

          {branch && step === "visitor" && (
            <section className="flex flex-col gap-3" data-testid="section-visitor-type">
              <h2 className="text-xl font-semibold text-center mb-2">Who are you?</h2>
              {visitorTypes.map((vt) => (
                <Button
                  key={vt}
                  size="lg"
                  variant="outline"
                  className="h-20 text-lg justify-start gap-3"
                  onClick={() => {
                    setVisitorType(vt);
                    setStep("channel");
                  }}
                  data-testid={`button-visitor-${vt}`}
                >
                  <span className="text-3xl">{VISITOR_LABELS[vt].emoji}</span>
                  <span>{VISITOR_LABELS[vt].label}</span>
                </Button>
              ))}
            </section>
          )}

          {branch && step === "channel" && visitorType && (
            <section className="flex flex-col gap-3" data-testid="section-channel">
              <div className="flex items-center justify-between mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={reset}
                  data-testid="button-back"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                <span className="text-xs text-slate-500" data-testid="text-selected-visitor">
                  {VISITOR_LABELS[visitorType].emoji} {VISITOR_LABELS[visitorType].label}
                </span>
              </div>
              <h2 className="text-xl font-semibold text-center mb-2">
                How did you find out about us?
              </h2>
              {discoveryChannels.map((ch) => (
                <Button
                  key={ch}
                  size="lg"
                  variant="outline"
                  className="h-20 text-lg justify-start gap-3"
                  disabled={submitMutation.isPending}
                  onClick={() =>
                    submitMutation.mutate({
                      branch,
                      visitorType,
                      discoveryChannel: ch,
                    })
                  }
                  data-testid={`button-channel-${ch}`}
                >
                  <span className="text-3xl">{CHANNEL_LABELS[ch].emoji}</span>
                  <span>{CHANNEL_LABELS[ch].label}</span>
                </Button>
              ))}
              {submitMutation.isPending && (
                <div className="flex items-center justify-center gap-2 text-slate-500 mt-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </div>
              )}
              {submitMutation.isError && (
                <div className="text-center text-red-500 text-sm" data-testid="text-error">
                  Could not save. Please try again.
                </div>
              )}
            </section>
          )}

          {branch && step === "thanks" && (
            <section
              className="flex-1 flex flex-col items-center justify-center text-center"
              data-testid="section-thanks"
            >
              <CheckCircle2 className="h-20 w-20 text-green-500 mb-4" />
              <h2 className="text-2xl font-semibold mb-1">Thank you!</h2>
              <p className="text-slate-500">Your response has been recorded.</p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
