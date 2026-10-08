// seed: none — touches no row. Not a Playwright file.
//
// A clock for the harness, and nothing else: when HARNESS_FAKE_NOW names an
// instant (ISO 8601), this process's `Date` starts there and runs on from it
// — `Date.now()` and `new Date()` alike — so a check can drive the app's
// time-of-day rules (the no-show check's 07:00-22:00 Bangkok hours, S2-17b
// round 4b) whatever time the check itself runs at. Unset, it does nothing.
//
// Imported FIRST by tests/harness/serve-routes.ts, so it is in place before
// any module of the app is evaluated. Never imported by the app.
const fakeNow = process.env.HARNESS_FAKE_NOW;

if (fakeNow) {
  const RealDate = Date;
  const start = new RealDate(fakeNow).getTime();
  if (Number.isNaN(start)) throw new Error(`HARNESS_FAKE_NOW is not an instant: ${fakeNow}`);
  const offset = start - RealDate.now();
  class HarnessDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = HarnessDate as DateConstructor;
  console.log(`HARNESS_FAKE_NOW=${new Date().toISOString()}`);
}

export {};
