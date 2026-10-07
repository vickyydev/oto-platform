import {
  BRIDGE_EVENT_INTENTS,
  BRIDGE_EVENT_INTENT_TYPES,
  BridgeEventCheckinSchema,
  BridgeEventCheckoutSchema,
  BridgeEventReprintSchema,
  EVENT_CHECKIN_REFUSALS,
  EVENT_FACTS,
  bandShortCode,
  normaliseBandCode,
  parseBandCode,
  parseBandShortCode,
  type BandStayView,
  type BridgeEventsDayAnswer,
  type EventCheckinRecordView,
  type EventCheckinRefusal,
  type EventCheckinOverlayRecord,
  type EventPrintJobView,
  type EventsCacheItem,
  type OfflineEventCheckedIn,
  type OfflineEventCheckedOut,
} from '@oto/shared';
import { CheckinBandRefused, type EventBandPaper, type SaleQueue, type SalePrintLogJob } from './sale-queue';
import { uuidv7 } from './signing';
import type { BoxStore, EnvelopeSealer, OverlayRecord, QueuedFact } from './store';
import type { AgentLog } from './transport';

/**
 * S2-20 E3 — CHECKING A CHILD IN AT AN EVENT WITH THE LINK DOWN (plan §5
 * "Offline": check-in and check-out are box facts, so they queue while the box
 * is offline).
 *
 * The till's Events tab, answered by the counter's box: today's events from the
 * box's copy (the `events` cache scope, which the agent pulls on every tick)
 * with what this counter recorded laid over it; a check-in that mints the kid
 * band — and the parent band when the parent stays — with the park's key and
 * prints them; a check-out; a reprint of a band the box holds the code of.
 *
 * THE MODEL IS THE DROP-OFF DESK'S (`checkin-desk.ts`): every write is ONE store
 * transaction — the bands minted, their paper queued, the fact on the outbox
 * and the overlay row — under the till's own check-in id, so the same press
 * again meets itself; every refusal is the prototype's sentence. The platform
 * files each fact once (`sync-events.ts`): a second check-in of a child the
 * platform already has in for the day resolves to the first and records no
 * band (H4).
 *
 * The rules are the platform's, read off the copy: one check-in per child per
 * day ("Already checked in"), none for a camp child not registered for the day
 * ("Not registered for today"), a reprint only while in and not out, a
 * check-out only of a child who is in — and no supervision gate.
 *
 * THE OVERLAY ROW is kind `checkin` (the drop-off desk's kind, so no store
 * needs a new one) with the EVENT's id in `member_id` and `domain: 'event'` in
 * its record, so the drop-off desk, which lists stays by their registration,
 * never sees it, and its prune leaves it to this desk's own.
 */

export interface EventsDeskHost {
  boxId: string;
  store: BoxStore;
  now(): Date;
  log: AgentLog;
  sealer(): EnvelopeSealer | null;
  sales(): SaleQueue | null;
  /** The branch's trading day by the box's clock: a copy of another day is no copy. */
  tradingDay(): string;
}

export interface EventsDeskStation {
  id: string;
  name: string;
  branchId: string;
  operatorId: string;
}

export interface EventsDeskCaller {
  accountId: string;
  can(permission: string): boolean;
  offlineFresh: boolean;
}

/** A refusal; the bridge sends it as `{ error: { code, message, details } }` with this status. */
export class EventsDeskRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EventsDeskRefusal';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const refuse = (status: number, r: EventCheckinRefusal, details?: Record<string, unknown>) =>
  new EventsDeskRefusal(status, r.code, r.message, details);

type CacheEvent = EventsCacheItem['events'][number];
type CacheAttendee = CacheEvent['attendees'][number];

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isEventRecord(row: OverlayRecord): boolean {
  return row.kind === 'checkin' && rec(row.record)?.domain === 'event';
}

/** One press per child's day at a time on this box: two tills cannot both check one child in. */
const inHand = new Set<string>();

async function holding<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inHand.has(key)) {
    throw new EventsDeskRefusal(
      409,
      'EVENT_CHECKIN_IN_PROGRESS',
      'Another till on this counter is checking this child in right now. Wait a moment, then look again.',
    );
  }
  inHand.add(key);
  try {
    return await run();
  } finally {
    inHand.delete(key);
  }
}

