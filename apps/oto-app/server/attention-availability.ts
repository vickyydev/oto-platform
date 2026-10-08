// Attention writes (S2-17b round 4b). Paused by the lift while Attention items
// had no park group and its timers no lock: an item raised for one park group
// could be read, resolved and re-opened by another, and the six-hourly and
// ten-minute runs could run twice. Round 4b gave every item its park group
// (migration 0007, NOT NULL) and every writer passes the park group whose data
// raised it; the runs are the platform's `job:otoapp.attention` and
// `job:otoapp.no_show` (or, under OTOAPP_JOBS=inprocess, the app's own timers),
// one park group at a time under the night batches' lock. So writes resume.
// Kept as one switch: false pauses every Attention write again at once.
export const ATTENTION_WRITES_READY = true;
