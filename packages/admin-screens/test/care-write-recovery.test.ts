import { describe, expect, it, vi } from 'vitest';
import type { LiftedAdminApi } from '../src/api/lifted-api';
import type { SupervisionPolicy } from '../src/lifted/model/types';
import { createCareAdminApi } from '../src/lifted/api/care';

const branchId = '01900000-0000-7000-8000-000000000001';
const policy: SupervisionPolicy = { bands: [], siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [] };
function host() {
  const transport = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(),
    deleteWithBody: vi.fn(), href: (path: string) => path, getBlob: vi.fn(), postBlob: vi.fn(), getFile: vi.fn() };
  return { transport, api: createCareAdminApi(transport as LiftedAdminApi) };
}

describe('Care write acknowledgement and retry ownership', () => {
  it('retries an uncertain physical print once with its original key; a later confirmed press gets a new key', async () => {
    const { transport, api } = host();
    transport.post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({ jobId: 'ZZ TEST job' });
    await expect(api.printApi.testPrint('ZZ TEST template')).rejects.toThrow('Connection lost');
    await api.printApi.testPrint('ZZ TEST template');
    await api.printApi.testPrint('ZZ TEST template');
    const keys = transport.post.mock.calls.map(call => call[2].idempotencyKey);
    expect(keys[0] === keys[1]).toBe(true); expect(keys[2] === keys[1]).toBe(false);
  });

  it('does not reuse a failed edit key for a changed template body', async () => {
    const { transport, api } = host();
    transport.patch.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({});
    await expect(api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST first' })).rejects.toThrow();
    await api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST second' });
    expect(transport.patch.mock.calls[0]![2].idempotencyKey === transport.patch.mock.calls[1]![2].idempotencyKey).toBe(false);
  });

  it('prints a newly saved template with a fresh intent after an earlier uncertain print', async () => {
    const { transport, api } = host();
    transport.post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({ jobId: 'ZZ TEST job' });
    transport.patch.mockResolvedValue({});
    await expect(api.printApi.testPrint('ZZ TEST template')).rejects.toThrow();
    await api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST new revision' });
    await api.printApi.testPrint('ZZ TEST template');
    expect(transport.post.mock.calls[0]![2].idempotencyKey === transport.post.mock.calls[1]![2].idempotencyKey).toBe(false);
  });

  it('gives a draft restored after a different confirmed edit a new intent', async () => {
    const { transport, api } = host();
    transport.patch.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({});
    await expect(api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST first' })).rejects.toThrow();
    await api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST second' });
    await api.printApi.updateTemplate('ZZ TEST template', { footerText: 'ZZ TEST first' });
    expect(transport.patch.mock.calls[2]![2].idempotencyKey === transport.patch.mock.calls[0]![2].idempotencyKey).toBe(false);
  });

  it('retains the confirmed first policy step when the confirmations request must be retried', async () => {
    const { transport, api } = host();
    transport.put.mockResolvedValueOnce({ policy }).mockRejectedValueOnce(new Error('Confirmations unavailable')).mockResolvedValueOnce({ policy });
    await expect(api.savePolicy(branchId, policy)).rejects.toThrow('Confirmations unavailable');
    expect(await api.savePolicy(branchId, policy)).toEqual(policy);
    expect(transport.put.mock.calls.filter(call => call[0].includes('/policy?'))).toHaveLength(1);
    const confirmations = transport.put.mock.calls.filter(call => call[0].includes('/confirmations?'));
    expect(confirmations).toHaveLength(2);
    expect(confirmations[0]![2].idempotencyKey === confirmations[1]![2].idempotencyKey).toBe(true);
  });

  it('stops after an acknowledged first policy write when its editor loses ownership', async () => {
    const { transport, api } = host(); let current = true;
    transport.put.mockImplementationOnce(async () => { current = false; return { policy }; });
    await expect(api.savePolicy(branchId, policy, () => current)).rejects.toThrow('editor changed');
    expect(transport.put).toHaveBeenCalledTimes(1);
  });

  it('does not skip a policy that another successful draft replaced after a partial save', async () => {
    const { transport, api } = host();
    transport.put.mockResolvedValueOnce({ policy }).mockRejectedValueOnce(new Error('Confirmations unavailable')).mockResolvedValue({ policy });
    await expect(api.savePolicy(branchId, policy)).rejects.toThrow();
    await api.savePolicy(branchId, { ...policy, siblingWaiver: { ...policy.siblingWaiver, enabled: true } });
    await api.savePolicy(branchId, policy);
    expect(transport.put.mock.calls.filter(call => call[0].includes('/policy?'))).toHaveLength(3);
  });

  it('refuses writes from an already replaced editor', async () => {
    const { transport, api } = host();
    await expect(api.savePolicy(branchId, policy, () => false)).rejects.toThrow('editor changed');
    expect(transport.put).not.toHaveBeenCalled();
  });

  it('keeps PNG previews read-only and forwards their cancellation signal', async () => {
    const { transport, api } = host(); const controller = new AbortController();
    transport.postBlob.mockResolvedValue(new Blob());
    await api.printApi.previewPng('ZZ TEST template', JSON.stringify({ footerText: 'ZZ TEST preview' }), controller.signal);
    expect(transport.postBlob).toHaveBeenCalledWith('/print-templates/ZZ%20TEST%20template/preview.png', { footerText: 'ZZ TEST preview' }, controller.signal);
    expect(transport.post).not.toHaveBeenCalled(); expect(transport.patch).not.toHaveBeenCalled();
  });

  it('preserves the native sorted, densely numbered confirmation payload', async () => {
    const { transport, api } = host(); transport.put.mockResolvedValue({ policy });
    const first = { id: 'ZZ TEST first', text: 'ZZ TEST first', required: true, order: 3 };
    const last = { id: 'ZZ TEST last', text: 'ZZ TEST last', required: false, order: 9 };
    await api.savePolicy(branchId, { ...policy, confirmations: [last, first] });
    expect(transport.put.mock.calls[1]![1]).toEqual({ items: [{ ...first, order: 0 }, { ...last, order: 1 }] });
  });
});