interface DeskView {
  item: EventsCacheItem | null;
  appliedAt: string | null;
  /** This counter's own records of the day, by `eventId|attendeeId|date`. */
  own: Map<string, EventCheckinOverlayRecord>;
}

const dayKey = (eventId: string, attendeeId: string, date: string) => `${eventId}|${attendeeId}|${date}`;

export class EventsDesk {
  private readonly host: EventsDeskHost;

  constructor(host: EventsDeskHost) {
    this.host = host;
  }

  handles(type: string): boolean {
    return BRIDGE_EVENT_INTENT_TYPES.has(type);
  }

  // --- reading the box's copy -----------------------------------------------------------

  private async view(store: BoxStore = this.host.store): Promise<DeskView> {
    const bundle = await store.readBundle(this.host.boxId, 'events').catch(() => null);
    const items = rec(bundle?.payload)?.items;
    const item = (Array.isArray(items) ? (items[0] as EventsCacheItem | undefined) : undefined) ?? null;
    const own = new Map<string, EventCheckinOverlayRecord>();
    if (store.features().overlay) {
      for (const row of await store.listOverlay(this.host.boxId, { kind: 'checkin' })) {
        if (!isEventRecord(row)) continue;
        const r = row.record as unknown as EventCheckinOverlayRecord;
        own.set(dayKey(r.eventId, r.attendeeId, r.date), r);
      }
    }
    return { item, appliedAt: bundle?.appliedAt ?? null, own };
  }

  /** Today's copy, at this station's park — or the counter's words for why there is none. */
  private today(view: DeskView, station: EventsDeskStation): EventsCacheItem {
    if (!view.item || view.item.branchId !== station.branchId || view.item.date !== this.host.tradingDay()) {
      throw refuse(503, EVENT_CHECKIN_REFUSALS.notOnBox);
    }
    return view.item;
  }

  private find(item: EventsCacheItem, eventId: string, attendeeId: string): { event: CacheEvent; attendee: CacheAttendee } {
    const event = item.events.find((e) => e.id === eventId.toLowerCase());
    const attendee = event?.attendees.find((a) => a.id === attendeeId.toLowerCase());
    if (!event || !attendee) throw refuse(404, EVENT_CHECKIN_REFUSALS.attendeeUnknown);
    return { event, attendee };
  }

