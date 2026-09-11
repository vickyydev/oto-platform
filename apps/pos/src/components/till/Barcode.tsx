import { cn } from '@/lib/utils';

// Deterministic mock 1D barcode for INTERNAL codes (bracelets/booking refs
// scanned by the venue's own system). A thin band suits a barcode far better
// than a square QR, and it prints cleanly in black ink. For payment codes that
// external banking apps must scan, use a real encoder instead.
export function Barcode({ seed, className }: { seed: string; className?: string }) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const widths: number[] = [];
  for (let i = 0; i < 32; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    widths.push((h & 3) + 1); // 1–4 units wide
  }

  return (
    <div className={cn('flex items-stretch gap-px bg-white', className)}>
      {widths.map((w, i) => (
        <div
          key={i}
          className={i % 2 === 0 ? 'bg-stone-900' : 'bg-white'}
          style={{ flexGrow: w }}
        />
      ))}
    </div>
  );
}
