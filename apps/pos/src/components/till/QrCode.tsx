import { cn } from '@/lib/utils';
import { buildQrMatrix } from '@/lib/qr';

export function QrCode({ seed, className }: { seed: string; className?: string }) {
  const { size, cells, isFinder } = buildQrMatrix(seed);

  return (
    <div className={cn('bg-white rounded-lg p-1.5 shrink-0', className)}>
      <div
        className="grid w-full h-full gap-px"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      >
        {cells.map((on, i) => {
          const r = Math.floor(i / size);
          const c = i % size;
          const filled = isFinder(r, c) || on;
          return (
            <div
              key={i}
              className={cn('aspect-square rounded-[1px]', filled ? 'bg-slate-900' : 'bg-white')}
            />
          );
        })}
      </div>
    </div>
  );
}
