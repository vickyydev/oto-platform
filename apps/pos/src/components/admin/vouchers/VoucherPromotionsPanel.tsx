import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Megaphone, Pencil, Save, X } from 'lucide-react';
import type { VoucherTarget } from '@oto/shared';
import { api } from '@/api/client';
import { menuApi, type ApiMenuCategory } from '@/api/menu';
import {
  voucherPromotionsApi,
  type VoucherCampaignRow,
  type VoucherDefinitionRow,
} from '@/api/voucherPromotions';
import { useOperator } from '@/auth/OperatorContext';
import { getBranches } from '@/store/catalogStore';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReportCard, EmptyRow, ShellBanner, thbFromSatang } from '../reports/shared';

/**
 * S2-14a round 5 — PROMOTIONAL VOUCHERS in the back office (plan
 * docs/progress/plans/wallet/PLAN.md §2.7).
 *
 * Two cards, both the platform's:
 *
 *   - Voucher definitions: each type's promotional rules — what a discount
 *     comes off (the ticket order, a menu category, named menu items, F&B,
 *     the shop, or one ticket package), the global redemption limit (with how
 *     many are used), the limit per guest, and the window on the park's
 *     trading day. Saved through `PATCH /voucher-definitions/:id`, which checks
 *     the rules whole and refuses in its own words.
 *   - Campaigns: mint a batch of unique codes of one type at one park, and
 *     download its codes as CSV. The codes never appear on screen.
 *
 * Nothing here decides a rule or computes a figure.
 */

type TargetKind = 'tickets' | 'ticketType' | 'fnb' | 'fnbCategory' | 'menuItems' | 'merch';

const TARGET_LABEL: Record<TargetKind, string> = {
  tickets: 'The ticket order',
  ticketType: 'One ticket package',
  fnb: 'All food & drink',
  fnbCategory: 'A menu category',
  menuItems: 'Named menu items',
  merch: 'The shop',
};

interface LinkOptions {
  products: Array<{ id: string; name: string; kind: string; branchName: string | null }>;
  packages: Array<{ id: string; name: string; branchName: string }>;
}

function valueText(d: VoucherDefinitionRow): string {
  if (d.kind === 'wallet_credit') return `${thbFromSatang(d.valueSatang ?? 0)} credit`;
  if (d.kind === 'free_item') return 'Free item';
  if (d.kind === 'free_ticket') return '1+1 kids ticket';
  if (d.kind === 'manual') return 'Gift';
  return d.valueType === 'percent' ? `${(d.valueBp ?? 0) / 100}% off` : `${thbFromSatang(d.valueSatang ?? 0)} off`;
}

function windowText(d: Pick<VoucherDefinitionRow, 'validFrom' | 'validUntil'>): string {
  if (!d.validFrom && !d.validUntil) return 'Always';
  return `${d.validFrom ?? '…'} → ${d.validUntil ?? '…'}`;
}

/** The editor's draft of one definition's rules. */
interface Draft {
  targetKind: TargetKind;
  targetRef: string;
  usageLimit: string;
  perCustomerLimit: string;
  validFrom: string;
  validUntil: string;
}

function draftOf(d: VoucherDefinitionRow): Draft {
  const t = d.target;
  const ref =
    !t
      ? ''
      : t.kind === 'ticketType'
        ? t.ticketTypeId
        : t.kind === 'fnbCategory'
          ? t.category
          : t.kind === 'menuItems'
            ? t.menuItemIds.join(',')
            : '';
  return {
    targetKind: (t?.kind ?? 'tickets') as TargetKind,
    targetRef: ref,
    usageLimit: d.usageLimit?.toString() ?? '',
    perCustomerLimit: d.perCustomerLimit?.toString() ?? '',
    validFrom: d.validFrom ?? '',
    validUntil: d.validUntil ?? '',
  };
}

function targetOf(draft: Draft): VoucherTarget | null {
  switch (draft.targetKind) {
    case 'tickets':
      return null;
    case 'fnb':
      return { kind: 'fnb' };
    case 'merch':
      return { kind: 'merch' };
    case 'ticketType':
      return { kind: 'ticketType', ticketTypeId: draft.targetRef };
    case 'fnbCategory':
      return { kind: 'fnbCategory', category: draft.targetRef };
    case 'menuItems':
      return { kind: 'menuItems', menuItemIds: draft.targetRef.split(',').filter(Boolean) };
  }
}

const limitOf = (text: string): number | null => (text.trim() === '' ? null : Number(text));

const selectClass =
  'h-9 rounded-xl border border-foreground/10 bg-black/20 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';

