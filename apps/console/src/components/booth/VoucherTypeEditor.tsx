import { useMemo, useState, type ReactNode } from 'react';
import { Drawer } from '@/components/Drawer';
import { Button } from '@/components/ui/button';
import { CheckRow, ChoiceRow, Field, NumberInput, TextInput } from '@/components/Form';
import { CONTROL } from '@/components/Filters';
import { ErrorNote, Fact } from '@/components/Panel';
import { StatusPill } from '@/components/Status';
import { cn } from '@/lib/utils';
import type {
  VoucherDefinitionInput,
  VoucherDefinitionRow,
  VoucherLinkOptions,
  VoucherUse,
} from './boothApi';
import {
  VOUCHER_CHOICES,
  blankForm,
  codeFor,
  formFrom,
  formProblems,
  inputFrom,
  notSetUp,
  staleWordsSentence,
  unredeemedSentence,
  worthChange,
  type VoucherForm,
  type Worth,
} from './voucherTypes';

/**
 * One voucher type, open for editing (SCRUM-400).
 *
 * Three things a manager decides here, and each reaches the park at a
 * different moment — which the form says beside the field rather than in a
 * manual nobody reads:
 *
 *   - **What it is worth** (the choice, the amount, the product or package).
 *     The till reads it when the voucher is scanned, so a change applies to
 *     every voucher of this type not yet redeemed — slips already printed
 *     included. So a change to a worth the type already had is asked about
 *     before it is sent, from and to in the till's words, with how many
 *     vouchers it reaches (`unredeemedSentence`), naming a new voucher
 *     type as the safer choice (`worthChange`, SCRUM-409), and naming the
 *     type's own words that still say the old worth, since those print as
 *     they are (`staleWordsSentence`, SCRUM-432). Completing
 *     a type — its first product link — is not asked about: the slips printed
 *     before the link are the ones that must pick it up.
 *   - **What the slip says** (title, instruction, terms, in English and Thai).
 *     Printed exactly as typed; when it reaches paper follows the wheel
 *     version each booth is running, not this form: a type that version
 *     carries words for prints that version's, so an edit waits for the
 *     booth's next publish; any other type, one worded since that publish
 *     included, prints the prize's own name, the standard line and its
 *     current terms, which change at the box's next pull. The rule in full
 *     is the note at the top of the api's `services/voucher-definitions.ts`;
 *     the drawer's subtitle says it for the manager. The preview under the
 *     fields is the slip's own order of lines.
 *   - **How long it lasts** (days, or never). Read from the type when a
 *     voucher is won — by the box, from the copy its last pull brought, and
 *     only when the prize sets no days of its own — and copied onto that
 *     voucher. So a change applies to vouchers won after the box's next pull,
 *     and a slip already printed keeps its date.
 *
 * **What is not a choice is shown as a fact, not a switch.** A booth voucher
 * is redeemed online only, once, and never beside another voucher or a promo
 * code, at any branch that can honour it: the till enforces all of that
 * whatever a definition says (`vouchers.ts`), so a toggle here would promise
 * something it does not do. "Can honour it" is the one fact that depends on
 * the type (`freeItemAtBranch` and `packageAtBranch` in
 * `apps/api/src/services/vouchers.ts`): a free product only at a park where
 * its linked product is on sale — which is every park for a product under no
 * branch — or, once that product is archived, where one with the same code
 * is; a 1+1 at its package's own park, or where a live package of the same
 * name is on sale.
 */
