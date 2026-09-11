import { EdcTerminal, ReconLine } from '@/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { channelLabel, lineFlag, ReconFlag } from '@/lib/endOfDay';
import { AmountInput } from './AmountInput';
import { cn } from '@/lib/utils';

const DIFF_CLASS: Record<ReconFlag, string> = {
  ok: 'text-emerald-400',
  off: 'text-rose-400',
  pending: 'text-muted-foreground',
};

function diffText(line: ReconLine): string {
  if (line.actualTHB === null) return '—';
  const sign = line.differenceTHB > 0 ? '+' : line.differenceTHB < 0 ? '-' : '';
  return `${sign}฿${Math.abs(line.differenceTHB).toLocaleString()}`;
}

/**
 * The reconciliation grid: one row per payment channel (each EDC terminal listed
 * separately by TID) showing Expected | Actual | Difference. The cash row's actual
 * is derived from the drawer count (entered in the Cash count card), so it's shown
 * read-only here. Difference turns green within tolerance, red when off.
 */
export function ReconTable({
  lines,
  terminals,
  readOnly,
  onActual,
}: {
  lines: ReconLine[];
  terminals: EdcTerminal[];
  readOnly: boolean;
  onActual: (channel: string, value: number | null) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[42%]">Channel</TableHead>
          <TableHead className="text-right">Expected</TableHead>
          <TableHead className="text-right w-[170px]">Actual</TableHead>
          <TableHead className="text-right">Difference</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => {
          const flag = lineFlag(l);
          const label = channelLabel(l.channel, terminals);
          return (
            <TableRow key={l.channel}>
              <TableCell className="font-medium">{label}</TableCell>
              <TableCell className="text-right tabular-nums">
                ฿{l.expectedTHB.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                {l.channel === 'cash' ? (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {l.actualTHB === null
                      ? 'from cash count'
                      : `฿${l.actualTHB.toLocaleString()}`}
                  </span>
                ) : (
                  <AmountInput
                    ariaLabel={`Actual for ${label}`}
                    value={l.actualTHB}
                    disabled={readOnly}
                    onChange={(v) => onActual(l.channel, v)}
                  />
                )}
              </TableCell>
              <TableCell
                className={cn('text-right tabular-nums font-semibold', DIFF_CLASS[flag])}
              >
                {diffText(l)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
