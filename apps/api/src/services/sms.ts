import type { Logger } from 'pino';

/**
 * SMS adapter seam (SCRUM-20): a pluggable provider interface. The dev
 * adapter logs the code to the API console; a real provider (e.g. Twilio)
 * implements the same interface behind SMS_ADAPTER.
 */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

export function buildSmsSender(kind: string, log: Logger): SmsSender {
  // Only the console adapter exists in Sprint 1.
  void kind;
  return {
    async send(phone, message) {
      log.info({ sms: { phone, message } }, `SMS to ${phone}: ${message}`);
    },
  };
}
