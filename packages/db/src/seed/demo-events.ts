import { addDaysToIsoDate } from '@oto/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';
import { mapCoreBranchIntoApp, otoAppBranchesInstalled, otoappBranches } from '../schema/otoapp';
import { stableId } from './stable-id';

/**
 * THE DEMO DAY'S EVENTS, CAMPS AND PARTY (S2-20 E5, SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md, the E5 row of §9, and the S2-20
 * ticket's seed: "a five-day camp spanning the seeded business date with six
 * registered attendees (two allergy-flagged, one parentAttending), one one-off
 * event today with a weekday/weekend entry price, and one birthday party with a
 * package base price, a paid deposit and an open tab; branch drop-in pricing
 * seeded from the prototype values").
 *
 * WHERE. Demo Branch 2 only, as the rest of the demo day (`demo-day.ts`): its
 * branch is given its row in the OTO App through the SCRUM-268 seam
 * (`mapCoreBranchIntoApp`, anchored on the operator's own mapped branch, so the
 * row lands in the operator's tenant and the directory's key reaches it), and
 * the events are written into the OTO App's OWN tables — `core_events`,
 * `camp_registrations`, `event_attendees` — so the views the POS reads
 * (`otoapp_v.*`) return them exactly as they return an event the app made. The
 * POS's own record (`pos.event_drop_in_pricing`) holds the walk-up prices.
 *
 * WHAT. The prototype's own seed (mockApi.ts `mockCampsAndEvents`,
 * `mockParties`; catalogStore.ts `seedEventDropInPricing`), placed on the
 * demo's day:
 *
 *   - "Oto Summer Camp — Week 1": five days, two before the day to two after,
 *     09:00-17:00, ฿600 a day; six children — Emma (peanut allergy) and Noah
 *     (lactose) allergy-flagged, Lucas with a parent attending and a vegetarian
 *     diet, Mia registered only for the last two days (so "not today" shows),
 *     Lily for the first three, Arjun every day;
 *   - "Kids' Art & Craft Workshop": today 14:00-16:00, ฿350 / ฿400, three
 *     children registered (Oliver with a bee-sting allergy);
 *   - "Story Time": today 10:00-11:00, free (the acceptance's free event);
 *   - "Sophia's 5th Birthday Party": today 13:00-15:30, a ฿12,000 package with
 *     a ฿5,000 deposit paid a week before, two guests on its list; its tab is
 *     open from the first charge the till puts on it;
 *   - the walk-up prices: camp day ฿600, event day ฿350, party guest ฿450.
 *
 * CONVERGENT, like the rest of the demo day: every row's id derives from the
 * demo branch, the day and the row's key (`stableId`), and is written
 * insert-or-nothing, so a second press the same day writes nothing and a press
 * on another day writes that day's camp, workshop and party. A walk-up price
 * somebody has since edited in the Admin Events panel stays as they left it.
 *
 * A DEPLOYMENT WITHOUT THE OTO APP, or one whose app holds no branch of this
 * operator to anchor the demo branch to, gets the walk-up prices and no
 * events, and says why — nothing is invented to fill the gap.
 */

export interface DemoEventsCounts {
  /** Events written this run: the camp, the workshop, story time and the party, on a new day. */
  events: number;
  /** Children registered on them this run. */
  attendees: number;
  /** Events of this day already there, left alone. */
  eventsPresent: number;
  /** Whether the branch's walk-up prices were written by this run (false: already set). */
  pricing: boolean;
  /** Why no events were written, when none could be. */
  skipped: 'app_not_installed' | 'no_app_anchor' | 'ambiguous_name' | null;
}

/** The prototype's walk-up prices (catalogStore.ts `seedEventDropInPricing`), in satang. */
const WALK_UP = { campDay: 60_000, eventDay: 35_000, partyGuest: 45_000 } as const;

interface DemoBranchRef {
  id: string;
  name: string;
  operatorId: string;
  timezone: string;
}

const iso = (on: string, days: number) => addDaysToIsoDate(on, days);

/** A date of birth `years` before the day, for a child the prototype knew by age. */
const bornYearsBefore = (on: string, years: number) =>
  `${Number(on.slice(0, 4)) - years}${on.slice(4)}`;

