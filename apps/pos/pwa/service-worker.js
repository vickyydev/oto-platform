/**
 * The till's service worker: what makes the POS shell come up with no internet.
 *
 * WHY IT IS HERE AND NOT IN `src/`. This file is not part of the app bundle —
 * it runs in a worker with no DOM, its own global, and its own lifetime. Vite
 * emits it separately (see the `otoServiceWorker` plugin in vite.config.ts),
 * which rewrites the three placeholders below with the real build id and the
 * real hashed filenames. Editing it needs a rebuild to take effect; editing it
 * and NOT rebuilding changes nothing, which is the usual first confusion.
 *
 * ── WHAT IS CACHED ────────────────────────────────────────────────────────
 *
 * The shell and nothing else: `index.html`, the hashed JS and CSS Vite emitted,
 * the Inter faces, the logo, the favicon and the manifest. That list is fixed
 * at build time and written into `PRECACHE` below.
 *
 * ── WHAT IS NOT ───────────────────────────────────────────────────────────
 *
 * Every `/api/*` response, without exception and without a fallback. A member's
 * phone number, a child's allergy, a sale, a staff name: none of it is ever
 * written to a Cache Storage bucket by this worker. The reasoning is physical
 * rather than legal — a till is an iPad on a counter in a shopping mall, it can
 * be picked up and carried out, and Cache Storage survives being carried out.
 * Anything the till may work from while the link is down belongs on the box,
 * where it is one locked cupboard rather than one unlocked counter, and where
 * S2-05's cache bundle already puts it.
 *
 * This is enforced by construction and not by intention: `install` is the ONLY
 * place this file ever writes to a cache, and it writes exactly `PRECACHE`. A
 * reader can check that claim by searching this file for `.put(` and `addAll`.
 *
 * ── HOW A NEW VERSION REACHES A TILL THAT IS NEVER CLOSED ──────────────────
 *
 * A reception iPad may not be reloaded for weeks, so "it updates on next
 * refresh" is not an answer. The sequence is:
 *
 *   1. The page asks the browser to re-check this file — on a timer, when the
 *      tab becomes visible, and when the network comes back (see
 *      `src/pwa/register.ts`). `updateViaCache: 'none'` on the registration
 *      keeps that check off the HTTP cache, or it would answer from a
 *      week-old copy and nothing would ever update.
 *   2. A changed build id makes this a different file, so the browser installs
 *      the new worker beside the running one and it precaches the new assets.
 *   3. It then WAITS. `skipWaiting()` is deliberately not called here: taking
 *      over mid-sale would swap the code under a cart. The new worker sits in
 *      `waiting` for as long as it takes.
 *   4. The page applies it — only at the lock screen, with no open sale — by
 *      posting `OTO_SKIP_WAITING`. The reload that follows is ours.
 *
 * Which means a till mid-sale can hold an update for hours, and that is the
 * intended behaviour rather than a bug: it lands at the next lock, which on a
 * counter is a matter of minutes.
 */

const BUILD_ID = '__BUILD_ID__';
const BASE = '__BASE__';
const PRECACHE = __PRECACHE__;

/** One bucket per build, so activating a new worker cannot serve old chunks. */
const CACHE_NAME = `oto-pos-shell-${BUILD_ID}`;
/** Every bucket this worker is allowed to delete on activate — ours, no one else's. */
const CACHE_PREFIX = 'oto-pos-shell-';

const INDEX_URL = `${BASE}index.html`;

/** Fast membership test for "is this one of the files we precached". */
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `reload` so an install never picks the shell up out of the HTTP cache:
      // the whole point of this step is to hold the bytes of THIS build.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * True for anything addressed to the platform API.
 *
 * The POS calls `/api/…` from `src/api/client.ts` regardless of the base path,
 * and on Render that same path is rewritten to the api service, so this one
 * test covers development, preview and staging. It deliberately matches the
 * bare `/api` too, and it is applied before anything else below.
 */
function isApi(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // A mutation is never served from a cache and never recorded in one.
  if (request.method !== 'GET') return;

  // `only-if-cached` outside a same-origin fetch throws if we respond at all;
  // it is what devtools issues when it asks the cache directly.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Another origin is the browser's business, not ours.
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;

  // Any address in the app — `/`, `/history`, `/admin`, `/book` — is the same
  // single page, so an offline reload of any of them is answered with the
  // shell this build precached. Served from the cache FIRST rather than from
  // the network: the HTML and the hashed chunks have to come from the same
  // build or the page loads and then fails on a chunk that is no longer
  // deployed, and the only thing that guarantees they match is this worker's
  // own bucket.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(INDEX_URL, { cacheName: CACHE_NAME });
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  const path = url.pathname + url.search;
  if (PRECACHED.has(url.pathname) || PRECACHED.has(path)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(url.pathname, { cacheName: CACHE_NAME });
        if (cached) return cached;
        return fetch(request);
      })(),
    );
  }

  // Everything else same-origin — `robots.txt`, an image added later — goes to
  // the network and is not remembered. Offline it fails, which is honest: this
  // worker never promised it.
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  // The page has decided this is a safe moment (lock screen, no open sale).
  if (data.type === 'OTO_SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Which build is actually serving this tab — asked by the page so a report
  // of "it still shows the old screen" can be answered with a number.
  if (data.type === 'OTO_VERSION' && event.source) {
    event.source.postMessage({ type: 'OTO_VERSION', version: BUILD_ID });
  }
});
