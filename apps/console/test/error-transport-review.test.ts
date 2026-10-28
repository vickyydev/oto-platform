import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, ApiError, isMissingRoute } from '@/api/client';
import { ErrorNote } from '@/components/Panel';
import { ApiError as PosError, isMissingRoute as posMissing } from '../../pos/src/api/client';
import { isMissingRoute as liftedMissing } from '../../../packages/admin-screens/src/lifted/api/client';
import { isMissingRoute as identitiesMissing } from '../../../packages/admin-screens/src/api/app-identities';

const fetcher = vi.fn<typeof fetch>();
const dispatch = vi.fn();
beforeEach(() => { fetcher.mockReset(); dispatch.mockReset(); vi.stubGlobal('React', React); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('window', { dispatchEvent: dispatch }); });
afterEach(() => vi.unstubAllGlobals());

describe('SCRUM-682 native error metadata and route compatibility', () => {
  for (const [name, invoke] of [['JSON', () => api.get('/zz-test')], ['file', () => api.getFile('/zz-test')],
    ['POST blob', () => api.postBlob('/zz-test', {})]] as const) {
    it(`${name} retains safe request reference and native retry-after`, async () => {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
        { status: 429, headers: { 'x-request-id': 'zz-test-request-682', 'retry-after': '3' } }));
      const failure = await invoke().catch(error => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: 429, requestId: 'zz-test-request-682', retryAfterSeconds: 3 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it(`${name} discards malformed metadata rather than reflecting headers`, async () => {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Unexpected error' } }),
        { status: 500, headers: { 'x-request-id': 'invalid/private-canary', 'retry-after': 'private-canary' } }));
      const failure = await invoke().catch(error => error);
      if (!(failure instanceof ApiError)) throw new Error('Expected the native API error envelope.');
      expect(failure.requestId).toBeUndefined();
      expect(failure.retryAfterSeconds).toBeUndefined();
    });
    it(`${name} never exposes a non-keyword internal500 message through a legacy string caller`, async () => {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'ZZ TEST internal detail', details: { diagnostic: 'zz-test-detail' } } }),
        { status: 500, headers: { 'x-request-id': 'zz-test-request-682' } }));
      const failure = await invoke().catch(error => error);
      if (!(failure instanceof ApiError)) throw new Error('Expected the native API error envelope.');
      expect(failure).toMatchObject({ status: 500, code: 'INTERNAL', details: { diagnostic: 'zz-test-detail' }, requestId: 'zz-test-request-682' });
      const html = renderToStaticMarkup(createElement(ErrorNote, { message: failure.message }));
      expect(html).not.toContain('ZZ TEST internal detail');
      expect(failure.message).not.toContain('ZZ TEST internal detail');
    });
  }
  for (const [name, predicate, ErrorType] of [['Console', isMissingRoute, ApiError], ['POS', posMissing, PosError],
    ['lifted', liftedMissing, ApiError], ['app identities', identitiesMissing, ApiError]] as const) {
    it(`${name} accepts explicit and legacy route absence, keeping resource404 real`, () => {
      expect(predicate(new ErrorType(404, 'ROUTE_NOT_FOUND', 'This API endpoint is not available.'))).toBe(true);
      expect(predicate(new ErrorType(404, 'UNKNOWN', 'Not Found'))).toBe(true);
      expect(predicate(new ErrorType(404, 'BOOTH_NOT_FOUND', 'No booth with that id'))).toBe(false);
      expect(predicate(new ErrorType(404, 'NOT_FOUND', 'No such record'))).toBe(false);
      expect(predicate(new ErrorType(403, 'ROUTE_NOT_FOUND', 'Refused'))).toBe(false);
    });
  }
  for (const status of [401, 423]) it(`preserves native status${status} session recovery in all three paths`, async () => {
    for (const invoke of [() => api.get('/zz-test'), () => api.getFile('/zz-test'), () => api.postBlob('/zz-test', {})]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'REFUSED', message: 'Session refused' } }), { status }));
      await expect(invoke()).rejects.toMatchObject({ status });
    }
    expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual(Array(3).fill(status === 401 ? 'oto:unauthorized' : 'oto:session-locked'));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
