import { describe, expect, it } from 'vitest';
import { ApiError, isMissingRoute } from '@/api/client';

describe('SCRUM-681 missing route versus missing resource', () => {
  it('retains the existing UNKNOWN404 deployment fallback', () => {
    expect(isMissingRoute(new ApiError(404, 'UNKNOWN', 'Not Found'))).toBe(true);
  });
  for (const code of ['BOOTH_NOT_FOUND', 'DEVICE_NOT_FOUND', 'NOT_FOUND']) {
    it(`keeps ${code} as a real resource refusal`, () => {
      expect(isMissingRoute(new ApiError(404, code, 'The selected record is missing.'))).toBe(false);
    });
  }
  for (const status of [403, 500]) {
    it(`does not describe status${status} as an undeployed route`, () => {
      expect(isMissingRoute(new ApiError(status, 'UNKNOWN', 'Request refused.'))).toBe(false);
    });
  }
  it('does not reinterpret transport errors', () => {
    expect(isMissingRoute(new TypeError('Failed to fetch'))).toBe(false);
  });
});
