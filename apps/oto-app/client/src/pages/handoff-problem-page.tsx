import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { HandoffProblem } from "@/lib/platform-handoff";

/**
 * What the person sees when the launcher sent them here and the app could not
 * sign them in (S2-17a).
 *
 * It exists instead of falling back to the sign-in form, which is what every
 * silent failure does and which tells the reader nothing: the commonest reason
 * to land here is that an administrator has granted the tile but has not said
 * which OTO App user this person is, and no amount of typing a password fixes
 * that. So the sentence names the thing that has to happen, and the sign-in
 * form is one click away for the cases where it is the right answer.
 *
 * Same frame as the sign-in screen — the black ground, the logo, one card — so
 * it reads as this app rather than as a browser error.
 */
export default function HandoffProblemPage({ problem }: { problem: HandoffProblem }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-black p-8">
      <Card className="w-full max-w-md" data-testid="card-handoff-problem">
        <CardHeader className="space-y-1">
          <div className="flex items-center mb-2">
            <img src="/oto-logo.png" alt="OTO" className="h-10 w-auto" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <h1 className="text-lg font-semibold" data-testid="text-handoff-problem-title">
            {problem.title}
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-handoff-problem-detail">
            {problem.detail}
          </p>
          <Button
            className="w-full"
            data-testid="button-handoff-continue"
            onClick={() => window.location.assign("/")}
          >
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
