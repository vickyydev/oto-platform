/**
 * A booth, faked in the browser, so this app is a finished screen before
 * anything exists to serve it.
 *
 * It answers every call in src/booth/contract.ts the way the real service has
 * to, including the parts that are easy to skip in a stub and expensive to get
 * wrong later: it draws from the published weights and renormalises over what
 * is eligible (D5), it consumes daily caps and refuses when nothing is left,
 * it mints a code with the frozen helper, and it honours `simulate` by doing
 * none of those things. A distribution table run against this fake is a real
 * measurement of this draw — which is the point of D16, and is why the table
 * calls the transport rather than a second copy of the arithmetic.
 *
 * **What it is not.** It has no database, no printer, no clock it can doubt
 * and no cloud, so `vouchersPending` only ever counts what this tab minted and
 * `clockSuspect` is always false. And it holds no credential: see `signIn`.
 *
 * Never loaded when the page is pointed at a real booth (src/booth/client.ts).
 */

import {
  BOOTH_CODE_MINT_ATTEMPTS,
  BoothConfigBundleSchema,
  mintBoothCode,
  type BoothConfigBundle,
  type BoothConfigPrize,
  type SpinResponse,
} from '@oto/shared';
import { flags } from '../flags';
import { backoffFor, FREE_ATTEMPTS } from '../staff-backoff';
import {
  BoothCallError,
  type BoothConfigResponse,
  type BoothReprintResponse,
  type BoothStaffOnDuty,
  type BoothStatus,
  type BoothTransport,
  type SpinRequest,
  type StaffSignInRequest,
  type StaffSignInResponse,
} from './contract';

/**
 * Uniform integer in `[0, maxExclusive)` from the browser's CSPRNG.
 *
 * Rejection sampling, not `% maxExclusive` on a raw draw: taking the modulus
 * of a 32-bit value favours the low end of any range that does not divide
 * 2^32, which for a six-slice wheel is a visible thumb on the scale. The
 * rejected tail is under one part in 400,000 for the ranges used here
 * (10,000 for a draw and 30 for a code character), so the loop effectively
 * never runs twice; it is written as a loop because "effectively never" is
 * not never.
 *
 * This is the browser's counterpart of D3's `randomInt` from `node:crypto` —
 * same reason, same guarantee, different runtime. `Math.random` is not used
 * anywhere in this file.
 */
function randomBelow(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`randomBelow needs a positive integer bound, got ${String(maxExclusive)}`);
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const drawn = buffer[0] ?? 0;
    if (drawn < limit) return drawn % maxExclusive;
  }
}

/** UUIDv7 is the platform's id; a fake's rows are never stored, so v4 is fine. */
function fakeId(): string {
  return crypto.randomUUID();
}

/**
 * The seeded wheel, as `packages/db/src/seed/index.ts` publishes it: the six
 * prizes the live booth is running, their odds in basis points, the park's
 * brand colours and the labels the outgoing wheel draws on its slices.
 *
 * Copied rather than imported because `@oto/db` is a server package and this
 * runs in a browser. If the seed's prizes change, this drifts — which costs a
 * developer a confusing afternoon and costs a guest nothing, since no booth
 * ever serves this.
 */
const FIXTURE_LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const FIXTURE_PRIZE_IDS = [
  '018f1d2c-0000-7000-8000-00000000fa01',
  '018f1d2c-0000-7000-8000-00000000fa02',
  '018f1d2c-0000-7000-8000-00000000fa03',
  '018f1d2c-0000-7000-8000-00000000fa04',
  '018f1d2c-0000-7000-8000-00000000fa05',
  '018f1d2c-0000-7000-8000-00000000fa06',
];

