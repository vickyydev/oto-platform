/**
 * Who served this page (SCRUM-223).
 *
 * One build of the booth page runs in two places, and the two need different
 * first screens:
 *
 *  - **a booth box** — a Raspberry Pi under the television, serving the page
 *    itself on `http://127.0.0.1:8780/`. The box IS the credential holder:
 *    there is nothing to pair. Its first screens are "enter the claim code"
 *    (a box nobody has claimed yet) and "which booth is this?" (a box with more
 *    than one booth station);
 *  - **the staging site** — a static site whose `/booth/*` reaches the api,
 *    which relays to the virtual box. A screen there has to be PAIRED first,
 *    because the api is on the internet.
 *
 * The box tells the page by rewriting one `<meta>` in `index.html` as it
 * serves it (`markServedByBox` in `@oto/box-agent`). Anything else — the
 * staging site, `pnpm dev` — leaves it as built, `paired`. Read once: how the
 * page was loaded does not change while it runs.
 */

export type BoothHost = 'box' | 'paired';

function readHost(): BoothHost {
  if (typeof document === 'undefined') return 'paired';
  const meta = document.querySelector('meta[name="oto-booth-host"]');
  return meta?.getAttribute('content') === 'box' ? 'box' : 'paired';
}

export const boothHost: BoothHost = readHost();
