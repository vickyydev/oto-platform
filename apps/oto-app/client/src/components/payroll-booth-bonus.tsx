import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { payrollCall } from '@/lib/payroll/api';
import {
  windows,
  windowLabel,
  type BoothReport,
  type BoothSettings,
  type BonusWindow,
} from '@shared/booth-bonus';

const settingsPath = '/api/payroll/setup/rewards/booth';
const field = 'rounded-md border bg-background px-2 py-1.5';
const baht = (satang: number) =>
  (satang / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
export function BoothBonusCard() {
  const settings = useQuery({
    queryKey: [settingsPath],
    queryFn: () => payrollCall<BoothSettings>('GET', settingsPath),
  });
  if (settings.isError) return <p role="alert">Booth voucher settings could not be loaded.</p>;
  return settings.data ? (
    <Editor key={settings.data.rules[0]?.from ?? 'new'} settings={settings.data} />
  ) : null;
}
function Editor({ settings }: { settings: BoothSettings }) {
  const client = useQueryClient();
  const current = settings.rules.find((r) => r.from <= settings.today);
  const [amount, setAmount] = useState(String((current?.rateSatang ?? 1000) / 100));
  const [window, setWindow] = useState<BonusWindow>(current?.window ?? 'same-day');
  const [from, setFrom] = useState(settings.today);
  const [reason, setReason] = useState(''),
    [editing, setEditing] = useState(!current),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(''),
    [own, setOwn] = useState('');
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await payrollCall('POST', settingsPath, {
        from,
        rateSatang: Math.round(Number(amount) * 100),
        window,
        reason,
        overrides: Object.entries(overrides).map(([employeeId, rateSatang]) => ({
          employeeId,
          rateSatang,
        })),
      });
      await client.invalidateQueries({ queryKey: [settingsPath] });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the bonus.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card id="booth-voucher-bonus" className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Booth voucher bonus</h2>
        {settings.canManage && !editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>
      {settings.canManage && editing ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            Bonus per used voucher (baht)
            <input
              className={field}
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Counts if the voucher is used within
            <select
              className={field}
              value={window}
              onChange={(e) => setWindow(e.target.value as BonusWindow)}
            >
              {windows.map((w) => (
                <option key={w} value={w}>
                  {windowLabel[w]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            From
            <input
              className={field}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <p>
          {current
            ? `${baht(current.rateSatang)} baht per used voucher · ${windowLabel[current.window]} · from ${current.from}`
            : 'No rule in force yet.'}
        </p>
      )}
      <details>
        <summary>A different rate for a person</summary>
        <ul className="my-2 text-sm">
          {settings.rates.map((r) => (
            <li key={r.employeeId}>
              {r.name} · {baht(r.rateSatang)} baht · from {r.from}
            </li>
          ))}
        </ul>
        {settings.canManage && editing && (
          <div className="flex flex-wrap gap-2">
            <select
              className={field}
              aria-label="Person"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setOwn('');
              }}
            >
              <option value="">Choose a person</option>
              {settings.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className={field}
              aria-label="Personal rate in baht"
              type="number"
              min="0"
              step="0.01"
              placeholder="Use card rate"
              value={own}
              onChange={(e) => setOwn(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={
                !selected || (own !== '' && (!Number.isFinite(Number(own)) || Number(own) < 0))
              }
              onClick={() => {
                setOverrides({
                  ...overrides,
                  [selected]: own === '' ? null : Math.round(Number(own) * 100),
                });
                setSelected('');
                setOwn('');
              }}
            >
              Apply from date
            </Button>
            {Object.entries(overrides).map(([id, rate]) => (
              <span key={id}>
                {settings.people.find((x) => x.id === id)?.name} ·{' '}
                {rate === null ? 'card rate' : baht(rate) + ' baht'}
              </span>
            ))}
          </div>
        )}
      </details>
      {settings.rules.length > 0 && (
        <details>
          <summary>Dated rules</summary>
          <ul className="text-sm">
            {settings.rules.map((r) => (
              <li key={r.from}>
                {r.from} · {baht(r.rateSatang)} baht · {windowLabel[r.window]}
              </li>
            ))}
          </ul>
        </details>
      )}
      {settings.canManage && editing && (
        <div className="flex flex-wrap gap-2">
          <input
            className={field}
            aria-label="Reason for change"
            placeholder="Reason for change"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            disabled={saving || !reason.trim() || amount === '' || Number(amount) < 0 || !from}
            onClick={save}
          >
            Save dated rule
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
export function BoothBonusReport({ month }: { month: string }) {
  const [open, setOpen] = useState(false),
    [byBooth, setByBooth] = useState(false);
  const path = '/api/payroll/booth-vouchers/' + month;
  const report = useQuery({
    queryKey: [path],
    queryFn: () => payrollCall<BoothReport>('GET', path),
    enabled: open,
  });
  const rows = byBooth ? report.data?.booths : report.data?.people;
  return (
    <details
      className="rounded-md border p-3"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Booth voucher report · {month}</summary>
      {report.isLoading && <p>Reading the booth and till records…</p>}
      {report.isError && <p role="alert">The voucher report could not be loaded.</p>}
      {report.data && (
        <>
          <label>
            Show{' '}
            <select
              className={field}
              value={byBooth ? 'booth' : 'person'}
              onChange={(e) => setByBooth(e.target.value === 'booth')}
            >
              <option value="person">By person</option>
              <option value="booth">By booth and issue day</option>
            </select>
          </label>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption>Vouchers issued in {month} and their uses to date</caption>
              <thead>
                <tr>
                  {[
                    'Name',
                    'Issued',
                    'Inside time limit',
                    'Outside time limit',
                    'Share used',
                    'Total sale spend',
                    'Average sale spend',
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows?.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>{r.issued}</td>
                    <td>{r.inside}</td>
                    <td>{r.outside}</td>
                    <td>{r.issued ? Math.round((100 * r.redeemed) / r.issued) : 0}%</td>
                    <td>{baht(r.spendSatang)}</td>
                    <td>{baht(r.sales ? r.spendSatang / r.sales : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows?.length && <p>No qualifying issue records for this month.</p>}
          {!!report.data.flags.length && (
            <details>
              <summary>Manager review ({report.data.flags.length})</summary>
              <ul>
                {report.data.flags.map((f, i) => (
                  <li key={f.voucherId + '-' + i}>
                    {f.booth} · {f.voucherId} · {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </details>
  );
}
