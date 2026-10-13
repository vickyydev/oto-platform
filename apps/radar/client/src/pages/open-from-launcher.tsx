import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * What a private Radar page shows to someone who is not signed in (S2-18).
 *
 * Radar has no sign-in form of its own: the platform session is the identity
 * and the launcher is the only way in. So this names that way, and — when the
 * launcher's hand-off itself was refused — what went wrong with it.
 */
export default function OpenFromLauncherPage({
  title = "Open Radar from the OTO launcher",
  detail = "Radar opens from the launcher: sign in there and choose the Radar tile, and you will land here signed in.",
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-8">
      <Card className="w-full max-w-md" data-testid="card-open-from-launcher">
        <CardHeader className="space-y-1">
          <div className="flex items-center mb-2">
            <img src="/oto-logo.png" alt="OTO" className="h-10 w-auto" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <h1 className="text-lg font-semibold" data-testid="text-open-from-launcher-title">
            {title}
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-open-from-launcher-detail">
            {detail}
          </p>
          <Button
            className="w-full"
            variant="outline"
            data-testid="button-open-from-launcher-retry"
            onClick={() => window.location.assign(window.location.pathname)}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
