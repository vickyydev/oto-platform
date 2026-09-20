/**
 * A Code 128 reader, for tests only: modules in, text out.
 *
 * It measures bar and space runs the way a scanner does, looks the widths up in
 * the pattern table, verifies the mod-103 check digit and follows the code-set
 * switches — so the encoder is tested against the format rather than against
 * itself.
 */

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

export function decodeCode128Modules(modules: boolean[]): string {
  // Runs of equal colour, in modules. The trailing two-module bar of the stop
  // pattern merges into its run, which is what the table expects.
  const runs: number[] = [];
  let i = 0;
  while (i < modules.length) {
    const colour = modules[i];
    let n = 0;
    while (i < modules.length && modules[i] === colour) {
      n++;
      i++;
    }
    runs.push(n);
  }
  // Every symbol is six runs; the stop pattern has seven.
  const values: number[] = [];
  for (let at = 0; at + 6 <= runs.length; at += 6) {
    const widths = runs.slice(at, at + 6).join('');
    const value = PATTERNS.indexOf(widths);
    if (value < 0) throw new Error(`unknown Code 128 pattern ${widths} at run ${at}`);
    values.push(value);
    if (value === 106) break;
  }

  const stop = values.pop();
  if (stop !== 106) throw new Error('symbol does not end with the stop pattern');
  const check = values.pop();
  let sum = values[0] ?? 0;
  for (let k = 1; k < values.length; k++) sum += (values[k] ?? 0) * k;
  if (sum % 103 !== check) throw new Error(`check digit ${check} does not match ${sum % 103}`);

  const start = values.shift();
  let setC = start === 105;
  if (start !== 104 && start !== 105) throw new Error(`unexpected start code ${start}`);

  let out = '';
  for (const value of values) {
    if (setC) {
      if (value === 100) {
        setC = false;
        continue;
      }
      out += String(value).padStart(2, '0');
      continue;
    }
    if (value === 99) {
      setC = true;
      continue;
    }
    out += String.fromCharCode(value + 32);
  }
  return out;
}
