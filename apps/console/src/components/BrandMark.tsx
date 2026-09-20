import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo-oto.png';

/** The park's wordmark, the same file the till's header uses. */
export function BrandMark({ className }: { className?: string }) {
  return <img src={logoUrl} alt="Oto" className={cn('h-8 w-auto', className)} />;
}