export function VoucherTypeEditor({
  definition,
  linkOptions,
  linkOptionsFailed,
  saving,
  readOnly,
  error,
  onSave,
  onArchive,
  onRestore,
  onClose,
}: {
  /** Null for a new voucher type. */
  definition: VoucherDefinitionRow | null;
  /** The pickers' contents. Null while they are being read. */
  linkOptions: VoucherLinkOptions | null;
  /** Why the pickers could not be read, if they could not. */
  linkOptionsFailed: string | null;
  saving: boolean;
  readOnly: boolean;
  error: string | null;
  onSave: (input: VoucherDefinitionInput) => void;
  onArchive: (definition: VoucherDefinitionRow) => void;
  onRestore: (definition: VoucherDefinitionRow) => void;
  onClose: () => void;
}) {
  const isNew = definition === null;
  const archived = Boolean(definition?.archivedAt);
  const [form, setForm] = useState<VoucherForm>(() => (definition ? formFrom(definition) : blankForm()));
  const [confirmArchive, setConfirmArchive] = useState(false);
  /**
   * Save was pressed on a change to what the type is worth, and the drawer is
   * asking before it sends. Any edit withdraws the question; Save asks it
   * again if the worth still changes.
   */
  const [askingWorth, setAskingWorth] = useState(false);
  const locked = readOnly || archived;

  const problems = formProblems(form, isNew);
  const canSave = !saving && !locked && Object.keys(problems).length === 0;
  const set = (patch: Partial<VoucherForm>) => {
    setAskingWorth(false);
    setForm((f) => ({ ...f, ...patch }));
  };

  /**
   * The name drives the reference code until somebody types a code of their
   * own — the code is how imports and reports name a type, and a manager
   * should not have to invent a slug to add a prize.
   */
  const setNameEn = (nameEn: string) => {
    setAskingWorth(false);
    setForm((f) => ({ ...f, nameEn, ...(f.codeTouched ? {} : { code: nameEn.trim() ? codeFor(nameEn) : '' }) }));
  };

  const products = useMemo(() => groupByBranch(linkOptions?.products ?? []), [linkOptions]);
  const packages = useMemo(() => groupByBranch(linkOptions?.packages ?? []), [linkOptions]);
  const uses = definition?.usedBy ?? [];
  const stillRefused = definition ? notSetUp(definition) : null;

  const input = inputFrom(form, definition, isNew);
  const next = definition && !locked ? worthNamed(input, definition, linkOptions) : null;
  const change = definition && next ? worthChange(definition, next) : null;
  /** The words about to be saved that still say the worth being left behind (SCRUM-432). */
  const staleWords = definition && next && change ? staleWordsSentence(definition, next, input) : null;
  const asking = askingWorth && change !== null;

  const save = () => {
    if (change) {
      setAskingWorth(true);
      return;
    }
    onSave(input);
  };

  /** Put the worth back as it is stored; every other edit in the form stays. */
  const keepWorth = () => {
    if (!definition) return;
    const stored = formFrom(definition);
    set({
      choice: stored.choice,
      amountText: stored.amountText,
      percentText: stored.percentText,
      productId: stored.productId,
      ticketPackageId: stored.ticketPackageId,
    });
  };

  return (
    <Drawer
      title={isNew ? 'New voucher type' : definition.nameEn}
      subtitle={
        archived
          ? 'Archived. Vouchers already printed under it are still honoured; restore it to change it or put it on a prize.'
          : isNew
            ? 'What a prize is worth at the park, and the words its slip prints.'
            : 'What it is worth applies at once to every voucher of this type not yet redeemed. Its title and instruction reach paper when a booth using it is published again. Its terms do too once that booth runs a version with this type’s title or instruction; until then the slip there shows the prize’s name and the standard line, and the terms follow the box’s next pull. Its expiry applies to vouchers won after the box’s next pull, within about a minute.'
      }
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-3">
          {asking && change && (
            <div
              className="rounded-xl border px-3.5 py-3 text-sm flex flex-col gap-1"
              style={{
                borderColor: 'hsl(var(--status-warn) / 0.45)',
                backgroundColor: 'hsl(var(--status-warn) / 0.07)',
              }}
            >
              <p className="font-semibold">
                Change what it is worth, from {change.from} to {change.to}?
              </p>
              <p className="text-xs text-muted-foreground">
                {unredeemedSentence(definition?.unredeemedVouchers)}
                {uses.length > 0
                  ? ` — it is on the wheel at ${uses.map((u) => `${u.boothName} (${u.prizeName})`).join(', ')}`
                  : ''}
                .{staleWords ? ` ${staleWords}` : ''} Safer: keep this type as it is, create the new worth with
                “New voucher type”, and point the prize at it.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 justify-between">
            {!isNew && !readOnly ? (
              archived ? (
                <Button variant="outline" size="sm" onClick={() => onRestore(definition)} disabled={saving}>
                  Restore
                </Button>
              ) : confirmArchive ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm">Archive this voucher type?</span>
                  <Button variant="destructive" size="sm" onClick={() => onArchive(definition)} disabled={saving}>
                    Archive
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(false)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)} disabled={saving}>
                  Archive voucher type
                </Button>
              )
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                {locked ? 'Close' : 'Cancel'}
              </Button>
              {!locked && !asking && (
                <Button onClick={save} disabled={!canSave}>
                  {saving ? 'Saving…' : isNew ? 'Create voucher type' : 'Save'}
                </Button>
              )}
              {!locked && asking && (
                <>
                  <Button variant="outline" onClick={keepWorth} disabled={saving}>
                    Keep as it is
                  </Button>
                  <Button variant="destructive" onClick={() => onSave(input)} disabled={!canSave}>
                    {saving ? 'Saving…' : 'Change it anyway'}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <ErrorNote message={error} />}
        {!isNew && stillRefused && !archived && (
          <p
            className="rounded-xl border px-3.5 py-3 text-sm"
            style={{
              borderColor: 'hsl(var(--status-warn) / 0.45)',
              backgroundColor: 'hsl(var(--status-warn) / 0.07)',
            }}
          >
            Today at the till: {stillRefused}
          </p>
        )}
        {confirmArchive && uses.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {uses.length} prize{uses.length === 1 ? '' : 's'} point at it (
            {uses.map((u) => `${u.boothName} · ${u.prizeName}`).join(', ')}). Those booths keep what they
            are running; their next publish is refused until each prize points at another voucher type.
          </p>
        )}

        <Section title="Name" detail="What the Console, the prize picker and the till’s card call it.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name (English)" hint={warn(problems.nameEn)}>
              <TextInput
                value={form.nameEn}
                onChange={setNameEn}
                maxLength={120}
                placeholder="50 THB off"
                disabled={locked}
              />
            </Field>
            <Field label="Name (Thai)">
              <TextInput
                value={form.nameTh}
                onChange={(nameTh) => set({ nameTh })}
                maxLength={120}
                placeholder="ส่วนลด 50 บาท"
                disabled={locked}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="What it is worth"
          detail="Read by the till when the voucher is scanned — never typed in at the counter."
        >
          {form.choice === null ? (
            <p className="text-sm text-muted-foreground">
              A {definition?.kind.replace('_', ' ')} voucher. No till redeems one yet, so this form does not
              change what it is worth; its name, words and expiry can still be edited.
            </p>
          ) : (
            <>
              <ChoiceRow
                value={form.choice}
                onChange={(choice) => set({ choice: choice as VoucherForm['choice'] })}
                disabled={locked}
                options={VOUCHER_CHOICES.map((c) => ({ value: c.id, label: c.label }))}
              />
              <p className="text-xs text-muted-foreground">
                {VOUCHER_CHOICES.find((c) => c.id === form.choice)?.detail}
              </p>
            </>
          )}

          {form.choice === 'amount' && (
            <Field label="Amount off" hint={warn(problems.amountText, 'Baht, at most two decimals.')}>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground shrink-0">฿</span>
                <TextInput
                  value={form.amountText}
                  onChange={(amountText) => set({ amountText })}
                  placeholder="50"
                  disabled={locked}
                />
              </div>
            </Field>
          )}
          {form.choice === 'percent' && (
            <Field label="Percent off" hint={warn(problems.percentText, 'Up to 100, at most two decimals.')}>
              <div className="flex items-center gap-2">
                <TextInput
                  value={form.percentText}
                  onChange={(percentText) => set({ percentText })}
                  placeholder="10"
                  disabled={locked}
                />
                <span className="text-sm text-muted-foreground shrink-0">%</span>
              </div>
            </Field>
          )}
          {form.choice === 'product' && (
            <Field
              label="Product"
              hint={warn(
                problems.productId,
                'Honoured at the park that sells this product, or at every park for a product under “Every branch”. A till at another park refuses it.',
              )}
            >
              <GroupedSelect
                value={form.productId}
                onChange={(productId) => set({ productId })}
                groups={products}
                placeholder={linkOptions ? '— choose a product —' : 'Loading products…'}
                disabled={locked || !linkOptions}
                current={definition?.product ?? null}
              />
            </Field>
          )}
          {form.choice === 'ticket' && (
            <Field
              label="Ticket package"
              hint={warn(
                problems.ticketPackageId,
                'Only this package qualifies — link the one the 1+1 is valid for. Another park honours its own package of the same name.',
              )}
            >
              <GroupedSelect
                value={form.ticketPackageId}
                onChange={(ticketPackageId) => set({ ticketPackageId })}
                groups={packages}
                placeholder={linkOptions ? '— choose a ticket package —' : 'Loading packages…'}
                disabled={locked || !linkOptions}
                current={definition?.ticketPackage ?? null}
              />
            </Field>
          )}
          {linkOptionsFailed && (form.choice === 'product' || form.choice === 'ticket') && (
            <ErrorNote message={`The products and packages could not be read: ${linkOptionsFailed}`} />
          )}
        </Section>

        <Section
          title="What the slip says"
          detail="Printed exactly as typed, English then Thai. Left empty, the slip prints the prize’s own name and “Show this QR at OTO Reception to claim”."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title (English)">
              <TextInput
                value={form.titleEn}
                onChange={(titleEn) => set({ titleEn })}
                maxLength={80}
                placeholder="FREE KIDS PIZZA"
                disabled={locked}
              />
            </Field>
            <Field label="Title (Thai)">
              <TextInput
                value={form.titleTh}
                onChange={(titleTh) => set({ titleTh })}
                maxLength={80}
                disabled={locked}
              />
            </Field>
            <Field label="Instruction (English)">
              <TextArea
                value={form.instructionEn}
                onChange={(instructionEn) => set({ instructionEn })}
                maxLength={240}
                rows={2}
                placeholder="Show this slip at the OTO restaurant for one free kids pizza."
                disabled={locked}
              />
            </Field>
            <Field label="Instruction (Thai)">
              <TextArea
                value={form.instructionTh}
                onChange={(instructionTh) => set({ instructionTh })}
                maxLength={240}
                rows={2}
                disabled={locked}
              />
            </Field>
            <Field label="Terms (English)" hint="Each line prints as its own line at the foot of the slip.">
              <TextArea
                value={form.termsEn}
                onChange={(termsEn) => set({ termsEn })}
                maxLength={2000}
                rows={3}
                placeholder="One use only. No cash value."
                disabled={locked}
              />
            </Field>
            <Field label="Terms (Thai)">
              <TextArea
                value={form.termsTh}
                onChange={(termsTh) => set({ termsTh })}
                maxLength={2000}
                rows={3}
                disabled={locked}
              />
            </Field>
          </div>
          <SlipPreview form={form} uses={uses} />
        </Section>

        <Section
          title="How long it lasts"
          detail="Counted in days from the day a voucher is won: the slip prints the last day, and the voucher is good to the end of that day in the park’s time zone. A change applies to vouchers won after the box’s next pull; slips already printed keep their date."
        >
          <ChoiceRow
            value={form.expiry}
            onChange={(expiry) =>
              set({
                expiry: expiry as VoucherForm['expiry'],
                expiryDays: expiry === 'days' ? (form.expiryDays ?? 14) : form.expiryDays,
              })
            }
            disabled={locked}
            options={[
              { value: 'days', label: 'A number of days' },
              { value: 'never', label: 'Never expires' },
            ]}
          />
          {form.expiry === 'days' && (
            <Field
              label="Days"
              hint={warn(problems.expiryDays, 'A prize can set its own number on the Booths page.')}
            >
              <NumberInput
                value={form.expiryDays}
                min={1}
                onChange={(expiryDays) => set({ expiryDays })}
                disabled={locked}
              />
            </Field>
          )}
        </Section>

        <Section
          title="At the till"
          detail="Not settings: the till enforces them, whatever this form says."
        >
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="Redeemed">Online only — a till working offline refuses it</Fact>
            <Fact label="Use">Once</Fact>
            <Fact label="Combinable">No — one voucher per sale, never beside a promo code</Fact>
            <Fact label="Redeemable at">
              {form.choice === 'product'
                ? 'The park that sells its product — every park for a product under “Every branch”'
                : form.choice === 'ticket'
                  ? 'Its package’s park, and any park with a package of the same name'
                  : 'Any branch of the park'}
            </Fact>
          </dl>
        </Section>

        <CheckRow
          checked={form.active}
          onChange={(active) => set({ active })}
          disabled={locked}
          label="Switched on"
          detail="Off, a prize pointing at it cannot be published. Vouchers already printed are still honoured."
        />

        <Field
          label="Reference code"
          hint={
            isNew
              ? warn(
                  problems.code,
                  'How imports and reports name it. Filled in from the English name; it cannot be changed later.',
                )
              : 'How imports and reports name it.'
          }
        >
          <TextInput
            value={form.code}
            onChange={(code) => set({ code: code.toLowerCase(), codeTouched: true })}
            maxLength={61}
            disabled={!isNew || locked}
          />
        </Field>

        {uses.length > 0 && (
          <p className="text-xs text-muted-foreground">
            On the wheel at {uses.map((u) => `${u.boothName} (${u.prizeName}${u.active ? '' : ', switched off'})`).join(', ')}.
          </p>
        )}
      </div>
    </Drawer>
  );
}

/**
 * The worth the form is about to send, with its product or package named the
 * way the stored row's is — from the pickers, or from the row itself when the
 * link is unchanged — so `worthChange` says "Free: Margherita Pizza" on both
 * sides rather than an id on one.
 */
function worthNamed(
  input: VoucherDefinitionInput,
  stored: VoucherDefinitionRow,
  links: VoucherLinkOptions | null,
): Worth {
  const product =
    input.productId === null
      ? null
      : stored.product && stored.product.id === input.productId
        ? stored.product
        : (links?.products.find((p) => p.id === input.productId) ?? null);
  const ticketPackage =
    input.ticketPackageId === null
      ? null
      : stored.ticketPackage && stored.ticketPackage.id === input.ticketPackageId
        ? stored.ticketPackage
        : (links?.packages.find((p) => p.id === input.ticketPackageId) ?? null);
  return {
    kind: input.kind,
    valueType: input.valueType,
    valueSatang: input.valueSatang,
    valueBp: input.valueBp,
    productId: input.productId,
    ticketPackageId: input.ticketPackageId,
    product,
    ticketPackage,
  };
}

/** A field's hint, or what is wrong with it in the colour the other editors use for that. */
function warn(problem: string | undefined, fallback?: ReactNode): ReactNode {
  return problem ? <span style={{ color: 'hsl(var(--status-down))' }}>{problem}</span> : fallback;
}

/** A heading inside the drawer, with the one line that says when the fields below take effect. */
function Section({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-bold">{title}</h3>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground break-words">{detail}</p>}
      </div>
      {children}
    </section>
  );
}

