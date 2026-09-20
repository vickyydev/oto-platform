import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import {
  UtensilsCrossed,
  Check,
  Loader2,
  CalendarDays,
  PartyPopper,
  AlertCircle,
} from "lucide-react";

type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean };

type GroupSelection = {
  groupId: string;
  chosenOptions: string[];
};

export default function MenuSelectPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const { data, isLoading, error } = useQuery<{
    isSubmitted: boolean;
    submittedAt: string | null;
    selections: GroupSelection[] | null;
    template: { id: string; name: string; items: SetMenuTemplateItem[] };
    event: { title: string; childName: string | null; eventDate: string } | null;
  }>({
    queryKey: ["/api/beo/set-menu-selections/public", token],
    queryFn: async () => {
      const res = await fetch(`/api/beo/set-menu-selections/public/${token}`);
      if (!res.ok) throw new Error("Invalid or expired link");
      return res.json();
    },
    enabled: !!token,
    retry: false,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const payload: GroupSelection[] = Object.entries(selections).map(([groupId, chosenOptions]) => ({
        groupId,
        chosenOptions,
      }));
      const res = await apiRequest("POST", `/api/beo/set-menu-selections/public/${token}/submit`, {
        selections: payload,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (err: Error) => {
      toast({ title: "Submission failed", description: err.message, variant: "destructive" });
    },
  });

  const handleToggleOption = (groupId: string, option: string, allowMultiple: boolean) => {
    setSelections((prev) => {
      const current = prev[groupId] || [];
      if (allowMultiple) {
        const updated = current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option];
        return { ...prev, [groupId]: updated };
      } else {
        return { ...prev, [groupId]: [option] };
      }
    });
  };

  const handleSubmit = () => {
    if (!data) return;
    const choiceGroups = (data.template.items || []).filter((i) => i.type === "choice_group") as Extract<
      SetMenuTemplateItem,
      { type: "choice_group" }
    >[];
    for (const group of choiceGroups) {
      const chosen = selections[group.id] || [];
      if (chosen.length === 0) {
        toast({ title: "Please make a selection", description: `"${group.label}" requires a selection.`, variant: "destructive" });
        return;
      }
    }
    submitMutation.mutate();
  };

  if (isLoading) return <LoadingScreen />;

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-pink-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
        <Card className="max-w-sm w-full">
          <CardContent className="pt-8 pb-8 text-center space-y-3">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold">Link Not Found</h2>
            <p className="text-sm text-muted-foreground">
              This link is invalid or has expired. Please contact the venue for a new link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isAlreadySubmitted = data.isSubmitted || submitted;

  const templateItems = (data.template.items || []) as SetMenuTemplateItem[];
  const alwaysIncluded = templateItems.filter((i) => i.type === "always_included") as Extract<
    SetMenuTemplateItem,
    { type: "always_included" }
  >[];
  const choiceGroups = templateItems.filter((i) => i.type === "choice_group") as Extract<
    SetMenuTemplateItem,
    { type: "choice_group" }
  >[];

  const eventDate = data.event?.eventDate
    ? (() => {
        const d = new Date(data.event!.eventDate + "T00:00:00");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
      })()
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-pink-50 dark:from-gray-900 dark:to-gray-800 flex flex-col items-center p-4 py-8">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center space-y-2 mb-6">
          <div className="flex items-center justify-center gap-2 mb-2">
            <PartyPopper className="h-7 w-7 text-orange-500" />
          </div>
          {data.event?.childName && (
            <h1 className="text-2xl font-bold">{data.event.childName}'s Birthday</h1>
          )}
          {eventDate && (
            <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{eventDate}</span>
            </div>
          )}
          <div className="flex items-center justify-center gap-2">
            <UtensilsCrossed className="h-4 w-4 text-emerald-500" />
            <span className="font-medium text-sm">{data.template.name}</span>
          </div>
        </div>

        {isAlreadySubmitted ? (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-3">
              <div className="h-14 w-14 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                <Check className="h-7 w-7 text-emerald-500" />
              </div>
              <h2 className="text-lg font-semibold">Selections Received!</h2>
              <p className="text-sm text-muted-foreground">
                Thank you! Your menu selections have been sent to the team. We'll take care of the rest.
              </p>
              {data.submittedAt && (
                <p className="text-xs text-muted-foreground">
                  Submitted on {new Date(data.submittedAt).toLocaleDateString()}
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            {alwaysIncluded.length > 0 && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-xs">
                      Included
                    </Badge>
                    <span className="text-sm font-medium">Always Included</span>
                  </div>
                  <ul className="space-y-1">
                    {alwaysIncluded.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 text-sm py-0.5">
                        <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        <span>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {choiceGroups.map((group) => {
              const chosen = selections[group.id] || [];
              return (
                <Card key={group.id}>
                  <CardContent className="pt-5 pb-5 space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/30 text-xs">
                          Your Choice
                        </Badge>
                        {group.allowMultiple && (
                          <span className="text-xs text-muted-foreground">Select all that apply</span>
                        )}
                      </div>
                      <p className="font-medium text-sm">{group.label}</p>
                    </div>
                    {group.allowMultiple ? (
                      <div className="space-y-2">
                        {group.options.map((opt) => (
                          <div key={opt} className="flex items-center gap-2">
                            <Checkbox
                              id={`${group.id}-${opt}`}
                              checked={chosen.includes(opt)}
                              onCheckedChange={() => handleToggleOption(group.id, opt, true)}
                            />
                            <Label htmlFor={`${group.id}-${opt}`} className="text-sm cursor-pointer font-normal">
                              {opt}
                            </Label>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <RadioGroup
                        value={chosen[0] || ""}
                        onValueChange={(v) => handleToggleOption(group.id, v, false)}
                      >
                        <div className="space-y-2">
                          {group.options.map((opt) => (
                            <div key={opt} className="flex items-center gap-2">
                              <RadioGroupItem value={opt} id={`${group.id}-${opt}`} />
                              <Label htmlFor={`${group.id}-${opt}`} className="text-sm cursor-pointer font-normal">
                                {opt}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </RadioGroup>
                    )}
                  </CardContent>
                </Card>
              );
            })}

            <Button
              className="w-full"
              size="lg"
              onClick={handleSubmit}
              disabled={submitMutation.isPending}
              data-testid="button-submit-menu-selections"
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Confirm My Selections
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
