import { describe, expect, it } from 'vitest';
import { routedTerminalRoles, stationSellingReadiness } from '../src/station-readiness';

const till = (paymentRouting: unknown) => ({ kind: 'till', codePrefix: 'T1', boxId: 'box', paymentRouting });
const terminal = (role: string, overrides: Record<string, unknown> = {}) => ({ role, kind: 'terminal', boxId: 'box', protocol: 'digio_tlv', ...overrides });
const NO_CARD = 'Card is routed to the terminal but no terminal is assigned';
const NO_QR = 'QR is routed to the terminal but no terminal is assigned';

describe('routedTerminalRoles reads the routing as the tender service does', () => {
  it.each([
    ['nothing saved', null, ['card_terminal', 'qr_terminal']],
    ['an empty routing', {}, ['card_terminal', 'qr_terminal']],
    ['QR left unset', { card: 'card_terminal' }, ['card_terminal', 'qr_terminal']],
    ['manual card and QR left unset', { card: 'manual' }, ['qr_terminal']],
    ['QR on its terminal', { card: 'manual', qr: 'qr_terminal' }, ['qr_terminal']],
    ['QR on the gateway', { card: 'card_terminal', qr: 'gateway' }, ['card_terminal']],
    ['QR not taken', { card: 'card_terminal', qr: 'none' }, ['card_terminal']],
    ['no terminal at all', { card: 'manual', qr: 'none' }, []],
    ['extra keys the page does not know', { card: 'manual', qr: 'gateway', later: true }, []],
  ])('%s', (_name, routing, roles) => {
    expect(routedTerminalRoles(routing)).toEqual(roles);
  });
  it.each([
    ['an unknown QR route', { card: 'manual', qr: 'bogus' }],
    ['an unknown card route', { card: 'bogus', qr: 'none' }],
    ['a value that is not a routing', 'gateway'],
  ])('a routing that fails to parse is ignored, as the tender ignores it: %s', (_name, routing) => {
    expect(routedTerminalRoles(routing)).toEqual(['card_terminal', 'qr_terminal']);
  });
});

describe('stationSellingReadiness', () => {
  it('asks for a QR terminal when QR is left unset, and a card terminal alone does not satisfy it', () => {
    expect(stationSellingReadiness(till({ card: 'card_terminal' }), [terminal('card_terminal')])).toEqual({ ready: false, reasons: [NO_QR] });
  });
  it('is ready with QR left unset and a usable QR terminal', () => {
    expect(stationSellingReadiness(till({ card: 'manual' }), [terminal('qr_terminal')])).toEqual({ ready: true, reasons: [] });
  });
  it.each(['gateway', 'none'])('does not ask for a QR terminal with QR %s', (qr) => {
    expect(stationSellingReadiness(till({ card: 'card_terminal', qr }), [terminal('card_terminal')])).toEqual({ ready: true, reasons: [] });
  });
  it('names both terminals for a till with nothing saved', () => {
    expect(stationSellingReadiness(till(null), []).reasons).toEqual([NO_CARD, NO_QR]);
  });
  it('says a terminal on another box is on another box', () => {
    const reasons = stationSellingReadiness(till({ card: 'card_terminal', qr: 'none' }), [terminal('card_terminal', { boxId: 'other' })]).reasons;
    expect(reasons).toEqual(['The assigned terminal is on another box']);
  });
  it('says the same of a station with no box, whose terminal is on one', () => {
    const reasons = stationSellingReadiness({ ...till({ card: 'card_terminal', qr: 'none' }), boxId: null }, [terminal('card_terminal')]).reasons;
    expect(reasons).toEqual(['The assigned terminal is on another box']);
  });
  it('prefers the terminal on this box when a role has one on each', () => {
    const assigned = [terminal('card_terminal', { boxId: 'other' }), terminal('card_terminal')];
    expect(stationSellingReadiness(till({ card: 'card_terminal', qr: 'none' }), assigned)).toEqual({ ready: true, reasons: [] });
  });
  it('still names an unsupported protocol on this box', () => {
    const assigned = [terminal('card_terminal', { protocol: 'older' })];
    expect(stationSellingReadiness(till({ card: 'card_terminal', qr: 'none' }), assigned).reasons).toEqual(['The assigned terminal has no supported protocol']);
  });
  it('asks nothing of a station that is not a till', () => {
    expect(stationSellingReadiness({ kind: 'display', boxId: null, paymentRouting: null }, [])).toEqual({ ready: true, reasons: [] });
  });
});