function fixturePrize(
  index: number,
  nameEn: string,
  nameTh: string,
  wheelLabel: string,
  weightBp: number,
  sliceColor: string,
  costSatang: number,
): BoothConfigPrize {
  return {
    id: FIXTURE_PRIZE_IDS[index] ?? fakeId(),
    nameEn,
    nameTh,
    wheelLabel,
    weightBp,
    active: true,
    dailyCap: null,
    expiryDays: null,
    costSatang,
    sliceColor,
    textColor: '#111111',
    sortOrder: index,
    voucherDefinitionId: fakeId(),
  };
}

const FIXTURE_BUNDLE: BoothConfigBundle = {
  schemaVersion: 1,
  settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
  layout: {
    id: FIXTURE_LAYOUT_ID,
    name: 'Classic wheel',
    version: 1,
    design: {
      palette: ['#FFE72E', '#FF7BC5', '#FF8A3D', '#55B9FF', '#A6E22C', '#CD8CFF'],
      defaultTextColor: '#111111',
      labelMaxLines: 2,
    },
    assetManifest: {
      face: { name: 'wheel-face', source: 'slot', fallback: 'generated' },
      tick: { name: 'wheel-tick', source: 'slot', fallback: 'silent' },
      win: { name: 'wheel-win', source: 'slot', fallback: 'silent' },
      thaiFont: { name: 'Noto Sans Thai', source: 'bundled' },
    },
  },
  prizes: [
    fixturePrize(0, '100 THB Voucher', 'บัตรกำนัล 100 บาท', '100 ฿', 2350, '#FFE72E', 10_000),
    fixturePrize(
      1,
      'Free Bracelet Workshop',
      'เวิร์กช็อปทำสร้อยข้อมือฟรี',
      'Bracelet\nWorkshop',
      2750,
      '#FF7BC5',
      0,
    ),
    fixturePrize(2, '150 THB Voucher', 'บัตรกำนัล 150 บาท', '150 ฿', 1750, '#FF8A3D', 15_000),
    fixturePrize(3, '200 THB Voucher', 'บัตรกำนัล 200 บาท', '200 ฿', 1450, '#55B9FF', 20_000),
    fixturePrize(4, 'Kids Pizza', 'พิซซ่าสำหรับเด็ก', 'Kids\nPizza', 1450, '#A6E22C', 0),
    fixturePrize(5, '1+1 Kids Ticket', 'บัตรเด็ก 1 แถม 1', '1+1 Kids\nTicket', 250, '#CD8CFF', 0),
  ],
};

/** The booth prefix every code from this fake carries. Two characters (D8). */
const FIXTURE_PREFIX = 'B1';
/** What the seeded voucher definitions use, since the bundle carries no definition. */
const FIXTURE_EXPIRY_DAYS = 14;

