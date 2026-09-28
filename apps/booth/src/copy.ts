/**
 * Every word the television can show.
 *
 * One deck, in one file, for one reason: D15. If the only strings this page
 * can render are the ones written here, then no message from a server, no
 * exception text and no field of any record can reach a screen in a shopping
 * centre — the worst of those is not a leak of anything secret, it is a
 * child's allergy note or a phone number appearing under a wheel because
 * somebody put a useful detail in an error message.
 *
 * The prize names are the exception, and they are not one: they come from the
 * published bundle, which is configuration an administrator typed for exactly
 * this purpose.
 *
 * **The Thai here has not been reviewed by a Thai speaker.** It is written to
 * be replaced, and the park's own wording should overwrite it before the booth
 * opens; the English is the source.
 */

export interface BilingualLine {
  en: string;
  th: string;
}

export const COPY = {
  printing: { en: 'Printing…', th: 'กำลังพิมพ์…' } satisfies BilingualLine,
  /** Under the wheel, idle. */
  pressToSpin: { en: 'Press the button to spin', th: 'กดปุ่มเพื่อหมุน' } satisfies BilingualLine,
  /**
   * Between the press and the wheel moving. The press now waits on the booth,
   * and a button with no answer for half a second reads as a dead button.
   */
  starting: { en: 'Starting…', th: 'กำลังเริ่ม…' } satisfies BilingualLine,
  spinning: { en: 'Spinning…', th: 'กำลังหมุน…' } satisfies BilingualLine,
  /**
   * Shown instead of "press the button" when nobody is attending the booth.
   * It is a prompt to staff, NOT a lock: the wheel still spins, and the spin
   * is recorded unattributed. A booth that refused to play while reception was
   * busy would be a booth nobody plays — which is why it no longer says
   * "sign in to start" (SCRUM-223): that read as "you cannot play yet", and
   * the wheel plays. What signing in changes is whose name is on the slip.
   */
  staffSignInPrompt: {
    en: 'Staff: sign in for your name on the slip',
    th: 'พนักงาน: เข้าสู่ระบบเพื่อให้ชื่อของคุณอยู่บนคูปอง',
  } satisfies BilingualLine,
  /**
   * The red button was pressed while the staff sign-in form had the keyboard
   * (SCRUM-223). The key went to the form and nothing was drawn — see
   * `isTypingTarget` in src/press.ts for why the wheel waits rather than
   * spins — so the screen says why the press did nothing, over the wheel,
   * where the staff panel does not cover it.
   */
  staffSigningIn: {
    en: 'Staff are signing in — the wheel is back in a moment',
    th: 'พนักงานกำลังเข้าสู่ระบบ วงล้อจะกลับมาในอีกสักครู่',
  } satisfies BilingualLine,

  resultPrefix: { en: 'You won', th: 'คุณได้รับ' } satisfies BilingualLine,
  /**
   * Stands in for the prize name when this page cannot name it — the box drew
   * from a wheel that was republished a moment ago, and the id it won with is
   * not in the bundle on screen. The response carries ids, not names, so there
   * is nothing to print; a blank heading under "You won!" is the one thing
   * worse than a generic one, and the code below it is what reception scans.
   */
  yourPrize: { en: 'Your prize', th: 'ของรางวัลของคุณ' } satisfies BilingualLine,
  wonTitle: { en: 'You won!', th: 'คุณได้รับรางวัล!' } satisfies BilingualLine,
  playAgain: {
    en: 'Press the button 2 times to play again',
    th: 'กดปุ่ม 2 ครั้งเพื่อเล่นอีกครั้ง',
  } satisfies BilingualLine,
  playAgainConfirm: {
    en: 'Press once more to play again!',
    th: 'กดอีกครั้งเพื่อเล่นต่อ!',
  } satisfies BilingualLine,

  /** The paper came out. Nothing to read off the screen. */
  takeVoucher: {
    en: 'Take your voucher from the printer',
    th: 'รับคูปองจากเครื่องพิมพ์',
  } satisfies BilingualLine,
  /**
   * The paper did not come out. This is the guest's proof, so the code and its
   * QR go on the television and the line tells them what to do with it.
   */
  showThisCode: {
    en: 'Show this code at reception',
    th: 'แสดงรหัสนี้ที่เคาน์เตอร์ต้อนรับ',
  } satisfies BilingualLine,
  scanToClaim: {
    en: 'Scan the code to claim your prize',
    th: 'สแกนรหัสเพื่อรับของรางวัล',
  } satisfies BilingualLine,
  validUntil: { en: 'Valid until', th: 'ใช้ได้ถึง' } satisfies BilingualLine,
  /** A prize with nothing to redeem — handed over at the booth. */
  collectAtBooth: {
    en: 'Collect your prize at the booth',
    th: 'รับของรางวัลที่บูธ',
  } satisfies BilingualLine,
  noCodeNeeded: {
    en: 'No code needed — just tell our staff what you won',
    th: 'ไม่ต้องใช้รหัส แจ้งพนักงานว่าคุณได้รับรางวัลอะไร',
  } satisfies BilingualLine,

  /**
   * D5's refusal, word for word, and the page's answer to every other failure
   * as well. A guest needs the same thing in both cases — a member of staff —
   * and the difference between "no prize is eligible" and "the booth service
   * did not answer" belongs in `#debug`, where somebody can act on it.
   */
  notReady: {
    en: 'Booth not ready — please call staff',
    th: 'ตู้ยังไม่พร้อม กรุณาเรียกพนักงาน',
  } satisfies BilingualLine,
  /**
   * The booth has given away every spin it was allowed today (SCRUM-257).
   *
   * Its own line rather than `notReady`, because the two ask for opposite
   * things from the family reading them. "Booth not ready" means something is
   * wrong and a member of staff can put it right; this means nothing is wrong,
   * nobody can change it today, and the only useful instruction is to come
   * back — so sending them to find staff would waste their evening and a
   * member of staff's. It is the same reason the box gives this refusal a code
   * of its own instead of collapsing it into D5's.
   */
  allSpinsGone: {
    en: "That's all the spins for today — come back tomorrow",
    th: 'วันนี้หมุนครบแล้ว พรุ่งนี้มาใหม่นะ',
  } satisfies BilingualLine,
  /**
   * The box answered a retried press with `duplicate_press`: it recorded that
   * press and minted its voucher, but has no answer left to give, so no wheel
   * turns and no card opens (see the code's note in src/booth/contract.ts).
   *
   * Its own line rather than `notReady`, because nothing is broken and the
   * prize is real: on a booth with a printer the slip was queued with the
   * spin. So the family is told the voucher is being printed, and to ask
   * staff only if it does not come out — staff can print it again with
   * "Reprint last voucher" on the panel, while it is still the booth's last.
   */
  voucherPrinting: {
    en: 'Your voucher is being printed — ask our staff if it does not come out',
    th: 'กำลังพิมพ์คูปองของคุณ หากคูปองไม่ออกมา กรุณาสอบถามพนักงาน',
  } satisfies BilingualLine,
  /**
   * No wheel, and the box cannot reach the internet: the only thing that can
   * bring the wheel is the connection. Only while the box is OFFLINE — an
   * online box with no wheel is waiting for a publish, and telling staff to
   * check the network would send them to the wrong place (`noWheelScreen`).
   */
  notSetUp: {
    en: 'Booth not set up, connect to internet',
    th: 'ตู้ยังไม่ได้ตั้งค่า กรุณาเชื่อมต่ออินเทอร์เน็ต',
  } satisfies BilingualLine,

  terms: {
    en: 'Prizes are redeemed at OTO Play Park. Terms apply.',
    th: 'ของรางวัลใช้ได้ที่ OTO Play Park ตามเงื่อนไขที่กำหนด',
  } satisfies BilingualLine,
  title: { en: 'Spin & Win', th: 'หมุนวงล้อลุ้นรางวัล' } satisfies BilingualLine,
  subtitle: {
    en: 'Win a special OTO Play Park treat today',
    th: 'ลุ้นรับของรางวัลพิเศษจาก OTO Play Park วันนี้',
  } satisfies BilingualLine,
  todayOnly: { en: 'Today only', th: 'เฉพาะวันนี้' } satisfies BilingualLine,
} as const;

