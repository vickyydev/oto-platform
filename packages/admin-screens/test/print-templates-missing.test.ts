import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiftedAdminApi } from '../src/api/lifted-api';
import { createCareAdminApi } from '../src/lifted/api/care';
import { TemplatesPanelWithPorts } from '../src/lifted/components/admin/templates/TemplatesPanel';
import type { PrintTemplate } from '../src/lifted/model/types';
import type { TemplatesPanelPorts } from '../src/lifted/runtime/care';

/**
 * SCRUM-707: the way in for a branch that has no saved templates. It is offered
 * only where it can do something: live rows, some printout without one, and a
 * person who may edit this branch's templates.
 */

const LABEL = 'Create missing templates';
const row = (type: PrintTemplate['type']): PrintTemplate => ({
  id: `zz-${type}`, type, name: `ZZ TEST ${type}`, showLogo: false, fields: {},
});
const ALL: PrintTemplate['type'][] = ['receipt', 'kids_wristband', 'adult_wristband', 'kitchen_ticket', 'bar_ticket', 'credit_voucher'];

const panel = (over: Partial<TemplatesPanelPorts>) => renderToStaticMarkup(createElement(TemplatesPanelWithPorts, {
  ports: {
    templates: [], live: true, stationId: null, canEdit: true, createMissing: vi.fn(),
    api: { previewPng: vi.fn(), testPrintTarget: vi.fn(), updateTemplate: vi.fn(), testPrint: vi.fn() },
    ...over,
  } as TemplatesPanelPorts,
}));

describe('Create missing templates', () => {
  it('is offered on a branch with none, and says what it prints until then', () => {
    const html = panel({});
    expect(html).toContain(LABEL);
    expect(html).toContain('It prints every section until one is saved.');
  });

  it('counts what is missing when only some printouts have a row', () => {
    const html = panel({ templates: [row('receipt'), row('credit_voucher')] });
    expect(html).toContain(LABEL);
    expect(html).toContain('4 of 6 printouts have no saved template here.');
  });

  it('is not offered once every printout has a row', () => {
    expect(panel({ templates: ALL.map(row) })).not.toContain(LABEL);
  });

  it('is not offered to somebody who may not edit this branch', () => {
    expect(panel({ canEdit: false })).not.toContain(LABEL);
    expect(panel({ createMissing: undefined })).not.toContain(LABEL);
  });

  it('is not offered over the built-in set or before the list has answered', () => {
    expect(panel({ live: false })).not.toContain(LABEL);
    expect(panel({ loading: true })).not.toContain(LABEL);
  });
});

describe('the write behind it', () => {
  it('posts to this branch and keeps its key across an uncertain retry', async () => {
    const transport = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(),
      deleteWithBody: vi.fn(), href: (path: string) => path, getBlob: vi.fn(), postBlob: vi.fn(), getFile: vi.fn() };
    transport.post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({ created: [], templates: [] });
    const { printApi } = createCareAdminApi(transport as LiftedAdminApi);
    await expect(printApi.createMissingTemplates('zz-park')).rejects.toThrow('Connection lost');
    await printApi.createMissingTemplates('zz-park');
    const [first, second] = transport.post.mock.calls;
    expect(first![0]).toBe('/branches/zz-park/print-templates/create-missing');
    expect(first![2].idempotencyKey).toBeTruthy();
    expect(second![2].idempotencyKey).toBe(first![2].idempotencyKey);
  });
});
