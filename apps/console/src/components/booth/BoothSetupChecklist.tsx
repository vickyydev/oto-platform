import { Panel } from '@/components/Panel';
import type { BoothDraft, BoothStaffRow, BoothStatus } from './boothApi';
import type { Read } from './readState';

export function BoothSetupChecklist({
  draft,
  status,
  staff,
}: {
  draft: Read<BoothDraft | null>;
  status: Read<BoothStatus | null>;
  staff: Read<BoothStaffRow[]>;
}) {
  const d = draft.state === 'read' ? draft.value : null;
  const s = status.state === 'read' ? status.value : null;
  const active = d?.prizes.filter((p) => p.active) ?? [];
  const steps = [
    { id: 'booth-printer', label: 'Printer added to the box', done: Boolean(s?.printer) },
    {
      id: 'booth-station',
      label: 'Booth station with its prefix',
      done: Boolean(d && /^[A-Z0-9]{2}$/.test(d.booth.codePrefix ?? '')),
    },
    {
      id: 'booth-settings',
      label: 'Layout and session length saved',
      done: Boolean(
        d?.settings.layoutId &&
        (d.settings.staffSessionMinutes == null || d.settings.staffSessionMinutes > 0),
      ),
    },
    {
      id: 'booth-staff',
      label: 'Staff with PINs',
      done:
        staff.state === 'read' &&
        staff.value.length > 0 &&
        staff.value.every(
          (p) => p.hasPin && (!p.pinExpiresAt || Date.parse(p.pinExpiresAt) > Date.now()),
        ),
    },
    {
      id: 'booth-prizes',
      label: 'Prizes adding to 100%',
      done: active.length > 0 && active.reduce((sum, p) => sum + p.weightBp, 0) === 10_000,
    },
    { id: 'booth-publish', label: 'Published', done: Boolean(d?.published && !d.changed) },
  ];
  return (
    <Panel
      title="Set up this booth"
      description="Follow these steps in order. A tick confirms the latest saved settings shown on this page."
    >
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.id}>
            <a
              href={'#' + step.id}
              className="flex gap-2 rounded-lg border p-3 text-sm hover:bg-muted"
            >
              <span aria-label={step.done ? 'Complete' : 'To do'}>{step.done ? '✓' : '○'}</span>
              <span>
                {index + 1}. {step.label}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