/**
 * Pairing a screen (SCRUM-244).
 *
 * Its own deck rather than entries in the two above, because it is the one
 * place where a guest-facing line and a staff-facing panel sit on the same
 * screen: `guest` is bilingual and goes under the wordmark where "Booth not
 * set up" would be, and the rest is English and lives in the panel, like every
 * other staff word here.
 *
 * Nothing in it names the booth, the branch, the service or the Console's
 * address (D15). "Ask our staff" is the whole instruction a visitor needs, and
 * a member of staff already knows where the code comes from.
 */
export const PAIR_COPY = {
  guest: {
    en: 'This screen is not set up yet — please ask our staff',
    th: 'หน้าจอนี้ยังไม่ได้ตั้งค่า กรุณาสอบถามพนักงาน',
  } satisfies BilingualLine,
  title: 'Pair this screen',
  hint: 'Enter the 6-digit code from the Console',
  refused: 'That code was not accepted — ask for a new one',
  unreachable: 'The booth service did not answer',
  working: 'Pairing…',
} as const;

/** Staff-facing words. English only: these appear in panels, never on the game. */
export const STAFF_COPY = {
  signInTitle: 'Staff sign-in',
  /**
   * The PIN only. Signing in with a badge is not built yet (SCRUM-218): the
   * box holds no badge to check a scan against, so a scan is always refused
   * and counts toward the lockout. The panel does not invite one.
   */
  signInHint: 'Enter your PIN',
  signInWrong: 'That was not right',
  signInLocked: (seconds: number) => `Too many attempts — try again in ${seconds}s`,
  signInOk: 'Signed in',
  signOut: 'Sign out',
  cancel: 'Close',
  debugTitle: 'Booth diagnostics',
  debugNeedsStaff: 'Sign in to open diagnostics',
  debugSimulated: 'Simulated draws: nothing is written, printed or capped',
  // --- SCRUM-223: signing in with an account, and what a signed-in panel does
  usePin: 'PIN',
  useAccount: 'Phone & password',
  accountHint: 'Your phone number and the password you use on the POS',
  phoneLabel: 'Phone',
  passwordLabel: 'Password',
  signInButton: 'Sign in',
  working: 'Checking…',
  /** The exact words the owner asked for when the box has no internet. */
  offline: 'No internet — sign in with your PIN',
  notAssigned: 'You are not on this booth’s staff list — ask a manager',
  notAllowed: 'Your role cannot sign in at a booth — ask a manager',
  mustChange: 'Change your temporary password on the POS first',
  /** The cloud answered, and refused this box itself: revoked, replaced or out of service. */
  boxRefused: 'This box is no longer allowed here — ask a manager to check it in Console → Devices',
  /** The cloud answered that this booth has moved to another box, or was archived. */
  boothNotOnBox: 'This booth is not on this box any more — ask a manager to check Console → Devices',
  signedInAs: (who: string) => `Signed in: ${who}`,
  until: (time: string) => `Until ${time}`,
  reprint: 'Reprint last voucher',
  reprinting: 'Printing it again…',
  reprinted: 'The last voucher is printing again — same code',
  reprintQueued: 'Sent again — the printer has not printed it yet',
  reprintNoPrinter: 'No printer on this booth — nothing to print on',
  nothingToReprint: 'There is no voucher to reprint yet',
  reprintNeedsStaff: 'Sign in to reprint',
  reprintFailed: 'The reprint did not go through',
  changeBooth: 'Change booth',
} as const;

