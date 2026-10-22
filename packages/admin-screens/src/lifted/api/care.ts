import type { LiftedAdminApi } from '../../api/lifted-api';
import type { SupervisionPolicy } from '../model/types';
import { createCheckinAdminApi, type PolicyBody, type PricingBody } from './checkin';
import { idemKey } from './client';
import { createPlatformAdminApi } from './platform';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

/** Uncertain retries keep their key; an acknowledged press completes its intent. */
export function createCareAdminApi(transport: LiftedAdminApi) {
  const pending = new Map<string, { body: string; key: string }>();
  const write = async <T>(method: 'post' | 'put' | 'patch', path: string, body: unknown, supplied?: { idempotencyKey?: string }) => {
    const intent = method + ':' + path, fingerprint = canonical(body), previous = pending.get(intent);
    const attempt = previous?.body === fingerprint ? previous : { body: fingerprint, key: supplied?.idempotencyKey ?? idemKey() };
    const { key } = attempt;
    pending.set(intent, attempt);
    const answer = await transport[method]<T>(path, body, { idempotencyKey: key });
    if (pending.get(intent) === attempt) pending.delete(intent);
    if (method === 'patch' && /^\/print-templates\/[^/]+$/.test(path)) pending.delete('post:' + path + '/test-print');
    return answer;
  };
  const api: LiftedAdminApi = { ...transport,
    post: (path, body, supplied) => write('post', path, body, supplied),
    put: (path, body, supplied) => write('put', path, body, supplied),
    patch: (path, body, supplied) => write('patch', path, body, supplied),
  };
  const { checkinApi, boardApi } = createCheckinAdminApi(api);
  const { printApi, templatesApi } = createPlatformAdminApi(api);
  const policies = new Map<string, { body: string; policyConfirmed: boolean }>();
  const ensureCurrent = (current: () => boolean) => {
    if (!current()) throw new Error('The park or editor changed. Open these settings again.');
  };
  return {
    checkinApi,
    printApi: { ...printApi, ...templatesApi },
    savePricing: async (branchId: string, body: PricingBody, current: () => boolean = () => true) => {
      ensureCurrent(current);
      return (await boardApi.savePricing(branchId, body)).pricing;
    },
    savePolicy: async (branchId: string, next: SupervisionPolicy, current: () => boolean = () => true) => {
      const bodyKey = canonical(next), previous = policies.get(branchId);
      const progress = previous?.body === bodyKey ? previous : { body: bodyKey, policyConfirmed: false };
      policies.set(branchId, progress);
      ensureCurrent(current);
      if (!progress.policyConfirmed) {
        const body: PolicyBody = { bands: next.bands, siblingWaiver: next.siblingWaiver };
        await boardApi.savePolicy(branchId, body);
        progress.policyConfirmed = true;
      }
      ensureCurrent(current);
      const answer = await boardApi.saveConfirmations(branchId, [...next.confirmations]
        .sort((a, b) => a.order - b.order).map((item, order) => ({ id: item.id, text: item.text, required: item.required, order })));
      if (policies.get(branchId) === progress) policies.delete(branchId);
      return answer.policy;
    },
  };
}