  /** The bands copy's code for a band id. */
  private async codeOf(bandId: string | null | undefined): Promise<string | null> {
    if (!bandId) return null;
    const bundle = await this.host.store.readBundle(this.host.boxId, 'bands').catch(() => null);
    const rows = rec(bundle?.payload)?.items;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = rec(raw);
      if (row?.id === bandId && typeof row.code === 'string') return row.code;
    }
    return null;
  }

  /** The cache item with this counter's own days laid over it — what the board reads with the link down. */
  private overlaid(view: DeskView): EventsCacheItem | null {
    if (!view.item) return null;
    const item = view.item;
    return {
      ...item,
      events: item.events.map((e) => ({
        ...e,
        attendees: e.attendees.map((a) => {
          const own = view.own.get(dayKey(e.id, a.id, item.date));
          if (!own) return a;
          return {
            ...a,
            bucket: own.status === 'checked_out' ? ('out' as const) : ('in' as const),
            checkin: {
              status: own.status,
              checkedInAt: own.checkedInAt ?? a.checkin?.checkedInAt ?? null,
              checkedOutAt: own.checkedOutAt,
              posCheckinId: own.checkinId,
              kidBandId: own.kidBand?.id ?? a.checkin?.kidBandId ?? null,
              parentBandId: own.parentBand?.id ?? a.checkin?.parentBandId ?? null,
            },
          };
        }),
      })),
    };
  }

  // --- the intents ----------------------------------------------------------------------

  async intent(
    station: EventsDeskStation,
    caller: EventsDeskCaller,
    type: string,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    switch (type) {
      case BRIDGE_EVENT_INTENTS.day: {
        this.require(caller, 'pos:event:read');
        const view = await this.view();
        const answer: BridgeEventsDayAnswer = {
          item: view.item && view.item.branchId === station.branchId ? this.overlaid(view) : null,
          cacheAppliedAt: view.appliedAt,
        };
        return answer;
      }
      case BRIDGE_EVENT_INTENTS.checkin:
        return this.checkin(station, caller, payload, actionId);
      case BRIDGE_EVENT_INTENTS.checkout:
        return this.checkout(station, caller, payload, actionId);
      case BRIDGE_EVENT_INTENTS.reprint:
        return this.reprint(station, caller, payload, actionId);
      default:
        throw new EventsDeskRefusal(400, 'STATION_UNKNOWN_INTENT', `This box does not know the intent ${type}`);
    }
  }

  private require(caller: EventsDeskCaller, permission: string): void {
    if (!caller.can(permission)) throw new EventsDeskRefusal(403, 'FORBIDDEN', `Missing permission: ${permission}`);
  }

  private parse<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
    payload: unknown,
  ): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new EventsDeskRefusal(400, 'VALIDATION', 'That request could not be read', { issue: String(parsed.error) });
    }
    return parsed.data;
  }

  private queue(): SaleQueue {
    const queue = this.host.sales();
    if (!queue) {
      throw new EventsDeskRefusal(503, 'BOX_AGENT_ELSEWHERE', 'This counter’s box is not running here, so it cannot check anybody in right now');
    }
    return queue;
  }

  private seal(): EnvelopeSealer {
    const seal = this.host.sealer();
    if (!seal) {
      throw new EventsDeskRefusal(503, 'BOX_AGENT_ELSEWHERE', 'This counter’s box is not running here, so it cannot record anything right now');
    }
    if (!this.host.store.features().overlay) {
      throw new EventsDeskRefusal(503, 'BOX_OVERLAY_MISSING', 'This box cannot keep an offline record yet — it needs updating');
    }
    return seal;
  }

  /** One fact and its overlay row, in the caller's store transaction. */
  private async record(
    tx: BoxStore,
    station: EventsDeskStation,
    caller: EventsDeskCaller,
    fact: { type: string; payload: Record<string, unknown> },
    row: EventCheckinOverlayRecord,
    actionId: string | null,
  ): Promise<void> {
    const now = this.host.now().toISOString();
    const queued: QueuedFact = {
      type: fact.type,
      payload: caller.offlineFresh ? { ...fact.payload, offlineFresh: true } : fact.payload,
      occurredAt: now,
      stationId: station.id,
      actorKind: 'account',
      actorAccountId: caller.accountId,
      actionId: actionId ? actionId.slice(0, 200) : null,
    };
    const [record] = await tx.enqueueMany(this.host.boxId, [queued], this.seal(), now);
    await tx.putOverlay(
      this.host.boxId,
      {
        kind: 'checkin',
        entityId: row.checkinId,
        memberId: row.eventId,
        phone: null,
        record: row as unknown as Record<string, unknown>,
        eventId: record!.envelope.eventId,
      },
      now,
    );
  }

  private viewOf(row: EventCheckinOverlayRecord, staffName: string | null): EventCheckinRecordView {
    const band = (b: { id: string; code: string } | null, kind: 'kid' | 'adult') =>
      b ? { id: b.id, kind, shortCode: bandShortCode(b.code) } : null;
    return {
      id: row.checkinId,
      eventId: row.eventId,
      attendeeId: row.attendeeId,
      date: row.date,
      status: row.status,
      checkedInAt: row.checkedInAt ?? this.host.now().toISOString(),
      checkedInBy: staffName,
      checkedOutAt: row.checkedOutAt,
      checkedOutBy: row.checkedOutAt ? staffName : null,
      kidBand: band(row.kidBand, 'kid'),
      parentBand: band(row.parentBand, 'adult'),
      origin: 'box',
      syncState: 'pending',
      syncError: null,
    };
  }

  private jobsOf(jobs: readonly SalePrintLogJob[], stationId: string): EventPrintJobView[] {
    const at = this.host.now().toISOString();
    return jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      role: j.kind === 'kids_wristband' ? 'kids_band' : 'adult_band',
      status: j.status,
      stationId,
      deviceId: null,
      deviceLabel: null,
      subjectType: 'band',
      subjectId: j.subjectId,
      reprintOf: null,
      reprintReason: j.copy ? 'Reprint' : null,
      requestedByName: null,
      errorCode: j.errorCode,
      errorMessage: null,
      queuedAt: at,
      finishedAt: null,
    }));
  }

  /**
   * `event.checkin` — the platform's check-in, on the box: the copy says who is
   * registered today and who is in already; the bands are minted and printed
   * and the fact queued in one transaction.
   */
  private async checkin(
    station: EventsDeskStation,
    caller: EventsDeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:event:checkin');
    const body = this.parse(BridgeEventCheckinSchema, payload);
    const checkinId = body.checkinId.toLowerCase();
    const view = await this.view();
    const item = this.today(view, station);
    const { event, attendee } = this.find(item, body.eventId, body.attendeeId);
    const key = dayKey(event.id, attendee.id, item.date);
    const own = view.own.get(key);
    if (own?.checkinId === checkinId) {
      // The same press again: answered from the box, no second band.
      return { checkin: this.viewOf(own, body.staffName ?? null), replayed: true, printJobs: [], notes: [] };
    }
    if (own || attendee.checkin) throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyIn);
    if (!attendee.attendsOnDate) throw refuse(409, EVENT_CHECKIN_REFUSALS.notRegistered);
    const queue = this.queue();
    this.seal();
    const paper: EventBandPaper = {
      eventTitle: event.title,
      date: item.date,
      startTime: event.startTime,
      endTime: event.endTime,
      childName: attendee.name,
      parentName: attendee.parentName,
      allergy: attendee.allergy,
      dietary: attendee.dietary,
    };
    const at = this.host.now().toISOString();
    return holding(`${this.host.boxId}:${key}`, async () => {
      try {
        let row: EventCheckinOverlayRecord | null = null;
        const issued = await queue.issueEventBands({
          stationId: station.id,
          actionId,
          parent: attendee.parentAttending,
          paper,
          write: async (tx, minted) => {
            // Another till on this box got there first: nothing half-lands.
            const held = await tx.listOverlay(this.host.boxId, { kind: 'checkin', memberIds: [event.id] });
            if (held.some((r) => isEventRecord(r) && (r.record as unknown as EventCheckinOverlayRecord).attendeeId === attendee.id && (r.record as unknown as EventCheckinOverlayRecord).date === item.date)) {
              throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyIn);
            }
            row = {
              domain: 'event',
              checkinId,
              eventId: event.id,
              attendeeId: attendee.id,
              date: item.date,
              status: 'checked_in',
              checkedInAt: at,
              checkedOutAt: null,
              childName: attendee.name,
              parentName: attendee.parentName,
              allergy: attendee.allergy,
              dietary: attendee.dietary,
              kidBand: minted.kid,
              parentBand: minted.parent,
            };
            const fact: OfflineEventCheckedIn = {
              checkinId,
              eventId: event.id,
              attendeeId: attendee.id,
              eventType: event.type,
              date: item.date,
              at,
              childName: attendee.name,
              parentName: attendee.parentName,
              parentAttending: attendee.parentAttending,
              allergy: attendee.allergy,
              dietary: attendee.dietary,
              eventTitle: event.title,
              startTime: event.startTime,
              endTime: event.endTime,
              kidBand: minted.kid,
              parentBand: minted.parent,
            };
            await this.record(tx, station, caller, { type: EVENT_FACTS.checkedIn, payload: fact as unknown as Record<string, unknown> }, row, actionId);
          },
        });
        return {
          checkin: this.viewOf(row!, body.staffName ?? null),
          replayed: false,
          printJobs: this.jobsOf(issued.printing.jobs, station.id),
          notes: issued.printing.notes,
        };
      } catch (err) {
        if (err instanceof CheckinBandRefused) {
          throw new EventsDeskRefusal(503, EVENT_CHECKIN_REFUSALS.noBandOffline.code, EVENT_CHECKIN_REFUSALS.noBandOffline.message, {
            reason: err.code,
          });
        }
        throw err;
      }
    });
  }

  /** `event.checkout` — a child who is in, out; on the box's outbox for the platform's mirror. */
  private async checkout(
    station: EventsDeskStation,
    caller: EventsDeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:event:checkin');
    const body = this.parse(BridgeEventCheckoutSchema, payload);
    const view = await this.view();
    const item = this.today(view, station);
    const { event, attendee } = this.find(item, body.eventId, body.attendeeId);
    const key = dayKey(event.id, attendee.id, item.date);
    const own = view.own.get(key);
    const status = own?.status ?? attendee.checkin?.status ?? null;
    if (!status) throw refuse(409, EVENT_CHECKIN_REFUSALS.notIn);
    if (status === 'checked_out') throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyOut);
    this.seal();
    const at = this.host.now().toISOString();
    const kidBandId = attendee.checkin?.kidBandId ?? null;
    const parentBandId = attendee.checkin?.parentBandId ?? null;
    const row: EventCheckinOverlayRecord = own
      ? { ...own, status: 'checked_out', checkedOutAt: at }
      : {
          domain: 'event',
          // The platform's own check-in when the copy names it; otherwise one
          // made in the OTO App alone, which the platform mirrors on arrival.
          checkinId: attendee.checkin?.posCheckinId ?? uuidv7(),
          eventId: event.id,
          attendeeId: attendee.id,
          date: item.date,
          status: 'checked_out',
          checkedInAt: attendee.checkin?.checkedInAt ?? null,
          checkedOutAt: at,
          childName: attendee.name,
          parentName: attendee.parentName,
          allergy: attendee.allergy,
          dietary: attendee.dietary,
          kidBand: kidBandId ? { id: kidBandId, code: (await this.codeOf(kidBandId)) ?? '' } : null,
          parentBand: parentBandId ? { id: parentBandId, code: (await this.codeOf(parentBandId)) ?? '' } : null,
        };
    const fact: OfflineEventCheckedOut = {
      checkinId: row.checkinId,
      eventId: event.id,
      attendeeId: attendee.id,
      date: item.date,
      at,
    };
    await this.host.store.atomically(async (tx) => {
      await this.record(tx, station, caller, { type: EVENT_FACTS.checkedOut, payload: fact as unknown as Record<string, unknown> }, row, actionId);
    });
    return { checkin: this.viewOf(row, body.staffName ?? null), replayed: false, printJobs: [], notes: [] };
  }

  /** `event.reprint` — the same bands on fresh paper, from the codes this box holds. Writes no fact. */
  private async reprint(
    station: EventsDeskStation,
    caller: EventsDeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:event:checkin');
    const body = this.parse(BridgeEventReprintSchema, payload);
    const view = await this.view();
    const item = this.today(view, station);
    const { event, attendee } = this.find(item, body.eventId, body.attendeeId);
    const own = view.own.get(dayKey(event.id, attendee.id, item.date));
    const status = own?.status ?? attendee.checkin?.status ?? null;
    if (status !== 'checked_in') throw refuse(409, EVENT_CHECKIN_REFUSALS.notIn);
    const bands: Array<{ id: string; kind: 'kid' | 'adult'; code: string }> = [];
    const kid = own?.kidBand ?? (attendee.checkin?.kidBandId ? { id: attendee.checkin.kidBandId, code: (await this.codeOf(attendee.checkin.kidBandId)) ?? '' } : null);
    const parent = own?.parentBand ?? (attendee.checkin?.parentBandId ? { id: attendee.checkin.parentBandId, code: (await this.codeOf(attendee.checkin.parentBandId)) ?? '' } : null);
    if (kid?.code) bands.push({ ...kid, kind: 'kid' });
    if (parent?.code) bands.push({ ...parent, kind: 'adult' });
    if (bands.length === 0) throw refuse(409, EVENT_CHECKIN_REFUSALS.reprintNotOnBox);
    const printed = await this.queue().printEventBands({
      stationId: station.id,
      actionId,
      bands,
      paper: {
        eventTitle: event.title,
        date: item.date,
        startTime: event.startTime,
        endTime: event.endTime,
        childName: attendee.name,
        parentName: attendee.parentName,
        allergy: attendee.allergy,
        dietary: attendee.dietary,
      },
      copy: true,
    });
    const row: EventCheckinOverlayRecord = own ?? {
      domain: 'event',
      checkinId: attendee.checkin?.posCheckinId ?? '',
      eventId: event.id,
      attendeeId: attendee.id,
      date: item.date,
      status: 'checked_in',
      checkedInAt: attendee.checkin?.checkedInAt ?? null,
      checkedOutAt: null,
      childName: attendee.name,
      parentName: attendee.parentName,
      allergy: attendee.allergy,
      dietary: attendee.dietary,
      kidBand: kid,
      parentBand: parent,
    };
    return { checkin: this.viewOf(row, null), replayed: false, printJobs: this.jobsOf(printed.jobs, station.id), notes: printed.notes };
  }

  // --- the food counter's scan ------------------------------------------------------------

  /**
   * The event child a scanned band belongs to at this park, in and not out —
   * the online scan's event fallback (`eventBandStayForKey`), over this box's
   * copies: the bands this counter minted offline, and the bands the copy of
   * today's events names (their codes from the `bands` copy).
   */
  async stayForKey(branchId: string, key: string): Promise<BandStayView | null> {
    const view = await this.view();
    if (!view.item || view.item.branchId !== branchId) return null;
    const full = parseBandCode(key) ? normaliseBandCode(key) : null;
    const short = parseBandShortCode(key);
    const shortKey = short ? `${short.prefix}-${short.tail}` : null;
    const matches = (code: string | null | undefined) =>
      !!code && ((full !== null && normaliseBandCode(code) === full) || (shortKey !== null && bandShortCode(code) === shortKey));
    for (const e of view.item.events) {
      for (const a of e.attendees) {
        const own = view.own.get(dayKey(e.id, a.id, view.item.date));
        const status = own?.status ?? a.checkin?.status ?? null;
        if (status !== 'checked_in') continue;
        const kidCode = own?.kidBand?.code ?? (await this.codeOf(a.checkin?.kidBandId));
        if (!matches(kidCode)) continue;
        return {
          checkinId: own?.checkinId ?? a.checkin?.posCheckinId ?? a.id,
          branchId,
          childName: a.name,
          allergiesMedical: a.allergy,
          foodRestrictions: a.dietary,
          mayOrderFood: false,
          foodProvision: null,
          source: 'event',
        };
      }
    }
    return null;
  }

  /** An event check-in this box knows, as a food order's band holder. */
  async holder(checkinId: string): Promise<{ checkinId: string; childName: string; allergiesMedical: string | null; checkedOut: boolean } | null> {
    const view = await this.view();
    if (!view.item) return null;
    for (const e of view.item.events) {
      for (const a of e.attendees) {
        const own = view.own.get(dayKey(e.id, a.id, view.item.date));
        const id = own?.checkinId ?? a.checkin?.posCheckinId ?? null;
        if (id !== checkinId) continue;
        const status = own?.status ?? a.checkin?.status ?? null;
        return { checkinId: id, childName: a.name, allergiesMedical: a.allergy, checkedOut: status !== 'checked_in' };
      }
    }
    return null;
  }

  // --- the overlay's end ------------------------------------------------------------------

  /**
   * Let the `events` copy speak for a row again: its fact ACCEPTED, and an
   * `events` pull landed after that (the drop-off desk's rule, for this desk's
   * own rows).
   */
  async pruneOverlay(): Promise<number> {
    const store = this.host.store;
    if (!store.features().overlay) return 0;
    const bundle = await store.readBundle(this.host.boxId, 'events').catch(() => null);
    if (!bundle) return 0;
    const pulledAt = Date.parse(bundle.appliedAt);
    const rows = (await store.allOverlay(this.host.boxId)).filter(isEventRecord);
    if (rows.length === 0) return 0;
    const states = await store.outboxStates(
      this.host.boxId,
      rows.map((r) => r.eventId).filter((id): id is string => !!id),
    );
    const done: Array<{ kind: 'checkin'; entityId: string }> = [];
    for (const row of rows) {
      const state = row.eventId ? states.get(row.eventId) : undefined;
      if (!state || state.state !== 'acked' || !state.ackedAt) continue;
      if (Date.parse(state.ackedAt) >= pulledAt) continue;
      done.push({ kind: 'checkin', entityId: row.entityId });
    }
    return store.deleteOverlay(this.host.boxId, done);
  }
}