/**
 * The screens a booth BOX shows before there is a wheel (SCRUM-223): the
 * claim code on first boot, and the choice of booth on a box with several.
 * Staff-facing, English, like the rest of the panels; the line a guest might
 * read is bilingual.
 */
export const KIOSK_COPY = {
  /**
   * Also the guest's line on the no-wheel screen while the booth is online
   * and nobody has published to it yet, on a box or a paired screen alike
   * (`noWheelScreen` below): it is being set up, and staff are who can help.
   */
  guest: {
    en: 'This booth is being set up — please ask our staff',
    th: 'บูธนี้กำลังตั้งค่า กรุณาสอบถามพนักงาน',
  } satisfies BilingualLine,
  claimTitle: 'Set up this box',
  claimHint: 'Enter the claim code from Console → Devices → Add a box',
  claimButton: 'Claim',
  claimWorking: 'Registering this box…',
  claimRefused: 'That code was not accepted — it may be used or out of date. Make a new one in the Console.',
  claimUnreachable: 'The box could not reach the internet — check the network and try again',
  claimInvalid: 'That does not look like a claim code',
  pickTitle: 'Which booth is this?',
  pickHint: 'This box runs more than one booth. Choose the one at this television.',
  noBoothTitle: 'No booth on this box yet',
  /**
   * Names the code prefix because a booth cannot print a voucher without one:
   * every code the box mints starts with exactly two letters or digits, and a
   * booth station saved without them refuses every press.
   */
  noBoothHint:
    'In the Console, create a booth station on this box (Devices → New station, kind Booth, with a code prefix of two letters or digits, such as B2), then publish its wheel.',
  starting: 'Starting the box…',
} as const;

