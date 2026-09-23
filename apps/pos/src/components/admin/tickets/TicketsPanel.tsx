import { useState } from 'react';
import { Pencil, Trash2, Plus, Info, Gift, DoorOpen } from 'lucide-react';
import type { CustomerTier, TicketType } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getTiers } from '@/store/catalogStore';
import { isDefaultTier } from '@/lib/membership';
import { formatWWPrice } from '@/lib/pricingMode';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { TicketTypeForm } from './TicketTypeForm';
import {
  adultRuleSummary,
  creditRuleSummary,
  freebieLabel,
  freebieTierSuffix,
  ruleBadge,
} from './ticketPricing';

const baht = formatWWPrice;

type FormTarget = { mode: 'add' } | { mode: 'edit'; ticket: TicketType } | null;

export function TicketsPanel() {
  const { ticketTypes, addOns, mutators } = useCatalogStore();
  const tiers = getTiers();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<TicketType | null>(null);

  const formOpen = formTarget !== null;
  const editing = formTarget?.mode === 'edit' ? formTarget.ticket : null;

  const handleSave = (ticket: TicketType) => {
    mutators.upsertTicketType(ticket);
    setFormTarget(null);
  };

  const confirmDelete = () => {
    if (pendingDelete) mutators.deleteTicketType(pendingDelete.id);
    setPendingDelete(null);
  };

  const tierCell = (t: TicketType, tier: CustomerTier) => {
    const price = t.prices[tier];
    const badge = isDefaultTier(tier) ? '' : ruleBadge(t.tierPricing?.[tier]);
    return (
      <div className="flex flex-col items-end leading-tight">
        {price == null ? (
          <span className="text-[11px] text-foreground/30">not priced</span>
        ) : (
          <span className="tabular-nums">{baht(price)}</span>
        )}
        {badge && <span className="text-[10px] text-emerald-300/80">{badge}</span>}
      </div>
    );
  };

  const freebieChips = (t: TicketType) => {
    if (!t.freebies?.length) return null;
    return (
      <div className="mt-1.5 flex flex-wrap gap-1">
        {t.freebies.map((f) => (
          <span
            key={f.id}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
          >
            <Gift className="h-3 w-3" />
            {freebieLabel(f, addOns)}
            {freebieTierSuffix(f)}
          </span>
        ))}
      </div>
    );
  };

  // Per-ticket entry-package chips: adult rule, credit give-back, gate access —
  // now owned by the ticket itself (no park-wide admission block).
  const packageChips = (t: TicketType) => {
    const adult = adultRuleSummary(t.adultRules);
    const credit = creditRuleSummary(t.creditRule);
    return (
      <div className="mt-1.5 flex flex-wrap gap-1">
        {adult && (
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60">
            {adult}
          </span>
        )}
        {credit && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
            <Gift className="h-3 w-3" />
            {credit}
          </span>
        )}
        {t.gateAccess && (
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60">
            <DoorOpen className="h-3 w-3" />
            Opens gate
          </span>
        )}
      </div>
    );
  };

  const rowActions = (t: TicketType) => (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Edit ${t.name}`}
        onClick={() => setFormTarget({ mode: 'edit', ticket: t })}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${t.name}`}
        className="text-destructive"
        onClick={() => setPendingDelete(t)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {ticketTypes.length} ticket type{ticketTypes.length === 1 ? '' : 's'}
        </p>
        <Button onClick={() => setFormTarget({ mode: 'add' })}>
          <Plus className="h-4 w-4" />
          Add ticket type
        </Button>
      </div>

      {ticketTypes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No ticket types yet. Add one to make it selectable in the POS.
        </div>
      ) : (
        <>
          {/* Desktop / tablet: table */}
          <div className="hidden overflow-hidden rounded-2xl border border-foreground/10 md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  {tiers.map((tier) => (
                    <TableHead key={tier.id} className="text-right">
                      {tier.name}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ticketTypes.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium align-top">
                      {t.name}
                      {packageChips(t)}
                      {freebieChips(t)}
                    </TableCell>
                    <TableCell className="text-foreground/60 align-top">
                      {t.durationLabel || '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums align-top">
                      {t.hours}
                    </TableCell>
                    {tiers.map((tier) => (
                      <TableCell key={tier.id} className="text-right align-top">
                        {tierCell(t, tier.id)}
                      </TableCell>
                    ))}
                    <TableCell className="align-top">{rowActions(t)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {ticketTypes.map((t) => (
              <div
                key={t.id}
                className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{t.name}</div>
                    <div className="text-xs text-foreground/50">
                      {t.durationLabel || '—'} · {t.hours}h
                    </div>
                  </div>
                  {rowActions(t)}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {tiers.map((tier) => {
                    const price = t.prices[tier.id];
                    const badge = isDefaultTier(tier.id)
                      ? ''
                      : ruleBadge(t.tierPricing?.[tier.id]);
                    return (
                      <div
                        key={tier.id}
                        className="rounded-xl bg-foreground/[0.02] px-3 py-2 text-center"
                      >
                        <div className="text-sm font-bold tabular-nums">
                          {price == null ? (
                            <span className="text-foreground/30">—</span>
                          ) : (
                            baht(price)
                          )}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-foreground/45">
                          {tier.name}
                          {badge && (
                            <span className="ml-1 text-emerald-300/80">
                              {badge}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {packageChips(t)}
                {freebieChips(t)}
              </div>
            ))}
          </div>
        </>
      )}

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="h-3.5 w-3.5 shrink-0" />
        Edits save to the branch catalog in the database.
      </p>

      <TicketTypeForm
        open={formOpen}
        ticket={editing}
        addOns={addOns}
        onClose={() => setFormTarget(null)}
        onSave={handleSave}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete ticket type?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be removed and no longer selectable in the POS.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
