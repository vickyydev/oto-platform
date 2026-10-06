import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WASocket,
} from 'baileys';
import type { Logger } from 'pino';
import type { PgAuthState } from './authState.js';

export type WaStatus =
  | 'unpaired' // no session; waiting for someone to start a pairing
  | 'pairing' // a code has been issued and not yet entered on the phone
  | 'connecting'
  | 'open'
  | 'logged_out' // the phone removed this device
  | 'banned';

export interface WaClient {
  status(): {
    status: WaStatus;
    pairingCode: string | null;
    since: string;
    lastError: string | null;
  };
  /**
   * Start a pairing and return the eight-character code to type on the phone.
   * Refuses to replace a session that still exists unless `force` is set.
   */
  pair(force?: boolean): Promise<string>;
  sendText(jid: string, text: string): Promise<void>;
  listGroups(): Promise<{ id: string; subject: string; size: number }[]>;
  stop(): Promise<void>;
}

interface Options {
  auth: PgAuthState;
  phone: string;
  log: Logger;
  onOpen(): void;
  /** The session is gone and only a person can bring it back. */
  onDead(reason: 'logged_out' | 'banned'): void;
}

const PAIRING_WINDOW_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export function createWaClient(opts: Options): WaClient {
  const { auth, log } = opts;
  // The library narrates every frame at info; only its warnings are ours to read.
  const libLog = log.child({ lib: 'baileys' }, { level: 'warn' });
  let sock: WASocket | null = null;
  let status: WaStatus = 'unpaired';
  let since = new Date();
  let lastError: string | null = null;
  let pairingCode: string | null = null;
  let pairingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let stopped = false;

  const setStatus = (next: WaStatus) => {
    if (next !== status) {
      status = next;
      since = new Date();
      log.info({ status }, 'whatsapp status');
    }
  };

  const closeSocket = () => {
    const old = sock;
    sock = null;
    if (!old) return;
    old.ev.removeAllListeners('connection.update');
    old.ev.removeAllListeners('creds.update');
    old.end(undefined);
  };

  const endPairing = () => {
    if (pairingTimer) clearTimeout(pairingTimer);
    pairingTimer = null;
    pairingCode = null;
  };

  const scheduleReconnect = (delayMs: number) => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(null);
    }, delayMs);
  };

  /**
   * `onCode` is set only while pairing. A socket is never opened for an
   * unpaired session otherwise: every unpaired connection makes WhatsApp mint
   * a QR and, with a number attached, push a "link a device" prompt to the
   * phone, and a reconnect loop doing that all night is how a number gets
   * noticed.
   */
  const connect = async (onCode: ((code: string) => void) | null): Promise<void> => {
    if (stopped) return;
    closeSocket();
    if (!onCode) setStatus('connecting');

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const current = makeWASocket({
      version,
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, libLog),
      },
      logger: libLog,
      // A pairing code is only accepted from a client that presents itself as
      // a desktop browser.
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    sock = current;

    current.ev.on('creds.update', () => {
      auth.saveCreds().catch((err) => log.error({ err }, 'saving whatsapp credentials failed'));
    });

    let codeRequested = false;
    current.ev.on('connection.update', (update) => {
      if (current !== sock) return;

      if (update.qr && onCode && !codeRequested) {
        codeRequested = true;
        current
          .requestPairingCode(opts.phone)
          .then(onCode)
          .catch((err) => log.error({ err }, 'requesting a pairing code failed'));
      }

      if (update.connection === 'open') {
        attempt = 0;
        lastError = null;
        endPairing();
        setStatus('open');
        opts.onOpen();
        return;
      }

      if (update.connection !== 'close') return;

      const code = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      lastError = `${code ?? 'unknown'}: ${update.lastDisconnect?.error?.message ?? 'closed'}`;
      log.warn({ statusCode: code }, 'whatsapp connection closed');
      sock = null;

      if (code === DisconnectReason.restartRequired) {
        // The normal end of a successful pairing: reconnect as the new device.
        void connect(null);
      } else if (code === DisconnectReason.loggedOut) {
        endPairing();
        void auth.wipe().then(() => {
          setStatus('logged_out');
          opts.onDead('logged_out');
        });
      } else if (code === DisconnectReason.forbidden) {
        endPairing();
        setStatus('banned');
        opts.onDead('banned');
      } else if (!auth.isPaired()) {
        // A pairing that ran out of time. Wait to be asked again.
        endPairing();
        setStatus('unpaired');
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another process holds this session — during a deploy that is the
        // instance replacing this one. Stand back instead of fighting it.
        scheduleReconnect(MAX_BACKOFF_MS);
      } else {
        attempt += 1;
        scheduleReconnect(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempt, 5)));
      }
    });
  };

  if (auth.isPaired()) void connect(null);

  const requireOpen = (): WASocket => {
    if (!sock || status !== 'open') throw new Error(`whatsapp is not connected (${status})`);
    return sock;
  };

  return {
    status: () => ({ status, pairingCode, since: since.toISOString(), lastError }),

    async pair(force = false) {
      if (!opts.phone) throw new Error('WHATSAPP_PHONE is not set');
      if (auth.isPaired() && !force) {
        throw new Error('a paired session already exists; pass force to replace it');
      }
      if (status === 'pairing' && pairingCode) return pairingCode;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      // A half-finished pairing leaves credentials that name the number but
      // were never accepted by it; start every attempt from nothing.
      await auth.wipe();
      setStatus('pairing');

      const code = await new Promise<string>((resolve, reject) => {
        const giveUp = setTimeout(() => reject(new Error('no pairing code within 30s')), 30_000);
        connect((c) => {
          clearTimeout(giveUp);
          resolve(c);
        }).catch(reject);
      }).catch((err) => {
        closeSocket();
        setStatus('unpaired');
        throw err;
      });

      pairingCode = code;
      pairingTimer = setTimeout(() => {
        if (status !== 'pairing') return;
        closeSocket();
        endPairing();
        setStatus('unpaired');
      }, PAIRING_WINDOW_MS);
      return code;
    },

    async sendText(jid, text) {
      // A person opens the chat and types before a message appears. Showing
      // the same, for a few seconds, costs nothing and reads less like a script.
      const s = requireOpen();
      await s.presenceSubscribe(jid).catch(() => undefined);
      await s.sendPresenceUpdate('composing', jid).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2_000 + Math.random() * 3_000));
      await requireOpen().sendMessage(jid, { text });
      await s.sendPresenceUpdate('paused', jid).catch(() => undefined);
    },

    async listGroups() {
      const groups = await requireOpen().groupFetchAllParticipating();
      return Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
        size: g.participants.length,
      }));
    },

    async stop() {
      stopped = true;
      endPairing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeSocket();
    },
  };
}
