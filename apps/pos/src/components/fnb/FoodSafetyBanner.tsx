import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Wristband } from '@/types';

export function FoodSafetyBanner({ wristband, compact = false }: { wristband: Wristband | null; compact?: boolean }) {
  const allergies = wristband?.allergiesMedical?.trim();
  const restriction = wristband?.foodRestrictions?.trim();
  if (!allergies && !restriction) return null;

  return (
    <div className={`${compact ? '' : 'mb-4 '}shrink-0 rounded-xl border border-red-400/60 bg-red-500/15 px-4 py-3 text-red-900 dark:text-red-100`}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700 dark:text-red-300" />
        <div className="min-w-0">
          <div className={`${compact ? 'text-xs' : 'text-sm'} font-bold uppercase tracking-wide text-red-800 dark:text-red-200`}>
            {allergies ? 'Allergy / medical alert' : 'Food restriction'}
            {wristband?.holderName ? ` · ${wristband.holderName}` : ''}
          </div>
          {allergies && <div className={`font-semibold${compact ? ' text-sm' : ''}`}>{allergies}</div>}
          {restriction && <div className={`${compact ? 'text-xs' : 'text-sm'} text-red-900 dark:text-red-100`}>Restriction: {restriction}</div>}
        </div>
      </div>
    </div>
  );
}
