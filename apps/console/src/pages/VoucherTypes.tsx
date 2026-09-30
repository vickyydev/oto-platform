import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { PenLine, Plus, RefreshCw, ScrollText, Ticket } from 'lucide-react';
import { useSession } from '@/auth/SessionContext';
import { Loading, RouteUnavailable, StaleNote, Unreadable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CheckRow } from '@/components/Form';
import { StatusMark } from '@/components/Status';
import { CommandBar } from '@/components/redesign/CommandBar';
import { StatusChip, TitleChip } from '@/components/redesign/chips';
import { CardFoot, CardShell, PageGrid, Rail, RailNote } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import {
  boothApi,
  isMissingRoute,
  type VoucherDefinitionInput,
  type VoucherDefinitionRow,
  type VoucherLinkOptions,
} from '@/components/booth/boothApi';
import { VoucherTypeEditor } from '@/components/booth/VoucherTypeEditor';
import {
  readAbsent,
  readFailed,
  readFailureMessage,
  readOk,
  reading,
  unread,
  type Read,
} from '@/components/booth/readState';
import { expiryText, isWorded, notSetUp, worthOf } from '@/components/booth/voucherTypes';

/**
 * Console > Voucher types (SCRUM-400, S2-07d): what a booth prize is worth,
 * set up by the park before any wheel gives one away.
 *
 * **Next to Booths, not inside it.** A voucher type is the operator's, shared
 * by every booth at every branch, while the Booths page is one booth at one
 * branch — its prize editor picks from this list. Putting the list on that
 * page would have hung an operator-wide setting under whichever booth happened
 * to be selected, so it has a page of its own directly under Booths in the
 * menu, and the prize editor names it.
 *
 * **The list says what the till would do today**, not only what was typed: a
 * free product with nothing linked is a voucher the counter answers "not set
 * up yet" for, and that is drawn on the row in the warning colour, because it
 * is the thing somebody has to fix before the bench test rather than a
 * preference. Which prizes point at each type is on the row too, since that is
 * what an edit or an archive reaches.
 *
 * **Laid out as the approved design draws it (SCRUM-474)**: the catalog as
 * rows with their worth, expiry, wheels and state, and a rail for the words a
 * slip prints — a type's own wording where one has it, shown as the park typed
 * it — and the rules every booth voucher obeys whatever its type.
 */