/** A multi-line field in the form's own clothes. */
function TextArea({
  value,
  onChange,
  maxLength,
  rows,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(CONTROL, 'h-auto py-2 leading-snug resize-y disabled:opacity-60')}
    />
  );
}

interface BranchGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * Products or packages under the branch they belong to, operator-wide ones
 * first. Each option names its branch as well as sitting under it: the same
 * menu is on sale at every park, and a screen reader that does not announce
 * the group would otherwise read two identical "Margherita Pizza" lines.
 */
function groupByBranch(
  rows: ReadonlyArray<{ id: string; name: string; code?: string | null; branchName: string | null }>,
): BranchGroup[] {
  const groups = new Map<string, BranchGroup>();
  for (const row of rows) {
    const label = row.branchName ?? 'Every branch';
    const group = groups.get(label) ?? { label, options: [] };
    const named = row.code ? `${row.name} (${row.code})` : row.name;
    group.options.push({ value: row.id, label: row.branchName ? `${named} — ${row.branchName}` : named });
    groups.set(label, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.label === 'Every branch' ? -1 : b.label === 'Every branch' ? 1 : a.label.localeCompare(b.label),
  );
}

/**
 * A native select with the options grouped by branch.
 *
 * A linked product that is no longer offered — archived, or at an archived
 * branch — is still the link, and is shown as such rather than dropped, so a
 * manager sees what the till is refusing instead of an empty field.
 */
function GroupedSelect({
  value,
  onChange,
  groups,
  placeholder,
  disabled,
  current,
}: {
  value: string;
  onChange: (next: string) => void;
  groups: BranchGroup[];
  placeholder: string;
  disabled?: boolean;
  current: { id: string; name: string; branchName: string | null } | null;
}) {
  const offered = groups.some((g) => g.options.some((o) => o.value === value));
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(CONTROL, 'disabled:opacity-60')}
    >
      <option value="">{placeholder}</option>
      {value !== '' && !offered && current && current.id === value && (
        <option value={current.id}>
          {current.name}
          {current.branchName ? ` · ${current.branchName}` : ''} — not on sale
        </option>
      )}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * The prize whose names a slip prints where the title is left empty.
 *
 * The box falls back to the name of the PRIZE that was won, never to this
 * type's (`buildPrintJob` in `@oto/box-agent`), and a type can sit on several
 * prizes. So: the names when every live prize using it shares them, and null
 * — a placeholder on the preview — when none does yet or they differ.
 */
function prizeNamesOf(uses: VoucherUse[]): { en: string; th: string | null } | null {
  const distinct = new Map(uses.map((u) => [`${u.prizeName}\u0000${u.prizeNameTh ?? ''}`, u]));
  if (distinct.size !== 1) return null;
  const [only] = [...distinct.values()];
  return { en: only!.prizeName, th: only!.prizeNameTh ?? null };
}

/** A line the slip fills in from the prize, drawn so it does not read as typed text. */
function FromPrize({ children }: { children: ReactNode }) {
  return <span className="italic opacity-60">{children}</span>;
}

/**
 * The slip's words in the slip's order: the banner, the title in English and
 * Thai, the instruction, the code, the expiry, "Single use" and the terms.
 * Not a rendering — the booth's printer draws the real thing
 * (`packages/print/src/templates/booth.ts`) — but the same lines in the same
 * order, so a manager reads what a family will. Where the slip falls back to
 * the prize's own names, so does this (`prizeNamesOf`).
 */
function SlipPreview({ form, uses }: { form: VoucherForm; uses: VoucherUse[] }) {
  const prize = prizeNamesOf(uses);
  const titleTyped = form.titleEn.trim();
  const titleThTyped = form.titleTh.trim();
  const instruction = [form.instructionEn.trim(), form.instructionTh.trim()].filter(Boolean);
  const terms = [form.termsEn, form.termsTh]
    .flatMap((block) => block.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);
  const worded = [form.titleEn, form.titleTh, form.instructionEn, form.instructionTh].some(
    (w) => w.trim() !== '',
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
          On the slip
        </span>
        {worded ? (
          <StatusPill tone="ok">the park’s words</StatusPill>
        ) : (
          <StatusPill tone="idle">the prize’s name and the standard line</StatusPill>
        )}
      </div>
      <div
        className="mx-auto w-full max-w-[19rem] rounded-md border border-dashed px-4 py-3 text-center text-[12px] leading-snug"
        style={{ backgroundColor: '#fdfdfb', color: '#111' }}
        aria-label="Slip preview"
      >
        <p className="font-bold tracking-widest">★ YOU WON ★</p>
        <p className="mt-1 text-[15px] font-bold break-words">
          {titleTyped || (prize ? prize.en : <FromPrize>the prize’s name</FromPrize>)}
        </p>
        {titleThTyped ? (
          <p className="font-bold break-words">{titleThTyped}</p>
        ) : prize ? (
          prize.th && <p className="font-bold break-words">{prize.th}</p>
        ) : (
          <p className="font-bold break-words">
            <FromPrize>its Thai name, if it has one</FromPrize>
          </p>
        )}
        <hr className="my-2 border-black/30" />
        {instruction.length > 0 ? (
          instruction.map((line, i) => (
            <p key={`${i}:${line}`} className="break-words">
              {line}
            </p>
          ))
        ) : (
          <p className="break-words">
            Show this QR at OTO Reception to claim:{' '}
            {prize ? prize.en : <FromPrize>the prize’s name</FromPrize>}.
          </p>
        )}
        <hr className="my-2 border-black/30" />
        <p className="font-mono tracking-widest">[ QR ] B1·········</p>
        <p className="mt-1 flex gap-3 text-left">
          <span className="w-12 shrink-0">Expires</span>
          <span className="font-bold">
            {form.expiry === 'never'
              ? 'No expiry'
              : `the date ${form.expiryDays ?? '—'} day${form.expiryDays === 1 ? '' : 's'} after the win`}
          </span>
        </p>
        <hr className="my-2 border-black/30" />
        <p className="font-bold">Single use · ใช้ได้ 1 ครั้ง</p>
        {terms.map((line, i) => (
          <p key={`${i}:${line}`} className="break-words">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
