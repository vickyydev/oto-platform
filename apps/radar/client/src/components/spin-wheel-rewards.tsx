import { Gift, LockKeyhole, Sparkles } from "lucide-react";

export type SpinWheelReward = {
  prizeId: string;
  campaignId: string;
  displayName: string;
  active: boolean;
  customerValue?: string | number | null;
  title?: string | null;
  instructions?: string | null;
  terms?: string | null;
};

type SpinWheelRewardsProps = {
  rewards?: SpinWheelReward[];
  isLoading: boolean;
  error?: unknown;
};

function text(value: string | number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

export function SpinWheelRewards({ rewards, isLoading, error }: SpinWheelRewardsProps) {
  if (isLoading) {
    return (
      <section aria-labelledby="spin-wheel-prizes-heading" className="space-y-3">
        <div>
          <h2 id="spin-wheel-prizes-heading" className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Spin Wheel prizes
          </h2>
          <p className="text-xs text-muted-foreground mt-1">Loading the current prize instructions…</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-xl border bg-card animate-pulse" aria-hidden />
          ))}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section aria-labelledby="spin-wheel-prizes-heading" className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/20">
        <h2 id="spin-wheel-prizes-heading" className="font-semibold text-rose-900 dark:text-rose-200">
          Prize details unavailable
        </h2>
        <p className="mt-1 text-sm text-rose-800 dark:text-rose-300">
          The redemption form is still available, but current customer instructions could not be loaded.
        </p>
      </section>
    );
  }

  const orderedRewards = rewards ?? [];
  const activeRewards = orderedRewards.filter((reward) => reward.active);
  const unavailableRewards = orderedRewards.filter((reward) => !reward.active);
  // Keep the disabled slot visible even while an older bridge only returns
  // active rewards. It has no customer-facing instructions until the API
  // explicitly activates and describes it.
  if (!unavailableRewards.some((reward) => reward.prizeId === "mystery-gift")) {
    unavailableRewards.push({
      prizeId: "mystery-gift",
      campaignId: "",
      displayName: "Mystery Gift",
      active: false,
    });
  }

  return (
    <section aria-labelledby="spin-wheel-prizes-heading" className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" aria-hidden />
          <h2 id="spin-wheel-prizes-heading" className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Spin Wheel prizes
          </h2>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          The active rewards and customer-facing wording currently configured for Spin Wheel.
        </p>
      </div>

      {activeRewards.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {activeRewards.map((reward) => {
            const customerValue = text(reward.customerValue);
            const title = text(reward.title);
            const instructions = text(reward.instructions);
            const terms = text(reward.terms);
            return (
              <article key={reward.prizeId} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-lg bg-amber-100 p-2 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    <Gift className="h-4 w-4" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold leading-tight">{reward.displayName}</h3>
                    {customerValue && (
                      <p className="mt-1 text-sm font-bold text-emerald-700 dark:text-emerald-400">
                        {customerValue}
                      </p>
                    )}
                  </div>
                </div>
                {title && <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">{title}</p>}
                {instructions && <p className="mt-1 text-sm text-muted-foreground">{instructions}</p>}
                {terms && (
                  <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                    <span className="font-semibold">Terms:</span> {terms}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          No active Spin Wheel rewards are available.
        </p>
      )}

      {unavailableRewards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {unavailableRewards.map((reward) => (
            <article
              key={reward.prizeId}
              className="rounded-xl border border-dashed bg-muted/40 p-4 text-muted-foreground"
              aria-label={`${reward.displayName}, unavailable`}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-muted p-2">
                  <LockKeyhole className="h-4 w-4" aria-hidden />
                </div>
                <div>
                  <h3 className="font-semibold">{reward.displayName}</h3>
                  <p className="text-xs font-semibold uppercase tracking-wide">Unavailable</p>
                </div>
              </div>
              <p className="mt-3 text-xs">This reward is disabled and cannot be issued.</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}