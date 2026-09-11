import type { Logger } from 'pino';

/**
 * SMS adapter seam (SCRUM-20): a pluggable provider interface behind
 * SMS_ADAPTER. Two adapters exist:
 *  - "console" (default): logs the message to the API console — dev only.
 *  - "twilio": sends a real SMS through Twilio's REST API. Needs
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (an SMS-capable
 *    Twilio number in E.164, or a Messaging Service SID starting "MG").
 * If "twilio" is selected but credentials are missing, the API falls back to
 * the console adapter with a warning rather than failing to boot.
 */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

export interface SmsConfig {
  adapter: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
}

function consoleSender(log: Logger): SmsSender {
  return {
    async send(phone, message) {
      log.info({ sms: { phone, message } }, `SMS to ${phone}: ${message}`);
    },
  };
}

function twilioSender(sid: string, token: string, from: string, log: Logger): SmsSender {
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  return {
    async send(phone, message) {
      const params = new URLSearchParams({ To: phone, Body: message });
      // A Messaging Service SID routes via the service; otherwise From number.
      params.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!res.ok) {
        // Never log the message body here — it contains the verification code.
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        log.error({ sms: { phone, status: res.status, detail } }, `Twilio send to ${phone} failed`);
        throw new Error('SMS delivery failed');
      }
      log.info({ sms: { phone } }, `SMS sent to ${phone} via Twilio`);
    },
  };
}

export function buildSmsSender(cfg: SmsConfig, log: Logger): SmsSender {
  if (cfg.adapter === 'twilio') {
    const { twilioAccountSid: sid, twilioAuthToken: token, twilioFrom: from } = cfg;
    if (sid && token && from) return twilioSender(sid, token, from, log);
    log.warn(
      'SMS_ADAPTER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are not all set — falling back to the console adapter',
    );
  } else if (cfg.adapter !== 'console') {
    log.warn(`Unknown SMS_ADAPTER "${cfg.adapter}" — using the console adapter`);
  }
  return consoleSender(log);
}