export function VoucherPromotionsPanel() {
  const { can } = useOperator();
  const canManage = can('admin:booth:manage');
  const [defs, setDefs] = useState<VoucherDefinitionRow[]>([]);
  const [campaigns, setCampaigns] = useState<VoucherCampaignRow[]>([]);
  const [links, setLinks] = useState<LinkOptions>({ products: [], packages: [] });
  const [categories, setCategories] = useState<ApiMenuCategory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [campaign, setCampaign] = useState({ definitionId: '', branchId: '', name: '', quantity: '100' });
  const [minting, setMinting] = useState(false);

  const branches = useMemo(() => getBranches().filter((b) => b.apiId), []);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [d, c] = await Promise.all([voucherPromotionsApi.definitions(), voucherPromotionsApi.campaigns()]);
      setDefs(d.definitions);
      setCampaigns(c.campaigns);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The vouchers could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
    void api
      .get<LinkOptions>('/voucher-definitions/link-options')
      .then(setLinks)
      .catch(() => undefined);
    const first = branches[0]?.apiId;
    if (first) {
      void menuApi
        .load(first)
        .then((m) => setCategories(m.categories.filter((c) => !c.archivedAt)))
        .catch(() => undefined);
    }
  }, [reload, branches]);

  const save = async (d: VoucherDefinitionRow) => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const answer = await voucherPromotionsApi.saveRules(d.id, {
        ...(d.kind === 'discount' ? { target: targetOf(draft) } : {}),
        usageLimit: limitOf(draft.usageLimit),
        perCustomerLimit: limitOf(draft.perCustomerLimit),
        validFrom: draft.validFrom || null,
        validUntil: draft.validUntil || null,
      });
      setDefs((rows) => rows.map((r) => (r.id === d.id ? { ...r, ...answer.definition } : r)));
      setEditing(null);
      toast({ title: 'Promotion saved', description: d.nameEn });
    } catch (err) {
      toast({ title: 'Not saved', description: err instanceof Error ? err.message : 'The rules were not saved.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const mint = async () => {
    const quantity = Number(campaign.quantity);
    if (minting || !campaign.definitionId || !campaign.branchId || !campaign.name.trim() || !Number.isInteger(quantity)) return;
    setMinting(true);
    try {
      const answer = await voucherPromotionsApi.mintCampaign({
        definitionId: campaign.definitionId,
        branchId: campaign.branchId,
        name: campaign.name.trim(),
        quantity,
      });
      setCampaigns((rows) => [answer.campaign, ...rows]);
      setCampaign((c) => ({ ...c, name: '' }));
      toast({ title: 'Campaign minted', description: `${answer.campaign.quantity} codes — download them below.` });
    } catch (err) {
      toast({ title: 'Not minted', description: err instanceof Error ? err.message : 'The campaign was not minted.', variant: 'destructive' });
    } finally {
      setMinting(false);
    }
  };

  const refOptions = (kind: TargetKind) => {
    if (kind === 'ticketType') return links.packages.map((p) => ({ id: p.id, name: `${p.name} · ${p.branchName}` }));
    if (kind === 'fnbCategory') return categories.map((c) => ({ id: c.id, name: c.name }));
    if (kind === 'menuItems') return links.products.filter((p) => p.kind === 'menu').map((p) => ({ id: p.id, name: p.name }));
    return [];
  };

  const live = defs.filter((d) => !d.archivedAt);

  return (
    <div className="flex flex-col gap-5">
      {loadError && <ShellBanner>The vouchers could not be loaded from the platform — {loadError}</ShellBanner>}

      <ReportCard title="Voucher definitions — promotional rules">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Voucher</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Comes off</TableHead>
              <TableHead className="text-right">Used / limit</TableHead>
              <TableHead className="text-right">Per guest</TableHead>
              <TableHead>Window</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {live.length === 0 && <EmptyRow colSpan={7} label="No voucher definitions yet." />}
            {live.map((d) =>
              editing === d.id && draft ? (
                <TableRow key={d.id}>
                  <TableCell colSpan={7}>
                    <div className="flex flex-col gap-2" data-testid="voucher-rules-editor">
                      <div className="font-medium">{d.nameEn}</div>
                      {d.kind === 'discount' && (
                        <div className="flex flex-wrap gap-2">
                          <select
                            className={selectClass}
                            aria-label="Comes off"
                            value={draft.targetKind}
                            onChange={(e) => setDraft({ ...draft, targetKind: e.target.value as TargetKind, targetRef: '' })}
                          >
                            {(Object.keys(TARGET_LABEL) as TargetKind[]).map((k) => (
                              <option key={k} value={k}>
                                {TARGET_LABEL[k]}
                              </option>
                            ))}
                          </select>
                          {refOptions(draft.targetKind).length > 0 && (
                            <select
                              className={selectClass}
                              aria-label="Which"
                              multiple={draft.targetKind === 'menuItems'}
                              value={draft.targetKind === 'menuItems' ? draft.targetRef.split(',').filter(Boolean) : draft.targetRef}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  targetRef:
                                    draft.targetKind === 'menuItems'
                                      ? Array.from(e.target.selectedOptions).map((o) => o.value).join(',')
                                      : e.target.value,
                                })
                              }
                            >
                              {draft.targetKind !== 'menuItems' && <option value="">Choose…</option>}
                              {refOptions(draft.targetKind).map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Input className="w-36" type="number" min={1} placeholder="Limit (all guests)" aria-label="Usage limit" value={draft.usageLimit} onChange={(e) => setDraft({ ...draft, usageLimit: e.target.value })} />
                        <Input className="w-36" type="number" min={1} placeholder="Limit per guest" aria-label="Per-guest limit" value={draft.perCustomerLimit} onChange={(e) => setDraft({ ...draft, perCustomerLimit: e.target.value })} />
                        <Input className="w-40" type="date" aria-label="Valid from" value={draft.validFrom} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} />
                        <Input className="w-40" type="date" aria-label="Valid until" value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} />
                      </div>
                      <p className="text-xs text-foreground/50">
                        Empty means no limit, or no bound on that side. The window is the park&apos;s trading day; a walk-in is not
                        held to the per-guest limit.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" disabled={saving} onClick={() => void save(d)}>
                          <Save className="w-3.5 h-3.5 mr-1" />
                          {saving ? 'Saving…' : 'Save rules'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          <X className="w-3.5 h-3.5 mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="font-medium">{d.nameEn}</div>
                    <div className="text-xs font-mono text-foreground/45">{d.code}</div>
                  </TableCell>
                  <TableCell>{valueText(d)}</TableCell>
                  <TableCell className="text-xs text-foreground/70">
                    {d.kind === 'discount' ? TARGET_LABEL[(d.target?.kind ?? 'tickets') as TargetKind] : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.redeemedVouchers}
                    {d.usageLimit !== null ? ` / ${d.usageLimit}` : ''}
                    {d.usageLimit !== null && d.redeemedVouchers >= d.usageLimit && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        used up
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{d.perCustomerLimit ?? '—'}</TableCell>
                  <TableCell className="text-xs text-foreground/70">{windowText(d)}</TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(d.id);
                          setDraft(draftOf(d));
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" />
                        Rules
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard title="Campaigns">
        {canManage && (
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="voucher-campaign-form">
            <select className={selectClass} aria-label="Voucher type" value={campaign.definitionId} onChange={(e) => setCampaign({ ...campaign, definitionId: e.target.value })}>
              <option value="">Voucher type…</option>
              {live.filter((d) => d.active).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.nameEn}
                </option>
              ))}
            </select>
            <select className={selectClass} aria-label="Park" value={campaign.branchId} onChange={(e) => setCampaign({ ...campaign, branchId: e.target.value })}>
              <option value="">Park…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.apiId!}>
                  {b.name}
                </option>
              ))}
            </select>
            <Input className="w-48" placeholder="Campaign name" aria-label="Campaign name" value={campaign.name} onChange={(e) => setCampaign({ ...campaign, name: e.target.value })} />
            <Input className="w-28" type="number" min={1} max={5000} aria-label="How many codes" value={campaign.quantity} onChange={(e) => setCampaign({ ...campaign, quantity: e.target.value })} />
            <Button size="sm" disabled={minting} onClick={() => void mint()}>
              <Megaphone className="w-3.5 h-3.5 mr-1" />
              {minting ? 'Minting…' : 'Mint codes'}
            </Button>
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Voucher type</TableHead>
              <TableHead className="text-right">Codes</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead>Minted</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 && <EmptyRow colSpan={6} label="No campaigns minted yet." />}
            {campaigns.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="font-mono text-xs">{c.definitionCode}</TableCell>
                <TableCell className="text-right tabular-nums">{c.quantity}</TableCell>
                <TableCell className="text-right tabular-nums">{c.redeemed}</TableCell>
                <TableCell className="text-xs text-foreground/60">{new Date(c.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  {canManage && (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      href={voucherPromotionsApi.codesHref(c.id)}
                      download
                    >
                      <Download className="w-3.5 h-3.5" />
                      Codes (CSV)
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>
    </div>
  );
}
