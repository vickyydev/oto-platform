import type { DiscountTarget } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { formatWWPrice } from '@/lib/pricingMode';
import { Field, SelectInput } from './fields';

// One flat token per scope choice in the primary selector. ticketGroup is split
// into 'kids'/'adults' tokens so staff pick "Only kids tickets" in one step.
type ScopeToken =
  | 'everything'
  | 'tickets'
  | 'kids'
  | 'adults'
  | 'ticketType'
  | 'addOns'
  | 'addOn'
  | 'fnb'
  | 'fnbCategory'
  | 'menuItems'
  | 'merch'
  | 'event_pass';

function tokenOf(t: DiscountTarget): ScopeToken {
  return t.kind === 'ticketGroup' ? t.group : t.kind;
}

export function DiscountTargetPicker({
  value,
  onChange,
}: {
  value: DiscountTarget;
  onChange: (t: DiscountTarget) => void;
}) {
  const { ticketTypes, addOns, menuItems, menuCategories } = useCatalogStore();
  const orderedCategories = [...menuCategories].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  const token = tokenOf(value);

  const buildDefault = (next: ScopeToken): DiscountTarget => {
    switch (next) {
      case 'everything':
        return { kind: 'everything' };
      case 'tickets':
        return { kind: 'tickets' };
      case 'kids':
        return { kind: 'ticketGroup', group: 'kids' };
      case 'adults':
        return { kind: 'ticketGroup', group: 'adults' };
      case 'ticketType':
        return { kind: 'ticketType', ticketTypeId: ticketTypes[0]?.id ?? '' };
      case 'addOns':
        return { kind: 'addOns' };
      case 'addOn':
        return { kind: 'addOn', addOnId: addOns[0]?.id ?? '' };
      case 'fnb':
        return { kind: 'fnb' };
      case 'fnbCategory':
        return {
          kind: 'fnbCategory',
          category: orderedCategories[0]?.id ?? '',
        };
      case 'menuItems':
        return {
          kind: 'menuItems',
          menuItemIds: menuItems[0]?.id ? [menuItems[0].id] : [],
        };
      case 'merch':
        return { kind: 'merch' };
      case 'event_pass':
        return { kind: 'event_pass' };
    }
  };

  const toggleMenuItem = (id: string) => {
    if (value.kind !== 'menuItems') return;
    const has = value.menuItemIds.includes(id);
    onChange({
      kind: 'menuItems',
      menuItemIds: has
        ? value.menuItemIds.filter((x) => x !== id)
        : [...value.menuItemIds, id],
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="Applies to"
        htmlFor="disc-scope"
        hint="Choose how widely this code discounts."
      >
        <SelectInput
          id="disc-scope"
          value={token}
          onChange={(e) => onChange(buildDefault(e.target.value as ScopeToken))}
        >
          <optgroup label="Order">
            <option value="everything">Everything (whole order)</option>
          </optgroup>
          <optgroup label="Tickets">
            <option value="tickets">All tickets</option>
            <option value="kids">Only kids tickets</option>
            <option value="adults">Only adult tickets</option>
            <option value="ticketType">A specific ticket…</option>
          </optgroup>
          <optgroup label="Add-ons">
            <option value="addOns">All add-ons</option>
            <option value="addOn">A specific add-on…</option>
          </optgroup>
          <optgroup label="Food &amp; Beverage">
            <option value="fnb">All F&amp;B</option>
            <option value="fnbCategory">An F&amp;B category…</option>
            <option value="menuItems">Specific item(s)…</option>
          </optgroup>
          <optgroup label="Other">
            <option value="merch">All merch</option>
            <option value="event_pass">Event passes</option>
          </optgroup>
        </SelectInput>
      </Field>

      {/* Dependent second selector for the scopes that need a specific id. */}
      {value.kind === 'ticketType' && (
        <Field label="Ticket" htmlFor="disc-scope-ticket">
          <SelectInput
            id="disc-scope-ticket"
            value={value.ticketTypeId}
            onChange={(e) =>
              onChange({ kind: 'ticketType', ticketTypeId: e.target.value })
            }
          >
            {ticketTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}

      {value.kind === 'addOn' && (
        <Field label="Add-on" htmlFor="disc-scope-addon">
          <SelectInput
            id="disc-scope-addon"
            value={value.addOnId}
            onChange={(e) =>
              onChange({ kind: 'addOn', addOnId: e.target.value })
            }
          >
            {addOns.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}

      {value.kind === 'fnbCategory' && (
        <Field label="Category" htmlFor="disc-scope-cat">
          <SelectInput
            id="disc-scope-cat"
            value={value.category}
            onChange={(e) =>
              onChange({
                kind: 'fnbCategory',
                category: e.target.value,
              })
            }
          >
            {orderedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}

      {value.kind === 'menuItems' && (
        <Field
          label="Items"
          htmlFor="disc-scope-items"
          hint="Tick every item this code applies to."
        >
          <div
            id="disc-scope-items"
            className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-xl border border-foreground/10 bg-black/20 p-2"
          >
            {menuItems.map((m) => {
              const checked = value.menuItemIds.includes(m.id);
              return (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/5"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={checked}
                    onChange={() => toggleMenuItem(m.id)}
                  />
                  <span className="flex-1 truncate">{m.name}</span>
                  <span className="text-xs text-foreground/40">{formatWWPrice(m.price)}</span>
                </label>
              );
            })}
          </div>
        </Field>
      )}
    </div>
  );
}
