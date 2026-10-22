import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useRef, useState } from "react";
import { useOperatorTierCapabilities, type TiersPanelPorts } from '../../../runtime/catalogue';
import { Plus, Trash2, ChevronUp, ChevronDown, GripVertical, BadgeCheck, Star, AlertTriangle } from "lucide-react";
import { Button } from "../../ui/button";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";


import { type TicketType, type TierDef } from "../../../model/types";
import { TextInput } from "../discounts/fields";

// Slug a free-text name into a stable token id, kept unique against existing ids.
// Tier ids stay lowercase (they key TicketType.prices).
function makeId(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'tier';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

export function MarketsTiersSection() {
  const runtime = useAdminScreenRuntime();
  const { tiers, ticketTypes, mutators } = useCatalogStore();
  const authority = useOperatorTierCapabilities(runtime.transport, runtime.session.operator?.id, Boolean(runtime.branch.branch.apiId), runtime.session.can);
  return <MarketsTiersSectionWithPorts ports={{ tiers, ticketTypes, upsertTier: mutators.upsertTier, deleteTier: mutators.deleteTier, countTierUsage: runtime.legacy.countTierUsage, isTierPriced: runtime.domain.pricing.isTierPriced, ...authority }} />;
}

export function MarketsTiersSectionWithPorts({ ports }: { ports: TiersPanelPorts }) {
  return (
    <div className="flex flex-col gap-6">
      <TiersEditor ports={ports} />
    </div>
  );
}

/**
 * A name field that reports one edit rather than one per keystroke — each
 * report is a PATCH to the platform now that tiers persist (SCRUM-228).
 */
function TierNameInput({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (name: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const name = draft.trim();
    if (!name) {
      setDraft(value); // a tier cannot be nameless — put the old name back
      return;
    }
    if (name !== value) onCommit(name);
  };

  return (
    <TextInput
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="min-w-[8rem] flex-1"
    />
  );
}

/** How many ticket types carry no price for this tier, and which. */
function UnpricedBadge({ tickets, total }: { tickets: TicketType[]; total: number }) {
  if (tickets.length === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-600"
      title={`Not sellable at this tier until a price is set: ${tickets
        .map((t) => t.name)
        .join(', ')}`}
    >
      <AlertTriangle className="w-3.5 h-3.5" />
      No price on {tickets.length} of {total}
    </span>
  );
}

function TiersEditor({ ports }: { ports: TiersPanelPorts }) {
  const { tiers, ticketTypes, countTierUsage, isTierPriced } = ports;

  const [newName, setNewName] = useState('');
  const nameRef = useRef(newName);
  nameRef.current = newName;
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const write = async (operation: () => void | Promise<void>, success?: () => void) => {
    if (writingRef.current) return;
    writingRef.current = true;
    setWriting(true);
    setWriteError(null);
    try { await operation(); if (mounted.current) success?.(); }
    catch (failure) { if (mounted.current) setWriteError(failure instanceof Error ? failure.message : 'The tier could not be saved.'); }
    finally { writingRef.current = false; if (mounted.current) setWriting(false); }
  };
  const sorted = [...tiers].sort((a, b) => a.sortOrder - b.sortOrder);

  // A tier with no price on a ticket is not a free ticket, it is a setting
  // nobody has filled in — and the till refuses to sell it (SCRUM-228). Say so
  // here, where the tier was added and the price is missing.
  const unpricedOn = (tierId: string): TicketType[] =>
    ticketTypes.filter((tt) => !isTierPriced(tt, tierId));

  const add = () => {
    const name = newName.trim();
    if (!name || ports.canCreate === false) return;
    const submittedName = newName;
    const id = makeId(name, new Set(tiers.map((t) => t.id)));
    const sortOrder = sorted.length ? sorted[sorted.length - 1]!.sortOrder + 1 : 0;
    void write(() => ports.upsertTier({
      id,
      name,
      isDefault: false,
      requiresVerification: true,
      sortOrder,
    }), () => { if (nameRef.current === submittedName) setNewName(''); });
  };

  const patch = (t: TierDef, fields: Partial<TierDef>) => {
    if (ports.canUpdate !== false) void write(() => ports.upsertTier({ ...t, ...fields }));
  };

  // Make a tier the single default. The default is the baseline (no proof), so
  // becoming default also clears its verification requirement; the store clears
  // the flag on every other tier.
  const makeDefault = (t: TierDef) => patch(t, { isDefault: true, requiresVerification: false });

  const remove = (t: TierDef) => {
    if (ports.canUpdate === false) return;
    if (t.isDefault) {
      window.alert(
        `"${t.name}" is the default tier — make another tier the default before deleting it.`,
      );
      return;
    }
    const used = countTierUsage(t.id);
    if (used > 0) {
      window.alert(
        `"${t.name}" is referenced by ${used} price${used === 1 ? '' : 's'}/record${
          used === 1 ? '' : 's'
        }. ` + `Remove those references before deleting this tier.`,
      );
      return;
    }
    void write(() => ports.deleteTier(t.id));
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sorted.length || ports.canUpdate === false) return;
    const a = sorted[index]!;
    const b = sorted[target]!;
    void write(async () => {
      await ports.upsertTier({ ...a, sortOrder: b.sortOrder });
      if (!mounted.current) return;
      await ports.upsertTier({ ...b, sortOrder: a.sortOrder });
    });
  };

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <BadgeCheck className="w-4 h-4 text-foreground/50" />
        <h2 className="text-lg font-bold">Customer tiers</h2>
      </div>
      <p className="mt-1 text-sm text-foreground/50">
        Pricing tiers a customer can be priced at. The default tier is the
        baseline anyone gets without proof; other tiers can require verification
        and are priced per ticket type. A new tier starts with no price on any
        ticket — the till refuses to sell a ticket at a tier it has no price
        for, so set the prices under Ticket types before using it.
      </p>

      {ports.authorityMessage && <p className="mt-3 text-sm text-foreground/50">{ports.authorityMessage}</p>}
      {writeError && <p role="alert" className="mt-3 text-sm text-destructive">{writeError}</p>}
      {ports.canCreate !== false && <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={newName}
          disabled={writing}
          placeholder="New tier (e.g. Student)"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1"
        />
        <Button onClick={add} disabled={writing || !newName.trim()} className="shrink-0">
          <Plus className="w-4 h-4" />
          Add
        </Button>
      </div>}

      <div className="mt-4 flex flex-col gap-2" data-testid="tier-list">
        {sorted.map((t, i) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2"
          >
            <GripVertical className="w-4 h-4 shrink-0 text-foreground/25" />
            <TierNameInput value={t.name} onCommit={(name) => patch(t, { name })} disabled={writing || ports.canUpdate === false} />
            <span className="shrink-0 rounded-md bg-foreground/5 px-2 py-1 font-mono text-xs text-foreground/40">
              {t.id}
            </span>
            <UnpricedBadge tickets={unpricedOn(t.id)} total={ticketTypes.length} />
            {ports.canUpdate !== false && <><Button
              variant={t.isDefault ? 'default' : 'outline'}
              size="sm"
              onClick={() => makeDefault(t)}
              disabled={writing || t.isDefault}
              className="shrink-0"
            >
              <Star className={`w-3.5 h-3.5 ${t.isDefault ? 'fill-current' : ''}`} />
              {t.isDefault ? 'Default' : 'Make default'}
            </Button>
            <Button
              variant={t.requiresVerification ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => patch(t, { requiresVerification: !t.requiresVerification })}
              disabled={writing || t.isDefault}
              className="shrink-0"
              title={
                t.isDefault
                  ? 'The default tier never requires verification.'
                  : undefined
              }
            >
              {t.requiresVerification ? 'Requires proof' : 'No proof'}
            </Button>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => move(i, -1)}
                disabled={writing || i === 0}
                aria-label="Move up"
              >
                <ChevronUp className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => move(i, 1)}
                disabled={writing || i === sorted.length - 1}
                aria-label="Move down"
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(t)}
                disabled={writing}
                aria-label="Remove tier"
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div></>}
          </div>
        ))}
      </div>
    </section>
  );
}