/**
 * Is the OTO App's events seam on this database: its event and registration
 * tables, and the per-child attendee table its 0003 migration adds?
 */
async function appEventsInstalled(db: Db): Promise<boolean> {
  const res = await db.execute<{ events: string | null; attendees: string | null; camps: string | null }>(
    sql`select to_regclass('otoapp.core_events')::text as events,
               to_regclass('otoapp.event_attendees')::text as attendees,
               to_regclass('otoapp.camp_registrations')::text as camps`,
  );
  const row = res.rows[0];
  return Boolean(row?.events && row.attendees && row.camps);
}

export async function seedDemoEvents(
  db: Db,
  branch: DemoBranchRef,
  input: { on: string; at: Date },
): Promise<DemoEventsCounts> {
  const counts: DemoEventsCounts = { events: 0, attendees: 0, eventsPresent: 0, pricing: false, skipped: null };

  // The walk-up prices, whatever the app: they are the POS's own.
  const priced = await db
    .insert(s.eventDropInPricing)
    .values({
      branchId: branch.id,
      operatorId: branch.operatorId,
      campDayWeekdaySatang: WALK_UP.campDay,
      campDayWeekendSatang: WALK_UP.campDay,
      eventDayWeekdaySatang: WALK_UP.eventDay,
      eventDayWeekendSatang: WALK_UP.eventDay,
      partyGuestWeekdaySatang: WALK_UP.partyGuest,
      partyGuestWeekendSatang: WALK_UP.partyGuest,
    })
    .onConflictDoNothing({ target: s.eventDropInPricing.branchId })
    .returning({ branchId: s.eventDropInPricing.branchId });
  counts.pricing = priced.length > 0;

  if (!(await otoAppBranchesInstalled(db)) || !(await appEventsInstalled(db))) {
    counts.skipped = 'app_not_installed';
    return counts;
  }

  return db.transaction(async (tx) => {
    // One press at a time per demo branch and day, as the demo sales are.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${branch.operatorId}), hashtext(${`demo-events/${input.on}`}))`);
    const mapped = await mapCoreBranchIntoApp(tx, {
      operatorId: branch.operatorId,
      branchId: branch.id,
      name: branch.name,
      address: null,
      timezone: branch.timezone,
    });
    if (!mapped.appBranchId) {
      counts.skipped = mapped.reason === 'ambiguous_name' ? 'ambiguous_name' : 'no_app_anchor';
      return counts;
    }
    const [appBranch] = await tx
      .select({ id: otoappBranches.id, tenantId: otoappBranches.tenantId })
      .from(otoappBranches)
      .where(eq(otoappBranches.id, mapped.appBranchId))
      .limit(1);
    if (!appBranch) {
      counts.skipped = 'no_app_anchor';
      return counts;
    }
    const tenant = appBranch.tenantId;
    const key = (k: string) => `demo-events/${branch.id}/${input.on}/${k}`;
    const id = (k: string) => stableId(key(k), input.at);

    /** One event, insert-or-nothing; true when this run wrote it. */
    const event = async (e: {
      key: string;
      type: 'camp' | 'workshop' | 'other' | 'birthday';
      title: string;
      date: string;
      campEnd?: string;
      start: string;
      end: string;
      location: string;
      kids: number;
      adults: number;
      weekday?: number | null;
      weekend?: number | null;
      status?: string;
      party?: {
        childName: string;
        age: number;
        parentName: string;
        phone: string;
        total: number;
        deposit: number;
        depositDate: string;
        decoration: string;
        activities: string;
      };
    }): Promise<boolean> => {
      const res = await tx.execute<{ id: string }>(sql`
        insert into otoapp.core_events (
          id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
          location_text, num_children, num_adults, entry_price_weekday_thb, entry_price_weekend_thb,
          child_name, kid_turning_age, parent_name, whatsapp_phone_e164, total_value, prepayment_amount,
          prepayment_date, decoration, activities, status)
        values (
          ${id(e.key)}, ${tenant}, ${appBranch.id}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
          ${e.start}, ${e.end}, ${e.location}, ${e.kids}, ${e.adults}, ${e.weekday ?? null}, ${e.weekend ?? null},
          ${e.party?.childName ?? null}, ${e.party?.age ?? null}, ${e.party?.parentName ?? null},
          ${e.party?.phone ?? null}, ${e.party?.total ?? null}, ${e.party?.deposit ?? null},
          ${e.party?.depositDate ?? null}, ${e.party?.decoration ?? null}, ${e.party?.activities ?? null},
          ${e.status ?? 'upcoming'})
        on conflict (id) do nothing
        returning id`);
      if (res.rows.length > 0) counts.events += 1;
      else counts.eventsPresent += 1;
      return res.rows.length > 0;
    };

    // --- The camp: five days, two either side of the day -------------------------------
    const camp = { key: 'camp', start: iso(input.on, -2), end: iso(input.on, 2) };
    if (
      await event({
        key: camp.key,
        type: 'camp',
        title: 'Oto Summer Camp — Week 1',
        date: camp.start,
        campEnd: camp.end,
        start: '09:00',
        end: '17:00',
        location: 'Main Hall + Outdoor Area',
        kids: 18,
        adults: 4,
        weekday: 600,
        weekend: 600,
        status: 'in_progress',
      })
    ) {
      const everyDay: string[] = [];
      const children: Array<{
        key: string;
        name: string;
        age: number;
        language: string;
        allergies?: string;
        food?: string;
        parent: string;
        phone: string;
        parentAttending?: boolean;
        days: string[];
      }> = [
        { key: 'emma', name: 'Emma Wattanasin', age: 7, language: 'Thai / English', allergies: 'Peanut allergy — carry EpiPen (kept at front desk)', parent: 'Khun Pim Wattanasin', phone: '+66811112233', days: everyDay },
        { key: 'lucas', name: 'Lucas Bernard', age: 8, language: 'French / English', food: 'Vegetarian — no meat or fish', parent: 'Marie Bernard', phone: '+66892345566', parentAttending: true, days: everyDay },
        { key: 'mia', name: 'Mia Tanaka', age: 6, language: 'Japanese / Thai', parent: 'Yuki Tanaka', phone: '+66823456677', days: [iso(input.on, 1), iso(input.on, 2)] },
        { key: 'noah', name: 'Noah Prasert', age: 9, language: 'Thai / English', allergies: 'Lactose intolerant — avoid all dairy products', parent: 'Khun Daeng Prasert', phone: '+66854567788', days: everyDay },
        { key: 'lily', name: 'Lily Chen', age: 7, language: 'Chinese / English', food: 'Halal only', parent: 'Mei Chen', phone: '+66865678899', days: [camp.start, iso(input.on, -1), input.on] },
        { key: 'arjun', name: 'Arjun Mehta', age: 8, language: 'English / Hindi', parent: 'Priya Mehta', phone: '+66876789900', days: everyDay },
      ];
      for (const c of children) {
        await tx.execute(sql`
          insert into otoapp.camp_registrations (
            id, tenant_id, event_id, child_full_name, date_of_birth, primary_language, parent_guardian_name,
            emergency_contact_number, allergies, food_restrictions, attendance_days, parent_signature,
            signature_date, parent_attending)
          values (
            ${id(`camp/${c.key}`)}, ${tenant}, ${id(camp.key)}, ${c.name}, ${bornYearsBefore(input.on, c.age)},
            ${c.language}, ${c.parent}, ${c.phone}, ${c.allergies ?? null}, ${c.food ?? null},
            ${JSON.stringify(c.days)}::jsonb, ${c.parent}, ${camp.start}, ${c.parentAttending ?? false})
          on conflict (id) do nothing`);
        counts.attendees += 1;
      }
    }

    // --- The one-off workshop, today, at a weekday / weekend price -----------------------
    if (
      await event({
        key: 'workshop',
        type: 'workshop',
        title: "Kids' Art & Craft Workshop",
        date: input.on,
        start: '14:00',
        end: '16:00',
        location: 'Art Studio',
        kids: 10,
        adults: 5,
        weekday: 350,
        weekend: 400,
      })
    ) {
      const children: Array<{ key: string; name: string; age: number; language: string; allergies?: string; food?: string; parent: string; phone: string }> = [
        { key: 'anya', name: 'Anya Somsak', age: 5, language: 'Thai', parent: 'Khun Joy Somsak', phone: '+66911110001' },
        { key: 'oliver', name: 'Oliver Smith', age: 6, language: 'English', allergies: 'Bee sting allergy — parent carries EpiPen', parent: 'Sarah Smith', phone: '+66922220001' },
        { key: 'siri', name: 'Siri Nakamura', age: 7, language: 'Thai / Japanese', food: 'No shellfish', parent: 'Yoko Nakamura', phone: '+66933330001' },
      ];
      for (const c of children) {
        await tx.execute(sql`
          insert into otoapp.event_attendees (
            id, tenant_id, event_id, child_full_name, age_years, primary_language, allergies, food_restrictions,
            parent_name, parent_phone, parent_attending, source)
          values (
            ${id(`workshop/${c.key}`)}, ${tenant}, ${id('workshop')}, ${c.name}, ${c.age}, ${c.language},
            ${c.allergies ?? null}, ${c.food ?? null}, ${c.parent}, ${c.phone}, false, 'otoapp')
          on conflict (id) do nothing`);
        counts.attendees += 1;
      }
    }

    // --- A free event, today: a pass at ฿0 adds the child with no sale ------------------
    await event({
      key: 'story-time',
      type: 'other',
      title: 'Story Time',
      date: input.on,
      start: '10:00',
      end: '11:00',
      location: 'Library Corner',
      kids: 12,
      adults: 6,
      weekday: 0,
      weekend: 0,
    });

    // --- The birthday party, a deposit paid a week before -------------------------------
    if (
      await event({
        key: 'party',
        type: 'birthday',
        title: "Sophia's 5th Birthday Party",
        date: input.on,
        start: '13:00',
        end: '15:30',
        location: 'Party Room A',
        kids: 12,
        adults: 18,
        party: {
          childName: 'Sophia',
          age: 5,
          parentName: 'Khun Ploy',
          phone: '+66812345678',
          total: 12_000,
          deposit: 5_000,
          depositDate: iso(input.on, -7),
          decoration: 'Unicorn theme — pastel balloons, banner & table runner',
          activities: 'Face painting (13:30) + magic show (14:15)',
        },
      })
    ) {
      const guests: Array<{ key: string; name: string; age: number; allergies?: string; food?: string; parent: string; phone: string; parentAttending: boolean }> = [
        { key: 'lily-s', name: 'Lily Sukprasert', age: 5, parent: 'Khun Fon Sukprasert', phone: '+66811001001', parentAttending: true },
        { key: 'max', name: 'Max Rivers', age: 5, allergies: 'Tree nut allergy — no nuts of any kind', parent: 'Claire Rivers', phone: '+66922002001', parentAttending: true },
      ];
      for (const g of guests) {
        await tx.execute(sql`
          insert into otoapp.event_attendees (
            id, tenant_id, event_id, child_full_name, age_years, allergies, food_restrictions, parent_name,
            parent_phone, parent_attending, source)
          values (
            ${id(`party/${g.key}`)}, ${tenant}, ${id('party')}, ${g.name}, ${g.age}, ${g.allergies ?? null},
            ${g.food ?? null}, ${g.parent}, ${g.phone}, ${g.parentAttending}, 'otoapp')
          on conflict (id) do nothing`);
        counts.attendees += 1;
      }
    }
    return counts;
  });
}

/**
 * What the events part of a run did, for the demo control's one line. Empty
 * when there is nothing to say: a deployment that has no OTO App at all is not
 * told so on every press (the line reads as it always did there).
 */
export function describeDemoEvents(counts: DemoEventsCounts | undefined): string {
  if (!counts || counts.skipped === 'app_not_installed') return '';
  if (counts.skipped) {
    const why =
      counts.skipped === 'ambiguous_name'
          ? 'two OTO App branches carry the demo branch’s name'
          : 'the OTO App holds no branch of this operator to place the demo branch beside';
    return ` Events: none written — ${why}${counts.pricing ? '; walk-up prices set' : ''}.`;
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    ` Events: ${plural(counts.events, 'event added', 'events added')} ` +
    `(${plural(counts.attendees, 'child', 'children')}), ${counts.eventsPresent} already present` +
    `${counts.pricing ? '; walk-up prices set' : ''}.`
  );
}
