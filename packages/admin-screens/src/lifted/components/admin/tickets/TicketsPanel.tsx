import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useRef, useState } from "react";
import type { TicketsPanelPorts } from '../../../runtime/catalogue';
import { Pencil, Trash2, Plus, Info, Gift, DoorOpen } from "lucide-react";
import { type CustomerTier, type TicketType } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";



import { Button } from "../../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { TicketTypeFormWithPorts } from "./TicketTypeForm";

type FormTarget = { mode: 'add' } | { mode: 'edit'; ticket: TicketType } | null;

export function TicketsPanel() {
  const runtime = useAdminScreenRuntime();
  const { ticketTypes, addOns, mutators } = useCatalogStore();
  return <TicketsPanelWithPorts ports={{ ticketTypes, addOns, tiers: runtime.reads.getTiers(), defaultTier: runtime.reads.getDefaultTier(), ticketPricing: runtime.domain.ticketPricing, formatWWPrice: runtime.domain.pricingMode.formatWWPrice, isDefaultTier: runtime.domain.membership.isDefaultTier, tierLabel: runtime.domain.membership.tierLabel, upsertTicketType: mutators.upsertTicketType, deleteTicketType: mutators.deleteTicketType }} />;
}

export function TicketsPanelWithPorts({ ports }: { ports: TicketsPanelPorts }) {
  const { ticketTypes, addOns, tiers, isDefaultTier, upsertTicketType, deleteTicketType } = ports;
  const { adultRuleSummary, creditRuleSummary, freebieLabel, freebieTierSuffix, ruleBadge } = ports.ticketPricing;
  const baht = ports.formatWWPrice;
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<TicketType | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteTarget = useRef(pendingDelete);
  deleteTarget.current = pendingDelete;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const formOpen = formTarget !== null;
  const editing = formTarget?.mode === 'edit' ? formTarget.ticket : null;

  const confirmDelete = async () => {
    if (!pendingDelete || deletingRef.current || ports.canUpdate === false) return;
    const target = pendingDelete;
    deletingRef.current = true;
    setDeleting(true);
    setWriteError(null);
    try {
      await deleteTicketType(target.id);
      if (mounted.current && deleteTarget.current === target) setPendingDelete(null);
    } catch (failure) {
      if (mounted.current) setWriteError(failure instanceof Error ? failure.message : 'The ticket type could not be deleted.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
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
        {badge && <span className="text-[10px] text-emerald-700/80">{badge}</span>}
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
      {ports.canUpdate !== false && <Button
        variant="ghost"
        size="icon"
        aria-label={`Edit ${t.name}`}
        onClick={() => setFormTarget({ mode: 'edit', ticket: t })}
      >
        <Pencil className="h-4 w-4" />
      </Button>}
      {ports.canUpdate !== false && <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${t.name}`}
        className="text-destructive"
        onClick={() => setPendingDelete(t)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {ticketTypes.length} ticket type{ticketTypes.length === 1 ? '' : 's'}
        </p>
        {ports.canCreate !== false && <Button disabled={!ports.defaultTier} onClick={() => { setWriteError(null); setFormTarget({ mode: 'add' }); }}>
          <Plus className="h-4 w-4" />
          Add ticket type
        </Button>}
      </div>

      {writeError && !pendingDelete && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
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
                            <span className="ml-1 text-emerald-700/80">
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

      {formTarget && <TicketTypeFormWithPorts
        key={editing?.id ?? 'add'}
        ports={ports}
        open={formOpen}
        ticket={editing}
        addOns={addOns}
        onClose={() => setFormTarget(null)}
        onSave={upsertTicketType}
      />}

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
          {writeError && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => { event.preventDefault(); void confirmDelete(); }}
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
