import { describe, expect, it } from 'vitest';
import {
  ChannelConfigError,
  simulatorConfigFrom,
  whatsAppCloudConfigFrom,
  whatsappTokenVariable,
} from '../src/config';
import { insideFreeTextWindow, windowRefusal } from '../src/window';

const NOW = new Date('2026-10-20T03:00:00.000Z');
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

describe('the free-text window', () => {
  it('is open strictly inside 24 hours and closed at exactly 24', () => {
    expect(insideFreeTextWindow(ago(23.99), NOW, 24)).toBe(true);
    expect(insideFreeTextWindow(ago(24), NOW, 24)).toBe(false);
    expect(insideFreeTextWindow(null, NOW, 24)).toBe(false);
  });

  it('never stops a template, and never applies on a channel with no window', () => {
    expect(
      windowRefusal({ kind: 'template', name: 'welcome', language: 'en' }, null, NOW, 24),
    ).toBeNull();
    expect(windowRefusal({ kind: 'text', text: 'x' }, null, NOW, null)).toBeNull();
    expect(
      windowRefusal(
        { kind: 'media', mediaType: 'image', link: 'https://x.test/a' },
        ago(30),
        NOW,
        24,
      ),
    ).toBe('TEMPLATE_REQUIRED');
  });
});

describe('the INBOX_* variables', () => {
  const account = { credentialRef: 'CENTRAL', phoneNumberId: '100000000000001' };
  const full = {
    INBOX_WHATSAPP_ENABLED: 'true',
    INBOX_META_APP_SECRET: 's',
    INBOX_META_VERIFY_TOKEN: 'v',
    INBOX_WHATSAPP_TOKEN_CENTRAL: 't',
  };

  it('leaves WhatsApp off unless the flag is exactly true', () => {
    expect(whatsAppCloudConfigFrom({}, account)).toBeNull();
    expect(whatsAppCloudConfigFrom({ ...full, INBOX_WHATSAPP_ENABLED: '1' }, account)).toBeNull();
  });

  it('builds the adapter configuration with the flag on and everything set', () => {
    expect(whatsAppCloudConfigFrom(full, account)).toEqual({
      appSecret: 's',
      verifyToken: 'v',
      accessToken: 't',
      phoneNumberId: '100000000000001',
    });
  });

  it('names every missing variable at once, and no value', () => {
    try {
      whatsAppCloudConfigFrom(
        { INBOX_WHATSAPP_ENABLED: 'true', INBOX_META_APP_SECRET: 'secret-value' },
        account,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelConfigError);
      expect((err as ChannelConfigError).missing).toEqual([
        'INBOX_META_VERIFY_TOKEN',
        'INBOX_WHATSAPP_TOKEN_CENTRAL',
      ]);
      expect((err as Error).message).not.toContain('secret-value');
    }
  });

  it('accepts only a well-formed credential_ref as part of a variable name', () => {
    expect(whatsappTokenVariable('CENTRAL_1')).toBe('INBOX_WHATSAPP_TOKEN_CENTRAL_1');
    expect(() => whatsappTokenVariable('central; rm')).toThrow();
  });

  it('turns the simulator on only with on, and never without its secret', () => {
    expect(simulatorConfigFrom({})).toEqual({ enabled: false });
    expect(simulatorConfigFrom({ INBOX_SIMULATOR: 'off', INBOX_SIMULATOR_SECRET: 'x' })).toEqual({
      enabled: false,
    });
    expect(simulatorConfigFrom({ INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: 'x' })).toEqual({
      enabled: true,
      secret: 'x',
    });
    expect(() => simulatorConfigFrom({ INBOX_SIMULATOR: 'on' })).toThrow(ChannelConfigError);
  });
});
