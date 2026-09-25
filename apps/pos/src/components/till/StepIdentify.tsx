import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Member, OtoEvent } from '@/types';
import { resolveAutoTier, tierLabel } from '@/lib/membership';
import { EventPassCard } from '@/components/till/EventPassCard';
import { Smartphone, User, Loader2, IdCard, QrCode, Ticket, BadgeCheck, Baby } from 'lucide-react';

interface StepIdentifyProps {
  phone: string;
  nickname: string;
  /** Member resolved from the entered phone (null while unknown / no phone). */
  member?: Member | null;
  onSkip: () => void;
  onRedeemBooking?: () => void;
  /** Active camp/event passes for today, sold at a flat entry price (no tier). */
  eventPasses?: OtoEvent[];
  onSellEventPass?: (event: OtoEvent) => void;
}

export function StepIdentify({
  phone,
  nickname,
  member,
  onSkip,
  onRedeemBooking,
  eventPasses = [],
  onSellEventPass,
}: StepIdentifyProps) {
  const savedChildren = member?.savedChildren ?? [];
  const autoTier = member ? resolveAutoTier(member) : null;

  return (
    <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="mb-6 shrink-0">
        <h2 className="text-3xl font-bold tracking-tight">Membership Check</h2>
        <p className="text-muted-foreground mt-2 text-lg">
          The customer is entering their phone on their display to apply any verified rate.
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0 -mx-2 px-2">
        {member ? (
          /* Recognised member — identity + tier + saved children shown in place. */
          <div className="flex flex-col items-center text-center py-6">
            <div className="flex items-center gap-4 rounded-xl border bg-card p-4 w-full max-w-xl text-left">
              <div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center text-primary font-bold text-xl shrink-0">
                {member.nickname.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-lg truncate">{member.nickname}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-2.5 py-0.5 text-xs font-bold">
                    <BadgeCheck className="w-3.5 h-3.5" />
                    Member
                  </span>
                </div>
                <div className="text-sm text-muted-foreground truncate">{member.phone}</div>
                {autoTier && (
                  <div className="text-sm text-muted-foreground mt-0.5">
                    {tierLabel(autoTier)} rate
                  </div>
                )}
              </div>
            </div>

            {savedChildren.length > 0 && (
              <div className="mt-3 w-full max-w-xl text-left">
                <div className="flex items-center gap-2 mb-2 text-muted-foreground">
                  <Baby className="w-4 h-4" />
                  <span className="text-xs font-bold uppercase tracking-wide">
                    Saved children
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {savedChildren.map((c) => (
                    <span
                      key={c.id}
                      className="rounded-full bg-muted px-3 py-1 text-sm font-medium"
                    >
                      {c.childName}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-muted-foreground mt-4 text-sm">
              Recognised member — pick an event below to sell them a pass (the form pre-fills).
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-center py-8">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-5">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
            <p className="text-xl font-medium">Waiting for the customer…</p>
            <p className="text-muted-foreground mt-1 flex items-center gap-2">
              <IdCard className="w-4 h-4" />
              Enter phone to look up membership
            </p>

            <div className="grid grid-cols-2 gap-4 mt-6 w-full max-w-xl">
              <Card className="p-5 flex items-center gap-4 text-left">
                <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                  <Smartphone className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-muted-foreground">Phone</div>
                  <div className="text-xl font-bold truncate">
                    {phone || <span className="text-muted-foreground/50">—</span>}
                  </div>
                </div>
              </Card>
              <Card className="p-5 flex items-center gap-4 text-left">
                <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                  <User className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-muted-foreground">Nickname</div>
                  <div className="text-xl font-bold truncate">
                    {nickname || <span className="text-muted-foreground/50">—</span>}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* Event passes — flat-priced camp/event entry, no membership needed.
            The heading row and the action row below wrap rather than clip when
            the column is narrow — the test harness's customer display open
            beside the till at 1600 px (SCRUM-436); with room, as there always
            is with the display closed, they lay out exactly as before. */}
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Ticket className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              Event Passes
            </h3>
            <span className="text-xs text-muted-foreground/70">
              {member
                ? `Pick an event to sell to ${member.nickname}`
                : 'Flat day entry — no membership needed'}
            </span>
          </div>
          {eventPasses.length === 0 || !onSellEventPass ? (
            <Card className="p-6 text-center text-muted-foreground bg-card/30 border-dashed">
              <p className="text-sm font-medium">No active events</p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                Today's camp sessions and upcoming events appear here.
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {eventPasses.map((ev) => (
                <EventPassCard key={ev.id} event={ev} onSell={onSellEventPass} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="mt-auto pt-5 shrink-0 flex flex-wrap items-center gap-3">
        {onRedeemBooking && (
          <Button
            variant="outline"
            size="lg"
            className="h-16 px-6 flex items-center gap-2 border-primary/40 text-primary hover:bg-primary/5 hover:text-primary"
            onClick={onRedeemBooking}
          >
            <QrCode className="w-5 h-5" />
            Redeem Booking
          </Button>
        )}
        <Button variant="outline" size="lg" className="h-16 px-8" onClick={onSkip}>
          Skip — walk-in (Tourist)
        </Button>
      </div>
    </div>
  );
}