/**
 * The box's store cannot be used (SCRUM-403): the memory card lost what it
 * said it had saved, or it is failing. The box stays up and says so here,
 * full screen, instead of Chromium's error page.
 *
 * `guest` is bilingual and sits under the wordmark, like every guest line; the
 * panel is for staff and English, like every panel. The panel names the way
 * back — a new claim code, and `sudo oto-box claim --force` typed on the Pi —
 * and never a code, a box, a path or anything the box holds (D15): the steps
 * are the same on every box, and the guide has them in full.
 */
export const SERVICE_COPY = {
  guest: {
    en: 'This booth needs service — please ask our staff',
    // Not reviewed by a Thai speaker, like every Thai line in this file (see the top).
    th: 'บูธนี้ต้องได้รับการซ่อมบำรุง กรุณาสอบถามพนักงาน',
  } satisfies BilingualLine,
  title: 'This box needs service',
  unreadable: 'The store on its memory card could not be read, so no spin can be recorded.',
  damaged: 'The store on its memory card is damaged, so no spin can be recorded.',
  steps: [
    'In Console → Devices → Add a box, make a new box for this Pi, role Booth, and copy its claim code.',
    'On the Pi, run sudo oto-box claim --force and type the new code at its prompt.',
    'In the Console, move the booth and its printer to the new box.',
  ],
  keep: 'Keep the files the claim sets aside: vouchers not yet sent are in them.',
  retry: 'The box tries the card again every minute, and comes back by itself if it recovers.',
  guide: 'The steps in full: PI_BOOTH.md, section 7, “A damaged store”.',
} as const;

/**
 * The staff panel on the no-wheel screen while the booth is online. English,
 * like every other staff word here; the guest's line beside it is bilingual.
 *
 * The time is the worst case of two polls: the box asks the cloud for a new
 * wheel every 60 seconds, and this page asks the box every 30.
 */
export const NO_WHEEL_COPY = {
  title: 'No wheel published for this booth yet',
  hint: 'Publish it in Console → Booths. It appears on this television by itself, within about two minutes.',
} as const;

export interface NoWheelScreen {
  /** Under the wordmark, for anyone looking at the television. */
  guest: BilingualLine;
  /** The staff panel under it, or null for none. */
  staff: { title: string; hint: string } | null;
}

/**
 * What the television says while it has no wheel to show: nobody has
 * published one to this booth, or the box has never been able to fetch it.
 *
 * Chosen by whether the box has the internet (`BoothStatus.online`), because
 * the same missing wheel asks for opposite fixes:
 *
 *  - **offline** — "Booth not set up, connect to internet". A wheel cannot
 *    arrive without the connection.
 *  - **online** — the guest is asked to fetch staff, and staff are told the
 *    wheel has not been published and where to publish it. The connection is
 *    fine; saying "connect to internet" beside a green dot sent the person
 *    setting the booth up to check the network.
 *  - **not known yet** (null, before the box has answered) — the guest's line
 *    alone, which is true either way, and no instruction to staff until there
 *    is an answer to base one on.
 */
export function noWheelScreen(online: boolean | null): NoWheelScreen {
  if (online === false) return { guest: COPY.notSetUp, staff: null };
  return { guest: KIOSK_COPY.guest, staff: online === true ? NO_WHEEL_COPY : null };
}

/**
 * The line a refused press puts under the wheel, from the refusal's code
 * (`BoothCallError.code`; null for a failure the page has no code for) and
 * whether the box has the internet.
 *
 * Every failure without a line of its own — a 500, an unknown code, a body
 * that did not parse, the box not answering at all — ends on "Booth not
 * ready — please call staff", because in all of those a member of staff is
 * what the family needs. The named codes are the cases where that
 * instruction would be wrong:
 *
 *  - `duplicate_press` — the press was recorded and its voucher is being
 *    printed; nothing is broken.
 *  - `daily_spin_cap_reached` — the booth has run its day; staff cannot
 *    change it, tomorrow can (SCRUM-257).
 *  - `not_configured` — the box has no wheel. Offline, that needs the
 *    internet; online, it needs a publish, and the guest is asked to fetch
 *    staff rather than told to connect something that is connected.
 *  - `needs_service` — the box's store cannot be used (SCRUM-403): the
 *    notice's own line, which the full-screen notice replaces moments later.
 *
 * Nothing here reads the server's prose (D15): the code chooses a line from
 * this file's own deck.
 */
export function refusalLine(code: string | null, online: boolean | null): BilingualLine {
  switch (code) {
    case 'duplicate_press':
      return COPY.voucherPrinting;
    case 'daily_spin_cap_reached':
      return COPY.allSpinsGone;
    case 'not_configured':
      return noWheelScreen(online).guest;
    case 'needs_service':
      return SERVICE_COPY.guest;
    default:
      return COPY.notReady;
  }
}
