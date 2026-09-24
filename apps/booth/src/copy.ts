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
  /** Never synced: there is no wheel to show, so the game does not open. */
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
  signInHint: 'Enter your PIN, or scan your badge',
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
  noBoothHint: 'In the Console, create a booth station on this box (Devices → New station, kind Booth), then publish its wheel.',
  starting: 'Starting the box…',
} as const;
