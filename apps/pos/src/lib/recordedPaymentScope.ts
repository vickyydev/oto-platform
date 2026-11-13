import { useEffect, useRef, useState } from 'react';
import type { ApiSale } from '@/api/sales';
import type { SaleWriteOutcome } from './saleWriter';

/** A recorded charge belongs to the exact order scope captured at its write. */
export function useRecordedPaymentScope() {
  const recorded = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const [, revealRecord] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const matches = (sale: ApiSale | null, scope: string): sale is ApiSale =>
    Boolean(sale && recorded.current.get(sale.id) === scope);
  return {
    // A different staff member keeps this scope; a real cart edit does not.
    replay(sale: ApiSale | null, scope: string): SaleWriteOutcome | null {
      return matches(sale, scope)
        ? { ok: true, written: true, saleId: sale.id, sale, replay: true } : null;
    },
    resumeSaleId(sale: ApiSale | null, scope: string): string | undefined {
      return matches(sale, scope) ? sale.id : undefined;
    },
    async record(scope: string, write: () => Promise<SaleWriteOutcome>): Promise<SaleWriteOutcome> {
      // Capture the offered scope before the write. A paused or late answer
      // must never be associated with whatever cart happens to be current.
      const outcome = await write();
      if (outcome.ok && outcome.written && recorded.current.get(outcome.saleId) !== scope) {
        recorded.current.set(outcome.saleId, scope);
        if (mounted.current) revealRecord((version) => version + 1);
      }
      return outcome;
    },
  };
}
