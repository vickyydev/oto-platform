/**
 * Code 128, encoded on the host rather than left to the printer.
 *
 * The band carries a QR of the signed band code as its primary mark (D4), and
 * this short human-readable code beneath it — the Zebra reads both, and staff
 * can read this one out over the phone. Host-rendered means it looks the same
 * on the ESC/POS units and the TSPL ones, and needs no firmware feature that
 * might turn out to be missing (`GS k` on the G4 is unconfirmed).
 *
 * Start/stop and the mod-103 checksum are per ISO/IEC 15417. Sets B and C are
 * used; set A is not, because nothing the park prints carries control
 * characters, and an unused branch is a branch nobody tests.
 */

/** Bar/space widths for values 0-106, each 11 modules, bar first. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212',
  '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221',
  '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221',
  '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321',
  '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131',
  '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131',
  '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242',
  '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311',
  '113141', '114131', '311141', '411131', '211412', '211214', '211232', '233111',
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

export interface LinearCode {
  /** One entry per module, true where a bar prints. */
  modules: boolean[];
  /** The text to print under the bars, if the caller wants it. */
  text: string;
}

/**
 * Encode ASCII 32-126 as Code 128.
 *
 * Runs of four or more digits switch to set C, which halves the width; the band
 * is only 200 to 400 dots across, so that matters.
 */
export function encodeCode128(text: string): LinearCode {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) {
      throw new Error(
        `Code 128 here handles printable ASCII only; ${JSON.stringify(ch)} is U+${c.toString(16)}`,
      );
    }
  }

  const values: number[] = [];
  let inC = startsInSetC(text, 0);
  values.push(inC ? START_C : START_B);

  let i = 0;
  while (i < text.length) {
    if (inC) {
      if (digitRun(text, i) >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      inC = false;
      continue;
    }
    if (shouldSwitchToC(text, i)) {
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }

  let checksum = values[0] ?? 0;
  for (let k = 1; k < values.length; k++) checksum += (values[k] ?? 0) * k;
  values.push(checksum % 103);
  values.push(STOP);

  const modules: boolean[] = [];
  for (const value of values) {
    const pattern = PATTERNS[value];
    if (!pattern) throw new Error(`Code 128 value ${value} out of range`);
    let bar = true;
    for (const w of pattern) {
      const width = Number(w);
      for (let n = 0; n < width; n++) modules.push(bar);
      bar = !bar;
    }
  }
  // The stop pattern's final 2-module bar is part of the symbol.
  modules.push(true, true);

  return { modules, text };
}

function digitRun(text: string, from: number): number {
  let n = 0;
  while (from + n < text.length) {
    const c = text.charCodeAt(from + n);
    if (c < 48 || c > 57) break;
    n++;
  }
  return n;
}

function startsInSetC(text: string, from: number): boolean {
  const run = digitRun(text, from);
  // Four leading digits pay for the switch; the whole string being digits
  // always does.
  return run >= 4 && run % 2 === 0 ? true : run === text.length && run % 2 === 0 && run >= 2;
}

function shouldSwitchToC(text: string, from: number): boolean {
  const run = digitRun(text, from);
  if (run >= 6) return run % 2 === 0 || from + run < text.length;
  return from + run === text.length && run >= 4 && run % 2 === 0;
}