/** Local calendar day. The real box resolves a trading day from the branch. */
function localDay(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/**
 * A press costs the box a transaction, a code and an attempt at a printer.
 *
 * The fake does none of that and could answer in a microtask — which would be
 * the worst thing it could do, because the whole reason the press path has a
 * "starting" beat is that it now waits on something. A fake with no latency
 * develops a page that looks fine here and has a dead button in the park.
 * A tenth of a second is the right order for a Pi answering over a loopback.
 *
 * A SIMULATED draw skips this: it writes nothing, so there is nothing to
 * wait for, and two hundred of them in a diagnostics run should not take half
 * a minute.
 */
const FAKE_SPIN_LATENCY_MS = 120;
/** Polls are cheap on a box, but they are not free either. */
const FAKE_POLL_LATENCY_MS = 40;

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export class FakeBooth implements BoothTransport {
  async getStaff() {
    return { staff: [{ accountId: FAKE_STAFF_ACCOUNT_ID, name: 'Demo staff', code: 'S-DEMO', hasPin: true }] };
  }
  private readonly slips = new Map<string, SpinResponse>();
  readonly kind = 'fake' as const;

  private readonly bundle: BoothConfigBundle;
  private readonly version: number;
  private signedIn = false;
  /** Who the fake says is on duty — a made-up person, never a real one. */
  private onDuty: BoothStaffOnDuty | null = null;
  /** The last voucher this tab minted, for the fake's reprint. */
  private lastVoucher: { spinId: string; printState: SpinResponse['printState'] } | null = null;
  private failures = 0;
  private lockedUntil = 0;
  private minted = 0;
  private lastSpinAt: string | null = null;
  private capsUsed = new Map<string, number>();
  private capsDay = localDay(new Date());
  /** Spins given away on `capsDay`, for the booth's own cap (SCRUM-257). */
  private spinsToday = 0;

  constructor() {
    // The fixture goes through the frozen schema on the way in. A fixture that
    // is not a valid bundle would make every test of this page a test of a
    // document no booth could ever publish, and this is the cheapest place to
    // find that out.
    this.bundle = BoothConfigBundleSchema.parse(
      flags.spinCap === null
        ? FIXTURE_BUNDLE
        : {
            ...FIXTURE_BUNDLE,
            settings: { ...FIXTURE_BUNDLE.settings, dailySpinCap: flags.spinCap },
          },
    );
    this.version = 1;
  }

  async getConfig(): Promise<BoothConfigResponse> {
    if (flags.unsynced) return after(FAKE_POLL_LATENCY_MS, { version: null, bundle: null });
    return after(FAKE_POLL_LATENCY_MS, { version: this.version, bundle: this.bundle });
  }

  async getStatus(): Promise<BoothStatus> {
    const printer = flags.printer ?? 'no_printer';
    return after(FAKE_POLL_LATENCY_MS, {
      online: !flags.offline,
      neverSynced: flags.unsynced,
      configVersion: flags.unsynced ? null : this.version,
      printerReachable:
        printer === 'no_printer' ? 'unknown' : printer === 'failed' ? 'unreachable' : 'reachable',
      paperStatus: printer === 'queued' ? 'out' : printer === 'printed' ? 'ok' : 'unknown',
      // Offline, nothing can be acknowledged, so everything this tab minted is
      // still pending — which is what the offline dot is meant to sit beside.
      vouchersPending: flags.offline ? this.minted : 0,
      lastSpinAt: this.lastSpinAt,
      staffSignedIn: this.signedIn,
      staff: this.signedIn ? this.onDuty : null,
      dailyCapsReached: this.cappedPrizeIds(),
    });
  }

  async spin(request: SpinRequest): Promise<SpinResponse> {
    if (flags.unsynced) throw new BoothCallError('not_configured', 409);
    this.rollDayOver();

    /**
     * The booth's own cap, before anything is drawn (SCRUM-257).
     *
     * Before the prize eligibility below, because it is a different question
     * asked in a different order: "may this booth play at all today" comes
     * before "what is left to win", and the box answers them that way round
     * too. A SIMULATED press is refused as well and consumes nothing — the
     * distribution table asks what a press would do now, and on a booth that
     * has run its day it would be refused.
     */
    const dailySpinCap = this.bundle.settings.dailySpinCap;
    if (dailySpinCap !== null && this.spinsToday >= dailySpinCap) {
      throw new BoothCallError('daily_spin_cap_reached', 409);
    }

    const eligible = this.bundle.prizes.filter((prize) => prize.active && !this.isCapped(prize));
    const total = eligible.reduce((sum, prize) => sum + prize.weightBp, 0);
    // D5: nothing eligible refuses the press. A booth whose every prize is
    // inactive, capped or out of stock has nothing to give away, and drawing
    // from an empty set would either throw or hand out a prize that is not
    // there.
    if (eligible.length === 0 || total === 0) throw new BoothCallError('booth_not_ready', 409);

    const prize = pickByWeight(eligible, total);
    const drawnIndex = this.bundle.prizes.findIndex((candidate) => candidate.id === prize.id);
    // A booth that was republished a moment ago answers with a slot that means
    // something else on this page, or with a prize this page has never heard
    // of. Both are the fake pretending; neither can happen without the flag.
    const index =
      flags.drift === 'index' ? (drawnIndex + 1) % this.bundle.prizes.length : drawnIndex;
    const prizeId = flags.drift === 'prize' ? fakeId() : prize.id;

    if (request.simulate) {
      // Nothing written, nothing minted, no cap consumed. The response still
      // carries a spin id and a print state because the shape is the shape;
      // what makes it a simulation is that this booth is unchanged by it.
      return {
        spinId: fakeId(),
        prizeIndex: index,
        prizeId,
        configVersion: this.version,
        voucherCode: null,
        expiresAt: null,
        printState: 'no_printer',
        staffAccountId: this.signedIn ? FAKE_STAFF_ACCOUNT_ID : null,
        clockSuspect: false,
      };
    }

    this.consumeCap(prize);
    this.spinsToday += 1;
    this.minted += 1;
    const now = new Date();
    this.lastSpinAt = now.toISOString();

    const days = prize.expiryDays ?? FIXTURE_EXPIRY_DAYS;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    const spinId = fakeId();
    const printState = flags.printer ?? 'no_printer';
    this.lastVoucher = { spinId, printState };
    const response: SpinResponse = {
      spinId,
      prizeIndex: index,
      prizeId,
      configVersion: this.version,
      voucherCode: this.mintCode(),
      expiresAt,
      printState,
      staffAccountId: this.signedIn ? FAKE_STAFF_ACCOUNT_ID : null,
      clockSuspect: false,
    };
    this.slips.set(spinId, response);
    return after(FAKE_SPIN_LATENCY_MS, { ...response, printState: 'queued' });
  }

  async print({ spinId }: { spinId: string }): Promise<SpinResponse> {
    const response = this.slips.get(spinId);
    if (!response) throw new BoothCallError('nothing_to_print', 404);
    return after(FAKE_SPIN_LATENCY_MS, response);
  }

  /** The same refusals a box gives: nobody signed in, or nothing to reprint. */
  async reprint(): Promise<BoothReprintResponse> {
    if (!this.signedIn) throw new BoothCallError('staff_required', 403);
    if (!this.lastVoucher) throw new BoothCallError('nothing_to_reprint', 404);
    return after(FAKE_SPIN_LATENCY_MS, { ...this.lastVoucher });
  }

  /**
   * Sign in — with no credential to check against, deliberately.
   *
   * The outgoing game shipped a staff PIN as a literal in a public bundle, and
   * D15 exists to correct that. A fake that hard-coded the seeded development
   * PIN would put the same real value back into the same public place, so this
   * one holds no PIN at all: with `VITE_BOOTH_FAKE_PIN` unset it accepts any
   * four digits or more and refuses anything shorter, which is enough to work
   * the panel and enough to demonstrate the backoff by submitting `1` six
   * times. Set the variable to pin it to one value.
   *
   * The lockout below is the fake's own, so that the page's handling of
   * `retryAfterMs` is exercised by something rather than merely typed.
   */
  async signIn(request: StaffSignInRequest): Promise<StaffSignInResponse> {
    const now = Date.now();
    if (now < this.lockedUntil) {
      return { ok: false, retryAfterMs: this.lockedUntil - now };
    }

    /**
     * An account sign-in in the fake: any phone with a password of four or
     * more characters, and `#offline` refuses it the way a box with no
     * internet does. No real account is checked — there is none here.
     */
    if (request.mode === 'account') {
      if (flags.offline) return { ok: false, reason: 'offline' };
      const good = (request.phone ?? '').trim() !== '' && (request.password ?? '').length >= 4;
      if (good) {
        this.failures = 0;
        this.signedIn = true;
        this.onDuty = this.demoStaff('account');
        return { ok: true };
      }
    }

    const expected = import.meta.env.VITE_BOOTH_FAKE_PIN;
    const pin = request.pin ?? '';
    const badge = request.badge ?? '';
    const ok =
      request.mode === 'account'
        ? false
        : badge !== ''
          ? badge.trim().length >= 6
          : typeof expected === 'string' && expected !== ''
            ? pin === expected
            : /^\d{4,}$/.test(pin);

    if (ok) {
      this.failures = 0;
      this.lockedUntil = 0;
      this.signedIn = true;
      this.onDuty = this.demoStaff(badge !== '' ? 'badge' : 'pin');
      return { ok: true };
    }

    this.failures += 1;
    // The panel's own arithmetic, imported rather than restated: two backoffs
    // that disagree would show a countdown that runs out before the booth will
    // answer, which reads as a broken panel.
    const wait = this.failures > FREE_ATTEMPTS ? backoffFor(this.failures) : 0;
    if (wait > 0) {
      this.lockedUntil = now + wait;
      return { ok: false, retryAfterMs: wait };
    }
    return { ok: false };
  }

  async signOut(): Promise<void> {
    this.signedIn = false;
    this.onDuty = null;
  }

  private demoStaff(method: BoothStaffOnDuty['method']): BoothStaffOnDuty {
    const now = Date.now();
    return {
      name: 'Demo staff',
      code: 'S-DEMO',
      method,
      signedInAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    };
  }

  private mintCode(): string {
    // A real box retries on the unique index; this one has no index to
    // violate, so the loop is here only to keep the shape honest — the helper
    // is called exactly as the box must call it, bounded the same way.
    for (let attempt = 0; attempt < BOOTH_CODE_MINT_ATTEMPTS; attempt += 1) {
      const code = mintBoothCode(FIXTURE_PREFIX, randomBelow);
      if (code) return code;
    }
    throw new BoothCallError(null, null);
  }

  private rollDayOver(): void {
    const today = localDay(new Date());
    if (today !== this.capsDay) {
      this.capsDay = today;
      this.capsUsed = new Map();
      this.spinsToday = 0;
    }
  }

  private isCapped(prize: BoothConfigPrize): boolean {
    if (prize.dailyCap === null) return false;
    return (this.capsUsed.get(prize.id) ?? 0) >= prize.dailyCap;
  }

  private consumeCap(prize: BoothConfigPrize): void {
    if (prize.dailyCap === null) return;
    this.capsUsed.set(prize.id, (this.capsUsed.get(prize.id) ?? 0) + 1);
  }

  private cappedPrizeIds(): string[] {
    return this.bundle.prizes.filter((prize) => this.isCapped(prize)).map((prize) => prize.id);
  }
}

/**
 * The opaque account id a signed-in fake spin carries.
 *
 * It is a constant and it is not anybody: the contract says this field is an
 * id and nothing else — no name, no phone, no photo — so a fake that invented
 * a person would be modelling the wrong thing.
 */
const FAKE_STAFF_ACCOUNT_ID = '018f1d2c-0000-7000-8000-00000000fb01';

/**
 * Weighted pick over integer basis points.
 *
 * **Not the outgoing game's `pickWeightedPrize`** (D21). That one subtracts
 * first and then tests `roll <= 0`, which lets a zero-weight prize win on a
 * boundary — harmless while every slice had a real probability, and a
 * prize-giving bug the moment "inactive" or "capped" is modelled as weight
 * zero. This tests before subtracting, so a zero-weight candidate is
 * unreachable: `roll < 0` is false for every `roll` the draw can produce.
 *
 * The loop always returns: `roll` starts below `total`, `total` is the sum of
 * the candidates' weights, so by the last candidate the running remainder is
 * necessarily below its weight. The throw after the loop is what TypeScript
 * needs to see, not a case that can happen.
 */
function pickByWeight(candidates: BoothConfigPrize[], total: number): BoothConfigPrize {
  let roll = randomBelow(total);
  for (const candidate of candidates) {
    if (roll < candidate.weightBp) return candidate;
    roll -= candidate.weightBp;
  }
  throw new Error('weighted pick fell through a total it was drawn from');
}
