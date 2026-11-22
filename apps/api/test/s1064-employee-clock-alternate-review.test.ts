import { describe, expect, it } from 'vitest';
import { identifyClockPhone } from '../../oto-app/server/phone-utils';

describe('Attendance phone entry', () => {
  it.each(['0912345678', '912345678', '+66912345678', '66912345678', '+66 (0)91 234 5678'])(
    'uses the same employee lookup for %s', (input) => {
      expect(identifyClockPhone(input)).toEqual({ normalized: '+66912345678' });
    },
  );

  it('preserves other international numbers and rejects incomplete input', () => {
    expect(identifyClockPhone('+12025550187').normalized).toBe('+12025550187');
    expect(identifyClockPhone('09123').error).toBeTruthy();
  });
});
