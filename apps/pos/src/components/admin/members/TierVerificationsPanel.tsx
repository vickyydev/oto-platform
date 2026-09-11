import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Info, RefreshCw } from 'lucide-react';
import { membersApi, type ApiTierVerificationRecord } from '@/api/platform';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tierLabel } from '@/lib/membership';

/**
 * Record-checking view (client extension): every tier upgrade with the member,
 * the document that was checked, its expiry, the staff account that checked it
 * (stamped server-side from the session) and the exact time. Read-only — the
 * records are created at the counter via the POS verify modal.
 */
export function TierVerificationsPanel() {
  const [records, setRecords] = useState<ApiTierVerificationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    return membersApi
      .tierVerifications()
      .then((res) => setRecords(res.verifications))
      .catch((err: unknown) =>
        toast({
          title: "Couldn't load verification records",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        }),
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground/40">
          {records.length} record{records.length === 1 ? '' : 's'}
        </span>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          {loading
            ? 'Loading records…'
            : 'No tier verifications recorded yet. Records appear here when staff verify a discounted rate at the counter.'}
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden lg:block overflow-hidden rounded-2xl border border-foreground/10">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Member</TableHead>
                  <TableHead className="w-40">Upgrade</TableHead>
                  <TableHead className="w-44">Document</TableHead>
                  <TableHead className="w-32">Expires</TableHead>
                  <TableHead className="w-40">Checked by</TableHead>
                  <TableHead className="w-44">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{r.member.nickname}</div>
                      <div className="text-xs tabular-nums text-foreground/50">{r.member.phone}</div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-sm">
                        <span className="text-foreground/50">{tierLabel(r.fromTier)}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-foreground/30" />
                        <span className="font-semibold">{tierLabel(r.toTier)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.evidenceType}
                      {r.note && <div className="text-xs text-foreground/50">{r.note}</div>}
                    </TableCell>
                    <TableCell>
                      {r.evidenceExpiresAt ? (
                        <span
                          className={`text-sm tabular-nums ${
                            r.expired ? 'font-semibold text-destructive' : 'text-foreground/70'
                          }`}
                        >
                          {r.evidenceExpiresAt}
                          {r.expired && ' · expired'}
                        </span>
                      ) : (
                        <span className="text-sm text-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <BadgeCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        {r.verifiedBy ?? 'Unknown'}
                      </span>
                      {r.branch && <div className="text-xs text-foreground/40">{r.branch}</div>}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums text-foreground/70">
                      {fmtTime(r.verifiedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile / narrow: stacked cards */}
          <div className="flex flex-col gap-2 lg:hidden">
            {records.map((r) => (
              <div
                key={r.id}
                className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.member.nickname}</div>
                    <div className="text-xs tabular-nums text-foreground/50">{r.member.phone}</div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-sm">
                    <span className="text-foreground/50">{tierLabel(r.fromTier)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-foreground/30" />
                    <span className="font-semibold">{tierLabel(r.toTier)}</span>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground/70">
                  <span>
                    {r.evidenceType}
                    {r.note ? ` — ${r.note}` : ''}
                  </span>
                  {r.evidenceExpiresAt && (
                    <span className={r.expired ? 'font-semibold text-destructive' : ''}>
                      expires {r.evidenceExpiresAt}
                      {r.expired && ' (expired)'}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground/50">
                  <span className="inline-flex items-center gap-1">
                    <BadgeCheck className="w-3.5 h-3.5 text-emerald-500" />
                    {r.verifiedBy ?? 'Unknown'}
                    {r.branch ? ` · ${r.branch}` : ''}
                  </span>
                  <span className="tabular-nums">{fmtTime(r.verifiedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Read-only audit trail — who checked the document is recorded automatically from the signed-in
        account at the counter and cannot be edited.
      </p>
    </div>
  );
}
