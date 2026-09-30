import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { Plus, RefreshCw } from 'lucide-react';
import { useSession } from '@/auth/SessionContext';
import {
  EmptyState,
  Loading,
  Panel,
  RouteUnavailable,
  StaleNote,
  Unreadable,
} from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CheckRow } from '@/components/Form';
import { StatusPill } from '@/components/Status';
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

  if (list.state === 'absent') {
    return (
      <RouteUnavailable
        what="Voucher types"
        detail="This deployment does not serve the voucher type routes yet — SCRUM-400."
      />
    );
  }

  const rows = list.value;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Voucher types"
        description="Shared by every booth at every branch; a prize picks one on the Booths page. Open one to change it."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load(showArchived)} disabled={list.refreshing}>
              <RefreshCw className={list.refreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
              Refresh
            </Button>
            {canManage && (
              <Button
                size="sm"
                onClick={() => {
                  setWriteError(null);
                  setOpen('new');
                }}
              >
                <Plus className="w-4 h-4" />
                New voucher type
              </Button>
            )}
          </>
        }
      >
        {!canManage && (
          <p className="mb-3 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
            You can read the voucher types but not change them. Creating and editing them needs{' '}
            <code className="font-mono text-xs">admin:booth:manage</code>.
          </p>
        )}
        {list.state === 'stale' && list.readAt !== null && (
          <StaleNote readAt={list.readAt} message={list.error} onRetry={() => void load(showArchived)} />
        )}
        {list.state === 'failed' ? (
          <Unreadable what="The voucher types" message={list.error} onRetry={() => void load(showArchived)} />
        ) : list.state === 'unread' ? (
          <Loading what="voucher types" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No voucher types yet"
            detail="A prize needs one before it can be published. Create the first with “New voucher type”."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((row) => {
              const refused = notSetUp(row);
              const uses = row.usedBy ?? [];
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setWriteError(null);
                      setOpen(row);
                    }}
                    className="w-full text-left py-3 px-1 flex flex-col gap-1 rounded-lg hover-elevate"
                  >
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold">{row.nameEn}</span>
                      {row.nameTh && <span className="text-sm text-muted-foreground">{row.nameTh}</span>}
                      {row.archivedAt ? (
                        <StatusPill tone="idle">archived</StatusPill>
                      ) : !row.active ? (
                        <StatusPill tone="warn">switched off</StatusPill>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {expiryText(row.expiryDays)}
                      </span>
                    </span>
                    <span className="text-sm">{worthOf(row)}</span>
                    {refused && !row.archivedAt && (
                      <span className="text-xs" style={{ color: 'hsl(var(--status-warn))' }}>
                        {refused}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {/* What a slip shows once a booth is published: the list knows the type,
                          not the version each booth is running, and a saved title reaches paper
                          only with a publish (clearing one too). */}
                      {isWorded(row)
                        ? 'Slip: the park’s own words, once a booth using it is published'
                        : 'Slip: the prize’s name and the standard line, once a booth using it is published'}
                      {' · '}
                      {uses.length === 0
                        ? 'on no booth prize'
                        : `on ${uses.map((u) => `${u.boothName} (${u.prizeName})`).join(', ')}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 border-t pt-2">
          <CheckRow
            checked={showArchived}
            onChange={setShowArchived}
            label="Show archived voucher types"
            detail="Archived types are off every list a prize picks from; vouchers already printed under them are still honoured."
          />
        </div>
      </Panel>

      <Panel
        title="Every booth voucher, whatever its type"
        description="Rules the till applies to all of them — they are not settings of a type."
      >
        <ul className="flex flex-col gap-1.5 text-sm">
          <li>Redeemed online only: a till working offline refuses a booth voucher.</li>
          <li>Used once. A second scan says when, where and by whom it was redeemed.</li>
          <li>One voucher per sale, and never beside a promo code.</li>
          <li>
            Any branch of the park redeems it — but a free product only where its product is on
            sale, and a 1+1 only where a ticket package of the same name is sold.
          </li>
        </ul>
      </Panel>

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
    </div>
  );
}
