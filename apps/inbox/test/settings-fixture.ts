// FICTIONAL TEST DATA for the settings pages (SCRUM-1044): every template
// text is "ZZ TEST", every id a made-up UUID. One row for each state the
// templates page shows: every approval, inactive, archived, a template still
// in English, and the birthday brochure with and without a file.
import type { ManagedTemplate } from '@/api/inbox';

const id = (n: number) => `0192f0a0-1234-7abc-8def-0000000005${String(n).padStart(2, '0')}`;

export function settingsTemplates(parkId: string): ManagedTemplate[] {
  const base = (n: number, over: Partial<ManagedTemplate>): ManagedTemplate => ({
    id: id(n),
    key: 'welcome',
    language: 'en',
    channel: null,
    branchId: null,
    body: 'ZZ TEST Hello {{name}}, welcome to the park.',
    attachmentFileIds: [],
    approvalStatus: 'not_required',
    needsTranslation: false,
    providerTemplateName: null,
    active: true,
    variables: ['name'],
    updatedByAccountId: null,
    updatedAt: '2026-11-19T04:00:00.000Z',
    archivedAt: null,
    ...over,
  });
  return [
    base(1, {}),
    base(2, { language: 'ru', needsTranslation: true, body: 'ZZ TEST Hello {{name}}, welcome (English source).' }),
    base(3, { language: 'th', channel: 'whatsapp', branchId: parkId, approvalStatus: 'pending', providerTemplateName: 'zz_test_welcome' }),
    base(4, { key: 'follow_up', approvalStatus: 'approved', body: 'ZZ TEST Are you still there?\nWe are happy to help.' }),
    base(5, { key: 'follow_up', language: 'ru', approvalStatus: 'rejected', active: false }),
    base(6, { key: 'closing_gm', archivedAt: '2026-11-18T04:00:00.000Z', body: 'ZZ TEST A closing line no longer used.' }),
    base(7, { key: 'handover_birthday', body: 'ZZ TEST Our birthday team will be with you shortly.', attachmentFileIds: [id(90)] }),
    base(8, { key: 'handover_birthday', branchId: parkId, body: 'ZZ TEST The park’s birthday team will be with you shortly.' }),
  ];
}
