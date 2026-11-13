import { describe, expect, it } from 'vitest';
import { legacyDepositFieldsOf } from '../../oto-app/shared/beoLegacyDeposit';

describe('SCRUM-844 adversarial review: legacy deposit proposals', () => {
  it('HIGH fixed: an old amount-only answer is unconfirmed, never received', () => {
    expect(legacyDepositFieldsOf({ prepaymentReceived: 3000, depositDate: '2026-11-14' }, 'The deposit is 3,000')).toMatchObject({
      prepaymentReceived: undefined, depositRequested: 3000, depositReceived: false, depositDate: undefined,
    });
  });

  it.each(['Please pay 3,000 tomorrow', 'We will transfer 3,000 tomorrow', 'Можете внести депозит 3000', 'กรุณาชำระมัดจำ 3000'])('HIGH fixed: a request or future payment is not a receipt: %s', (words) => {
    expect(legacyDepositFieldsOf({ prepaymentReceived: 3000, depositReceived: false, depositWords: words }, words).prepaymentReceived).toBeUndefined();
  });

  it('HIGH fixed: invented evidence cannot establish a received amount', () => {
    expect(legacyDepositFieldsOf({ prepaymentReceived: 3000, depositReceived: true, depositWords: 'We received 3,000', depositDate: '2026-11-14' }, 'Please pay 3,000')).toMatchObject({
      prepaymentReceived: undefined, depositRequested: 3000, depositDate: undefined,
    });
  });

  it.each(['We received 3,000 baht.', 'Получили депозит 3000 бат.', 'ได้รับมัดจำ 3000 บาทแล้ว'])('CONTROL: received money needs both the flag and the source words: %s', (words) => {
    expect(legacyDepositFieldsOf({ prepaymentReceived: 3000, depositReceived: true, depositWords: words, depositDate: '2026-11-14' }, words)).toMatchObject({
      prepaymentReceived: 3000, depositReceived: true, depositDate: '2026-11-14',
    });
  });

  it('CONTROL: requested and received amounts may differ; neither is calculated', () => {
    expect(legacyDepositFieldsOf({ depositRequested: 3000, prepaymentReceived: 1000, depositReceived: true, depositWords: 'We received 1,000' }, 'Deposit requested 3,000. We received 1,000')).toMatchObject({
      depositRequested: 3000, prepaymentReceived: 1000,
    });
  });

  it('CONTROL: blank, negative and nonfinite amounts cannot propose money', () => {
    for (const amount of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(legacyDepositFieldsOf({ prepaymentReceived: amount, depositRequested: amount, depositReceived: true, depositWords: 'Received' }, 'Received')).toMatchObject({
        prepaymentReceived: undefined, depositRequested: undefined, depositReceived: false,
      });
    }
  });
});
