import { useEffect, useState } from 'react';
import { BenefitProfile, MenuCategoryDef, Operator } from '@/types';
import { getEffectiveBenefitProfile, updateOperatorBenefits } from '@/mockApi';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { BenefitProfileFields } from './BenefitProfileFields';

/**
 * Per-operator override editor. Off = the operator inherits their role
 * template untouched. On = a custom BenefitProfile stamped onto
 * Operator.benefitProfileOverride, pre-filled from their current effective
 * profile so switching it on doesn't silently blank out their benefit.
 */
export function OperatorOverrideDialog({
  operator,
  categories,
  open,
  onOpenChange,
}: {
  operator: Operator | null;
  categories: MenuCategoryDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [profile, setProfile] = useState<BenefitProfile>({});

  useEffect(() => {
    if (!operator) return;
    setEnabled(!!operator.benefitProfileOverride);
    setProfile(operator.benefitProfileOverride ?? getEffectiveBenefitProfile(operator));
  }, [operator]);

  if (!operator) return null;

  const save = () => {
    updateOperatorBenefits(operator.id, {
      benefitProfileOverride: enabled ? profile : undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{operator.name} — benefit override</DialogTitle>
          <DialogDescription>
            Overrides replace this staff member's role template entirely while enabled.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
          <Label className="text-sm font-semibold">Custom override</Label>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {enabled ? (
          <BenefitProfileFields profile={profile} categories={categories} onChange={setProfile} />
        ) : (
          <p className="text-sm text-foreground/50">
            Currently inheriting the “{operator.benefitRole ?? 'staff'}” role template.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