export function VoucherTypes() {
  const { has } = useSession();
  const canManage = has('admin:booth:manage');

  const [showArchived, setShowArchived] = useState(false);
  const [list, setList] = useState<Read<VoucherDefinitionRow[]>>(() =>
    unread<VoucherDefinitionRow[]>([]),
  );
  const [linkOptions, setLinkOptions] = useState<VoucherLinkOptions | null>(null);
  const [linkOptionsFailed, setLinkOptionsFailed] = useState<string | null>(null);
  /** The type open in the drawer: a row, `'new'`, or nothing. */
  const [open, setOpen] = useState<VoucherDefinitionRow | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async (includeArchived: boolean) => {
    setList((held) => reading(held));
    try {
      const answer = await boothApi.voucherDefinitions(includeArchived);
      setList(readOk(answer.definitions));
    } catch (reason) {
      setList((held) =>
        isMissingRoute(reason)
          ? readAbsent<VoucherDefinitionRow[]>([])
          : readFailed(held, readFailureMessage(reason), []),
      );
    }
  }, []);

  useEffect(() => {
    void load(showArchived);
  }, [load, showArchived]);

  /**
   * `?type=<id>` opens that type's drawer once the list has been read — the
   * prize editor's "Edit the slip’s words" link (SCRUM-468), so the words a
   * manager went looking for are on screen when they land. Once only: a later
   * read of the list must not reopen a drawer somebody has closed. A type the
   * list does not carry (archived, with "Show archived" off) opens nothing.
   */
  const search = useSearch();
  const askedFor = useRef<string | null>(new URLSearchParams(search).get('type'));
  useEffect(() => {
    const id = askedFor.current;
    if (!id || list.state !== 'read') return;
    askedFor.current = null;
    const row = list.value.find((r) => r.id === id);
    if (row) setOpen(row);
  }, [list]);

  /** The pickers' contents, read once: the operator's products and packages. */
  useEffect(() => {
    void boothApi
      .voucherLinkOptions()
      .then((options) => {
        setLinkOptions(options);
        setLinkOptionsFailed(null);
      })
      .catch((reason: unknown) => setLinkOptionsFailed(readFailureMessage(reason)));
  }, []);

  /**
   * Every write ends the same way: the list is read again rather than patched,
   * because the answer carries what the API made of the input — a link
   * cleared by a kind change, blank words stored as not written.
   */
  const write = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setWriteError(null);
    try {
      await action();
      setOpen(null);
      await load(showArchived);
    } catch (reason) {
      setWriteError(readFailureMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = (input: VoucherDefinitionInput) =>
    void write(() =>
      open === 'new' || open === null
        ? boothApi.createDefinition(input)
        : boothApi.saveDefinition(open.id, input),
    );

  const newButton = canManage ? (
    <Button
      size="sm"
      className="h-9 gap-2 rounded-full px-4 font-bold"
      onClick={() => {
        setWriteError(null);
        setOpen('new');
      }}
    >
      <Plus className="w-4 h-4" />
      New voucher type
    </Button>
  ) : null;

  if (list.state === 'absent') {
    return (
      <>
        <CommandBar sectionId="voucher-types" />
        <RouteUnavailable
          what="Voucher types"
          detail="This deployment does not serve the voucher type routes yet — SCRUM-400."
        />
      </>
    );
  }

  const rows = list.value;
  const live = rows.filter((row) => !row.archivedAt && row.active).length;
  // The rail's sample: the first live type that carries words of its own.
  const worded = rows.find((row) => !row.archivedAt && isWorded(row)) ?? null;

  return (
    <>
      <CommandBar
        sectionId="voucher-types"
        badges={
          list.state !== 'unread' && list.state !== 'failed' ? (
            // Where a type can be redeemed depends on the type (a free product
            // only where it is on sale, a 1+1 only where its package is sold —
            // the rules card), so the chip counts and claims nothing more.
            <TitleChip>
              {live} live type{live === 1 ? '' : 's'}
            </TitleChip>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={() => void load(showArchived)}
              disabled={list.refreshing}
            >
              <RefreshCw className={list.refreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
              Refresh
            </Button>
            {newButton}
          </>
        }
      />

      {!canManage && (
        <p className="rounded-[14px] border border-dashed border-foreground/20 px-4 py-3 text-sm text-muted-foreground">
          You can read the voucher types but not change them. Creating and editing them needs{' '}
          <code className="font-mono text-xs">admin:booth:manage</code>.
        </p>
      )}

      <PageGrid>
        <CardShell
          span={8}
          icon={Ticket}
          title="The catalog"
          note="shared by every booth at every branch; a prize picks one on the Booths page — open one to change it"
          footer={
            <>
              <CheckRow
                checked={showArchived}
                onChange={setShowArchived}
                label="Show archived voucher types"
                detail="Archived types are off every list a prize picks from; vouchers already printed under them are still honoured."
              />
            </>
          }
        >
          {list.state === 'stale' && list.readAt !== null && (
            <StaleNote readAt={list.readAt} message={list.error} onRetry={() => void load(showArchived)} />
          )}
          {list.state === 'failed' ? (
            <Unreadable what="The voucher types" message={list.error} onRetry={() => void load(showArchived)} />
          ) : list.state === 'unread' ? (
            <Loading what="voucher types" />
          ) : rows.length === 0 ? (
            <EmptyNote
              icon={Ticket}
              title="No voucher types yet"
              detail="A prize needs one before it can be published. Create the first with “New voucher type”, above."
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="hidden gap-3.5 px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80 @xl:grid @xl:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_84px_minmax(0,1fr)_92px]">
                <span>Voucher</span>
                <span>Worth</span>
                <span>Expiry</span>
                <span>On wheels</span>
                <span className="text-right">State</span>
              </div>
              <ul className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
                {rows.map((row) => {
                  const refused = notSetUp(row);
                  const uses = row.usedBy ?? [];
                  return (
                    <li key={row.id} className={row.archivedAt ? 'opacity-60' : undefined}>
                      <button
                        type="button"
                        onClick={() => {
                          setWriteError(null);
                          setOpen(row);
                        }}
                        className="flex w-full min-w-0 flex-wrap gap-x-3.5 gap-y-1 rounded-[12px] px-3 py-[11px] text-left text-[13.5px] hover-elevate @xl:grid @xl:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_84px_minmax(0,1fr)_92px] @xl:items-start"
                      >
                        <span className="flex min-w-0 basis-full flex-col @xl:basis-auto">
                          <span className="font-semibold break-words">{row.nameEn}</span>
                          {row.nameTh && <span className="text-xs text-muted-foreground">{row.nameTh}</span>}
                          {refused && !row.archivedAt && (
                            <span className="mt-0.5 inline-flex items-start gap-1.5 text-xs text-status-warn">
                              <StatusMark tone="warn" className="mt-0.5 w-2.5 h-2.5" />
                              {refused}
                            </span>
                          )}
                          <span className="mt-0.5 text-xs text-muted-foreground">
                            {/* What a slip shows once a booth is published: the list knows the type,
                                not the version each booth is running, and a saved title reaches paper
                                only with a publish (clearing one too). */}
                            {isWorded(row)
                              ? 'Slip: the park’s own words, once a booth using it is published'
                              : 'Slip: the prize’s name and the standard line, once a booth using it is published'}
                          </span>
                        </span>
                        <span className="min-w-0 font-semibold break-words">{worthOf(row)}</span>
                        <span className="text-muted-foreground tabular-nums">{expiryText(row.expiryDays)}</span>
                        <span className="min-w-0 text-xs text-muted-foreground break-words @xl:text-[13px]">
                          {uses.length === 0
                            ? 'on no booth prize'
                            : `on ${uses.map((u) => `${u.boothName} (${u.prizeName})`).join(', ')}`}
                        </span>
                        <span className="@xl:justify-self-end">
                          {row.archivedAt ? (
                            <StatusChip tone="idle">archived</StatusChip>
                          ) : !row.active ? (
                            <StatusChip tone="warn">switched off</StatusChip>
                          ) : (
                            <StatusChip tone="ok">Live</StatusChip>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardShell>

        <Rail span={4}>
          <CardShell icon={PenLine} title="Words on the slip">
            <p className="text-[12.5px] leading-normal text-muted-foreground">
              A type can carry its own slip wording — a title, an instruction and terms, in English and
              Thai. Left empty, a slip prints the prize’s name and the standard line. Either reaches
              paper when a booth using the type is published.
            </p>
            {worded ? (
              <>
                <div
                  className="rounded-[10px] border border-border bg-background p-3.5 font-mono text-[11px] leading-[1.7]"
                  aria-label={`The words ${worded.nameEn} carries`}
                >
                  {worded.titleEn && <div className="font-bold">{worded.titleEn}</div>}
                  {worded.titleTh && <div>{worded.titleTh}</div>}
                  {(worded.instructionEn || worded.instructionTh) && (
                    <div className="mt-1.5 text-muted-foreground">
                      {worded.instructionEn && <div>{worded.instructionEn}</div>}
                      {worded.instructionTh && <div>{worded.instructionTh}</div>}
                    </div>
                  )}
                  {(worded.termsEn || worded.termsTh) && (
                    <div className="mt-1.5 border-t border-dashed border-foreground/25 pt-1.5 text-muted-foreground/80">
                      {worded.termsEn && <div>{worded.termsEn}</div>}
                      {worded.termsTh && <div>{worded.termsTh}</div>}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  As typed on <span className="font-semibold text-foreground">{worded.nameEn}</span> — the
                  slip preview in its editor shows the whole slip.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-auto self-start rounded-full border-primary px-4 font-bold text-primary-ink"
                  onClick={() => {
                    setWriteError(null);
                    setOpen(worded);
                  }}
                >
                  {canManage ? 'Edit wording' : 'Open its wording'}
                </Button>
              </>
            ) : (
              <RailNote>
                No live type carries words of its own yet, so every slip prints its prize’s name and the
                standard line. Open a type to write some.
              </RailNote>
            )}
          </CardShell>

          <CardShell icon={ScrollText} title="Every booth voucher" className="flex-1">
            <p className="text-[12.5px] text-muted-foreground">
              Rules the till applies to all of them — they are not settings of a type.
            </p>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              <li>Redeemed online only: a till working offline refuses a booth voucher.</li>
              <li>Used once. A second scan says when, where and by whom it was redeemed.</li>
              <li>One voucher per sale, and never beside a promo code.</li>
              <li>
                Any branch of the park redeems it — but a free product only where its product is on
                sale, and a 1+1 only where a ticket package of the same name is sold.
              </li>
            </ul>
            <CardFoot>A voucher’s worth is read from its type when the slip is scanned.</CardFoot>
          </CardShell>
        </Rail>
      </PageGrid>

      {open !== null && (
        <VoucherTypeEditor
          // The drawer seeds its form once, so another type is another component.
          key={open === 'new' ? 'new-voucher-type' : open.id}
          definition={open === 'new' ? null : open}
          linkOptions={linkOptions}
          linkOptionsFailed={linkOptionsFailed}
          saving={busy}
          readOnly={!canManage}
          error={writeError}
          onSave={save}
          onArchive={(row) => void write(() => boothApi.archiveDefinition(row.id))}
          onRestore={(row) => void write(() => boothApi.restoreDefinition(row.id))}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
