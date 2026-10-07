import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { CheckIn, CheckInStatus, ContactChannel, DropOffServiceType, OtoEvent, EventAttendee, AuthorizedPickupSource } from '@/types';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import {
  getEventDropInPricing,
  getEventById,
  checkInEventAttendee,
  checkOutEventAttendee,
  type NewEventAttendeeInput,
} from '@/mockApi';
import { EVENT_WRITE_PENDING, eventsToday, useEventsForDate } from '@/api/events';
import type { ReleaseView } from '@oto/shared';
import type { Wristband } from '@/types';
import { releaseApi } from '@/api/release';
import {
  boardApi,
  boardChildToCheckIn,
  checkinApi,
  editsToPatch,
  photoUrlOf,
  requirePlatformBranchId,
  TILL_NOT_LINKED,
  type ApiBoard,
  type CheckInEdits,
} from '@/api/checkin';
import { useBranch } from '@/branch/BranchContext';
import { remainingMinutes, dueState } from '@/lib/dropoff';
import { resolveRateToday } from '@/lib/pricingMode';
import { setDropOffHandoff } from '@/lib/dropoffHandoff';
import { useOperator } from '@/auth/OperatorContext';
import { useStation } from '@/station/StationContext';
import { eventBraceletPrintJobs, dispatchPrintJobs } from '@/lib/printRouting';
import { sellEventPass, checkInSoldPass, dispatchEventBracelets } from '@/lib/eventPass';
import { toast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { StationHeader } from '@/components/shared/StationHeader';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import {
  CheckInBookedModal,
  type BookedCheckInItem,
} from '@/components/dropoff/CheckInBookedModal';
import { AssignNannyModal } from '@/components/dropoff/AssignNannyModal';
import { CheckOutModal } from '@/components/dropoff/CheckOutModal';
import { EditCheckInModal } from '@/components/dropoff/EditCheckInModal';
import { OverstayBanner } from '@/components/dropoff/OverstayBanner';
import { MessagingPanel, type MessagingContext } from '@/components/shared/MessagingPanel';
import { AuthorizedPickupSheet } from '@/components/shared/AuthorizedPickupSheet';
import { EventAttendeeList } from '@/components/parties/EventAttendeeList';
import { AddAttendeeModal } from '@/components/parties/AddAttendeeModal';
import {
  Search,
  Baby,
  X,
  WifiOff,
  MapPin,
  Users,
  Tent,
  Sparkles,
  PartyPopper,
  ChevronRight,
} from 'lucide-react';

type Tab = CheckInStatus;
type ServiceFilter = 'all' | DropOffServiceType;
type BoardTab = 'dropoff' | 'events';

const TABS: { id: Tab; label: string }[] = [
  { id: 'registered', label: 'Upcoming' },
  { id: 'in_park', label: 'In Park' },
  { id: 'out', label: 'Out' },
];

const SERVICE_FILTERS: { id: ServiceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'nanny', label: 'Nanny' },
  { id: 'drop_off', label: 'Drop-Off' },
];

const TYPE_BADGE_STYLE = {
  party: 'bg-violet-500/15 text-violet-400',
  camp: 'bg-emerald-500/15 text-emerald-400',
  event: 'bg-sky-500/15 text-sky-400',
};
const TYPE_LABEL = {
  party: 'Party',
  camp: 'Camp',
  event: 'Event',
};

/** Which status tab a single check-in belongs to. */
function tabOf(c: CheckIn): Tab {
  if (c.status === 'in_park') return 'in_park';
  if (c.status === 'out') return 'out';
  return 'registered';
}

/**
 * Canonical tab for a family: use the highest-priority status tab among its
 * children. Priority: in_park > registered (upcoming, timed or not) > out.
 */
function familyTab(family: CheckIn[]): Tab {
  if (family.some((c) => c.status === 'in_park')) return 'in_park';
  if (family.some((c) => c.status === 'registered')) return 'registered';
  return 'out';
}

// S2-20 E1 — the events board's day is the branch's trading day, not the UTC
// date (plan §4).
const todayISO = () => eventsToday();

/** The platform's refusal, in its own words (they are written for the counter). */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong — try again.';
}

/** A stay as the edit form holds it (prototype EditCheckInModal `toForm`). */
function checkInToEdits(c: CheckIn): CheckInEdits {
  return {
    childName: c.childName,
    childAge: c.childAge,
    parentName: c.parentName,
    contactMethod: c.contactMethod,
    phone: c.phone,
    serviceType: c.serviceType,
    mayOrderFood: c.mayOrderFood,
    foodRestrictions: c.foodRestrictions,
    allergiesMedical: c.allergiesMedical,
    bookedDurationMinutes: c.bookedDurationMinutes,
    assignedNannyId: c.assignedNannyId,
  };
}

export default function DropOff() {
  const { operator } = useOperator();
  const { station } = useStation();
  const [, navigate] = useLocation();
  const search = useSearch();
  const dueParam = new URLSearchParams(search).get('due') === '1';

  // ─── Board-level tab: Drop-off vs Events ────────────────────────────────
  const [boardTab, setBoardTab] = useState<BoardTab>('dropoff');

  // ─── Events board state ──────────────────────────────────────────────────
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventsVersion, setEventsVersion] = useState(0);
  const refreshEvents = () => setEventsVersion((v) => v + 1);

  const { branch } = useBranch();
  const today = todayISO();
  const branchId = branch.id;

  // S2-20 E1 — `GET /events` for today, read again when eventsVersion or the
  // board tab moves (where the prototype re-read its store) and every 30 s on
  // the Events tab, as the drop-off board polls: another till's or the OTO
  // App's check-ins land without a reload.
  const [eventsPoll, setEventsPoll] = useState(0);
  useEffect(() => {
    if (boardTab !== 'events') return;
    const id = window.setInterval(() => setEventsPoll((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [boardTab]);
  const { events: dayEvents, loaded: eventsLoaded, error: eventsError } = useEventsForDate(
    branchId,
    today,
    `${eventsVersion}|${boardTab}|${eventsPoll}`,
  );
  const todaysEvents = useMemo(
    () => dayEvents.filter((e) => (e.attendees?.length ?? 0) > 0),
    [dayEvents],
  );

  const selectedEvent = useMemo(
    () => (selectedEventId ? todaysEvents.find((e) => e.id === selectedEventId) ?? null : null),
    [selectedEventId, todaysEvents],
  );

  const operatorName = operator?.name ?? 'Unknown';
  const operatorId = operator?.id ?? 'unknown';

  /**
   * S2-20 E1 — the board's events are the OTO App's now, which the prototype's
   * in-memory mutators cannot find: checking in or out, a reprint and a walk-up
   * are written on the platform by E2 and E3, and until then say so rather
   * than answer "already checked in" for a child nobody checked in.
   */
  const writePending = (eventId: string): boolean => {
    if (getEventById(eventId)) return false;
    toast(EVENT_WRITE_PENDING);
    return true;
  };

  const handleEventCheckIn = (eventId: string, attendeeId: string) => {
    if (writePending(eventId)) return;
    const result = checkInEventAttendee(eventId, attendeeId, today, { operatorName, operatorId });
    if (!result) {
      toast({ title: 'Already checked in', description: 'This child is already checked in for today.' });
      refreshEvents();
      return;
    }

    // Dispatch bracelet print jobs through the active station (shared seam).
    const ev = todaysEvents.find((e) => e.id === eventId);
    if (ev && !dispatchEventBracelets(station, ev, result, today)) {
      toast({
        title: 'Checked in — no printer',
        description: 'Check-in recorded. No station configured — bracelet not printed.',
      });
    }

    toast({
      title: 'Checked in',
      description: `${result.attendee.name} — band ${result.wristbandCode}${result.parentWristbandCode ? ` · parent ${result.parentWristbandCode}` : ''}`,
    });
    refreshEvents();
  };

  const handleEventCheckOut = (eventId: string, attendeeId: string) => {
    if (writePending(eventId)) return;
    const att = checkOutEventAttendee(eventId, attendeeId, today, { operatorName, operatorId });
    if (att) {
      toast({ title: 'Checked out', description: `${att.name} has been checked out.` });
    }
    refreshEvents();
  };

  // Reprint a lost band for an already-checked-in attendee, reusing the stored
  // wristband code(s) — does not touch the check-in record.
  const handleEventReprint = (eventId: string, attendeeId: string) => {
    const ev = todaysEvents.find((e) => e.id === eventId);
    const attendee = ev?.attendees?.find((a) => a.id === attendeeId);
    const record = attendee?.checkinByDate?.[today];
    if (!ev || !attendee || !record?.checkedInAt || record.checkedOutAt) return;
    // No band code is known for a check-in the platform did not make (E3).
    if (writePending(eventId)) return;
    if (!station) {
      toast({
        title: 'No printer',
        description: 'No station configured — band not reprinted.',
      });
      return;
    }
    const jobs = eventBraceletPrintJobs(station, {
      eventTitle: ev.title,
      eventDate: today,
      startTime: ev.startTime,
      endTime: ev.endTime,
      kidName: attendee.name,
      wristbandCode: record.wristbandCode,
      dietaryDetail: attendee.dietaryFlag ? attendee.dietaryDetail : undefined,
      allergyDetail: attendee.allergyFlag ? attendee.allergyDetail : undefined,
      parentName: record.parentWristbandCode ? attendee.parentName : undefined,
      parentWristbandCode: record.parentWristbandCode,
    });
    dispatchPrintJobs(jobs);
    toast({
      title: 'Band reprinted',
      description: `${attendee.name} — band ${record.wristbandCode}${record.parentWristbandCode ? ` · parent ${record.parentWristbandCode}` : ''}`,
    });
  };

  // ─── Walk-up attendee (add at the door) ──────────────────────────────────
  const [showAddAttendee, setShowAddAttendee] = useState(false);

  // Entry fee for a camp/event pass sold at the door — a flat per-event price the
  // Events module owns (not tier-based). Party additions never take a door
  // payment (they ride the tab), so this stays 0 for parties.
  const doorFeeFor = (ev: OtoEvent): number =>
    ev.type === 'party' ? 0 : resolveRateToday(ev.entryPriceTHB);

  // The attendee persisted by the sell step, carried into the later check-in choice.
  const [addedAttendee, setAddedAttendee] = useState<EventAttendee | null>(null);

  // Step 1: create + bill the attendee through the shared seam (party tab vs. a
  // synthetic 'tickets' sale at the flat entry price). Called at payment
  // confirmation for a paid pass, or immediately for a party / free event. Returns
  // false so the modal stays put if the sale could not be persisted.
  const handleAddAttendeeSell = (result: {
    input: NewEventAttendeeInput;
    registerProperly: boolean;
    paymentMethod?: string;
  }): boolean => {
    const ev = selectedEvent;
    if (!ev) return false;
    if (writePending(ev.id)) return false;
    const attendee = sellEventPass({
      event: ev,
      input: result.input,
      registerProperly: result.registerProperly,
      paymentMethod: result.paymentMethod,
      today,
      operator: { operatorName, operatorId },
    });
    if (!attendee) {
      toast({ title: 'Could not add attendee', description: 'Payment or event details missing.' });
      return false;
    }
    setAddedAttendee(attendee);
    return true;
  };

  // Step 2: resolve the check-in choice for the already-persisted attendee.
  const handleAddAttendeeCheckIn = (checkInNow: boolean) => {
    const ev = selectedEvent;
    const attendee = addedAttendee;
    if (!ev || !attendee) {
      setShowAddAttendee(false);
      setAddedAttendee(null);
      refreshEvents();
      return;
    }
    if (checkInNow) {
      const res = checkInSoldPass(station, ev, attendee.id, today, { operatorName, operatorId });
      if (res) {
        toast({
          title: 'Checked in',
          description: `${res.checkin.attendee.name} — band ${res.checkin.wristbandCode}${
            res.checkin.parentWristbandCode ? ` · parent ${res.checkin.parentWristbandCode}` : ''
          }${res.printed ? '' : ' · no printer — band not printed'}`,
        });
      } else {
        toast({ title: 'Added', description: `${attendee.name} is on the ${ev.title} roster.` });
      }
    } else {
      toast({
        title: 'Pass sold — left as booked',
        description: `${attendee.name} added to ${ev.title}. Check in later from the roster.`,
      });
    }
    setShowAddAttendee(false);
    setAddedAttendee(null);
    refreshEvents();
  };

  // ─── Drop-off board state ────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>(dueParam ? 'in_park' : 'registered');
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all');
  const [query, setQuery] = useState('');
  const [assignFor, setAssignFor] = useState<CheckIn | null>(null);
  // Booked (already-paid) children selected for the payment-free check-in modal.
  const [checkInBookedFor, setCheckInBookedFor] = useState<CheckIn[] | null>(null);
  const [checkOutFor, setCheckOutFor] = useState<CheckIn | null>(null);
  const [editFor, setEditFor] = useState<CheckIn | null>(null);
  const [messageCtx, setMessageCtx] = useState<MessagingContext | null>(null);
  const [dueOnly, setDueOnly] = useState(dueParam);
  const [waFlagged, setWaFlagged] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  // ─── The board, from the platform (S2-13 round 2) ────────────────────────
  // The prototype read `getCheckIns()` from its in-memory store; the board is
  // the platform's now. It is re-read after every action (the `version`
  // bump), and every 30 seconds so a check-in at another till shows up here.
  // The timers stay client-ticked on the 10-second `now` above.
  //
  // S2-13 round 4 — with the link down the BOX answers: `boardApi`,
  // `checkinApi` and `releaseApi` run on the lane the arbiter says
  // (`lib/lane.ts`), so the board reads the box's copy with what this counter
  // recorded offline laid over it, and an edit, a nanny, a booked check-in and
  // a release are written to the box's outbox to reach the platform once.
  // Photos taken offline stay on the box until its upload worker sends them.
  const platformBranchId = useMemo(() => {
    try {
      return requirePlatformBranchId(branchId);
    } catch {
      return null;
    }
  }, [branchId]);
  const [board, setBoard] = useState<ApiBoard | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Record<string, string>>({});

  const loadBoard = useCallback(async () => {
    if (!platformBranchId) {
      setBoard(null);
      setBoardError(TILL_NOT_LINKED);
      return;
    }
    try {
      setBoard(await boardApi.board(platformBranchId));
      setBoardError(null);
    } catch (err) {
      setBoardError(messageOf(err));
    }
  }, [platformBranchId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard, version]);

  useEffect(() => {
    const id = window.setInterval(() => void loadBoard(), 30_000);
    return () => window.clearInterval(id);
  }, [loadBoard]);

  // The consent photos, each asked for once (every read is access-logged, R-94).
  useEffect(() => {
    if (!board) return;
    const wanted = new Set<string>();
    for (const f of board.families) {
      for (const c of f.children) {
        const fileId = c.photoFileId ?? f.photoFileId;
        if (fileId && !photos[fileId]) wanted.add(fileId);
      }
    }
    for (const fileId of wanted) {
      void photoUrlOf(fileId).then((url) => {
        if (url) setPhotos((p) => (p[fileId] ? p : { ...p, [fileId]: url }));
      });
    }
  }, [board, photos]);

  const all = useMemo<CheckIn[]>(
    () =>
      (board?.families ?? []).flatMap((f) =>
        f.children.map((c) => {
          const fileId = c.photoFileId ?? f.photoFileId;
          return boardChildToCheckIn(c, f, fileId ? photos[fileId] : null);
        }),
      ),
    [board, photos],
  );

  const allByReg = useMemo(() => {
    const map = new Map<string, CheckIn[]>();
    for (const c of all) {
      const arr = map.get(c.registrationId);
      if (arr) arr.push(c);
      else map.set(c.registrationId, [c]);
    }
    return map;
  }, [all]);

  const counts = useMemo(() => {
    return all.reduce(
      (acc, c) => {
        acc[tabOf(c)] += 1;
        return acc;
      },
      { registered: 0, in_park: 0, out: 0 } as Record<Tab, number>,
    );
  }, [all]);

  const nannies = useMemo(() => board?.nannies ?? [], [board]);
  const softMax = board?.nannyRatioSoftMax ?? 3;
  const freeNannies = useMemo(() => nannies.filter((n) => n.onShift), [nannies]);

  const visibleFamilies = useMemo(() => {
    const q = query.trim().toLowerCase();

    const families: CheckIn[][] = [];
    for (const children of allByReg.values()) {
      if (familyTab(children) !== tab) continue;
      if (serviceFilter !== 'all' && !children.some((c) => c.serviceType === serviceFilter)) continue;
      if (tab === 'in_park' && dueOnly) {
        if (!children.some((c) => dueState(remainingMinutes(c)) !== 'ok')) continue;
      }
      if (waFlagged) {
        const hasUnconfirmed = children.some(
          (c) => !c.waConnection || c.waConnection.status !== 'confirmed',
        );
        if (!hasUnconfirmed) continue;
      }
      if (q) {
        const matches = children.some((c) =>
          `${c.childName} ${c.parentName} ${c.phone}`.toLowerCase().includes(q),
        );
        if (!matches) continue;
      }

      families.push([...children].sort((a, b) => a.childName.localeCompare(b.childName)));
    }

    if (tab === 'in_park') {
      families.sort((a, b) => {
        const minA = Math.min(...a.map((c) => remainingMinutes(c) ?? Infinity));
        const minB = Math.min(...b.map((c) => remainingMinutes(c) ?? Infinity));
        return minA - minB;
      });
    }

    // Upcoming (not yet checked in): earliest booked time first so the soonest
    // arrivals are at the top; walk-ins with no booked time fall to the bottom.
    if (tab === 'registered') {
      const earliest = (fam: CheckIn[]) =>
        Math.min(...fam.map((c) => (c.scheduledFor ? new Date(c.scheduledFor).getTime() : Infinity)));
      families.sort((a, b) => earliest(a) - earliest(b));
    }

    return families;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now is the 10-second tick: remainingMinutes() reads the clock itself, so this re-filters and re-sorts as children fall due
  }, [allByReg, tab, serviceFilter, query, dueOnly, waFlagged, now]);

  const waFlaggedCount = useMemo(() => {
    let count = 0;
    for (const children of allByReg.values()) {
      if (
        children.some((c) => !c.waConnection || c.waConnection.status !== 'confirmed')
      ) {
        count++;
      }
    }
    return count;
  }, [allByReg]);

  const selectTab = (t: Tab) => {
    setTab(t);
    if (t !== 'in_park') setDueOnly(false);
  };

  const handleBannerTap = () => {
    setBoardTab('dropoff');
    setTab('in_park');
    setServiceFilter('all');
    setQuery('');
    setDueOnly(true);
  };

  // On shift is checked again by the platform: "not on shift" comes back as
  // the refusal, and the soft ratio as a warning that never blocks.
  const handleAssign = async (nannyId: string) => {
    if (!assignFor) return;
    try {
      const res = await boardApi.assignNanny(assignFor.id, nannyId);
      toast({
        title: 'Nanny assigned',
        description: [`${res.checkin.nannyName ?? 'The nanny'} is looking after ${res.checkin.childName}.`, ...res.warnings].join(' '),
      });
    } catch (err) {
      toast({
        title: 'Could not assign',
        description: messageOf(err),
        variant: 'destructive',
      });
    }
    refresh();
  };

  const handleCheckIn = (c: CheckIn) => {
    setDropOffHandoff(c.registrationId);
    navigate('/');
  };

  const [pickupsFor, setPickupsFor] = useState<CheckIn | null>(null);

  /**
   * The child's band, from the REAL check-in link (S2-13 round 4 hand-over):
   * the board's stay carries the band id the platform (or the box) linked at
   * check-in. The board read carries the band's id and not its printed code,
   * and the modal reads neither — the remaining prepaid balance is the
   * platform's since round 3 — so this is the band's identity only. No mock
   * wristband store is consulted any more.
   */
  const checkOutWristband = useMemo<Wristband | undefined>(() => {
    if (!checkOutFor || !board) return undefined;
    const stay = board.families.flatMap((f) => f.children).find((c) => c.id === checkOutFor.id);
    if (!stay?.bandId) return undefined;
    return {
      id: stay.bandId,
      code: '',
      customerNickname: checkOutFor.parentName,
      creditBalanceTHB: 0,
      holderName: checkOutFor.childName,
      ...(checkOutFor.allergiesMedical ? { allergiesMedical: checkOutFor.allergiesMedical } : {}),
    } as Wristband;
  }, [checkOutFor, board]);
  const prepaidFoodPolicy = board?.prepaidFoodUnused ?? 'refund';

  const handleManagePickups = (c: CheckIn) => setPickupsFor(c);

  /**
   * Promote a chat photo to the pickup list — through the platform
   * (`releaseApi.promoteFromChat`: the image stored under the registration,
   * the person added `from_chat`, audited). No in-memory list any more.
   */
  const handleAddPickupFromPhoto = (
    _messageId: string,
    imageUrl: string,
    input: { name: string; relationship?: string; phone?: string },
  ) => {
    const registrationId = messageCtx?.registrationId;
    if (!registrationId) return;
    void releaseApi
      .promoteFromChat(registrationId, { ...input, imageUrl })
      .then((added) => {
        toast({ title: 'Pickup added', description: `${added.name} has been added to the authorized pickup list.` });
        refresh();
      })
      .catch((err: unknown) => {
        toast({ title: 'Could not add the pickup', description: messageOf(err), variant: 'destructive' });
      });
  };

  /**
   * After the modal RELEASED the child (it writes the release itself — R-92,
   * the pickup photo, the prepaid settlement), the board only tells the
   * counter what was recorded and re-reads itself from the API. It never
   * releases a second time, and no mock check-out runs any more.
   */
  const handleConfirmCheckOut = (
    _pickupPhotoUrl: string,
    collectorInput: {
      pickupId: string;
      name: string;
      relationship?: string;
      isDropperOff: boolean;
      source: AuthorizedPickupSource;
    },
    _reconciliation?: { unusedTHB: number; policy: 'refund' | 'forfeit' },
    release?: ReleaseView,
  ) => {
    if (!checkOutFor) return;
    const childName = release?.childName || checkOutFor.childName;
    const collector = release?.collectorName || collectorInput.name;
    let description = `${childName} was released to ${collector}.`;
    const settlement = release?.settlement ?? null;
    if (settlement && settlement.unusedSatang > 0) {
      const unusedTHB = settlement.unusedSatang / 100;
      if (settlement.settlementError === 'refund_no_sale') {
        toast({
          title: 'Manual refund required',
          description: `฿${unusedTHB} unused prepaid food could not be refunded automatically. Please issue a manual refund of ฿${unusedTHB} to the family.`,
          variant: 'destructive',
        });
      } else {
        description +=
          settlement.policy === 'refund'
            ? ` Prepaid food refund of ฿${unusedTHB} recorded.`
            : ` ฿${unusedTHB} prepaid food forfeited.`;
      }
    }
    toast({ title: 'Checked out', description });
    refresh();
  };

  const handleMessage = (c: CheckIn) => {
    const endTime =
      c.checkedInAt && c.bookedDurationMinutes
        ? new Date(
            new Date(c.checkedInAt).getTime() + c.bookedDurationMinutes * 60_000,
          ).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : undefined;
    setMessageCtx({
      parentName: c.parentName,
      phone: c.phone,
      childName: c.childName,
      time: endTime,
      registrationId: c.registrationId,
      channel: c.contactMethod,
    });
  };

  /**
   * Booked, already-paid children (prototype `checkInFamilyBooked`): NO
   * payment and no sale (R-90). A consent photo captured here is uploaded to
   * the registration first; then the platform puts the children in the park
   * and prints their bands on the sale they were paid on.
   */
  const handleConfirmCheckInBooked = async (items: BookedCheckInItem[]) => {
    const family = checkInBookedFor ?? [];
    try {
      for (const it of items) {
        if (!it.childPhotoUrl) continue;
        const child = family.find((c) => c.id === it.checkInId);
        if (child) await checkinApi.uploadPhoto(child.registrationId, it.childPhotoUrl, [child.id]);
      }
      const res = await boardApi.checkInBooked({
        entries: items.map((it) => ({ checkinId: it.checkInId, nannyId: it.nannyId ?? null })),
        consentAcknowledged: items.some((it) => it.confirmationsAccepted === true),
      });
      setCheckInBookedFor(null);
      const n = res.children.length;
      toast({
        title: 'Checked in',
        description: [`${n} ${n === 1 ? 'child is' : 'children are'} now in the park.`, ...res.notes].join(' '),
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Check-in failed',
        description: messageOf(err),
      });
    }
    refresh();
  };

  // The contact-channel test (R-95): the message goes out through the
  // platform's console messaging adapter; the chip reads the family's state.
  const handleResend = async (c: CheckIn) => {
    try {
      await boardApi.contactTest(c.registrationId);
      toast({
        title: 'Message resent',
        description: `Connection check resent to ${c.parentName} (${c.phone}).`,
      });
    } catch (err) {
      toast({ title: 'Could not resend', description: messageOf(err), variant: 'destructive' });
    }
    refresh();
  };

  const handleSimulateConfirm = async (c: CheckIn) => {
    try {
      await boardApi.contactStatus(c.registrationId, 'confirmed');
      toast({
        title: `${CHANNEL_LABEL[normalizeChannel(c.contactMethod)]} confirmed`,
        description: `${c.parentName} tapped "Confirm received" — channel is verified.`,
      });
    } catch (err) {
      toast({ title: 'Could not confirm', description: messageOf(err), variant: 'destructive' });
    }
    refresh();
  };

  const handleMarkFailed = async (c: CheckIn) => {
    try {
      await boardApi.contactStatus(c.registrationId, 'failed');
      toast({
        title: 'Marked as unreachable',
        description: `Ask ${c.parentName} to update their number, then resend.`,
        variant: 'destructive',
      });
    } catch (err) {
      toast({ title: 'Could not save', description: messageOf(err), variant: 'destructive' });
    }
    refresh();
  };

  const handleSaveAndResend = async (c: CheckIn, newPhone: string, newChannel: ContactChannel) => {
    try {
      const body = editsToPatch(c, { ...checkInToEdits(c), phone: newPhone, contactMethod: newChannel });
      // A changed number or channel is re-tested by the platform with the
      // edit; an unchanged one is simply sent again.
      const res = Object.keys(body).length ? await boardApi.edit(c.id, body) : null;
      if (!res || res.contact?.status !== 'pending') await boardApi.contactTest(c.registrationId);
      toast({
        title: 'Number updated & re-sent',
        description: `Confirmation resent to ${c.parentName} (${newPhone}).`,
      });
    } catch (err) {
      toast({ title: 'Could not save', description: messageOf(err), variant: 'destructive' });
    }
    refresh();
  };

  // One audited PATCH: the platform writes the before/after of every changed
  // field, and that IS the change log the edit modal reads back.
  const handleSaveEdit = async (edits: CheckInEdits) => {
    if (!editFor) return;
    const body = editsToPatch(editFor, edits);
    if (Object.keys(body).length === 0) {
      toast({ title: 'No changes', description: `Nothing changed for ${editFor.childName}.` });
      return;
    }
    try {
      const res = await boardApi.edit(editFor.id, body);
      toast({
        title: res.changed > 0 ? 'Changes saved' : 'No changes',
        description: [
          res.changed > 0
            ? `${res.changed} field${res.changed === 1 ? '' : 's'} updated for ${res.checkin.childName}.`
            : `Nothing changed for ${res.checkin.childName}.`,
          ...res.warnings,
        ].join(' '),
      });
    } catch (err) {
      toast({
        title: 'Could not save',
        description: messageOf(err),
        variant: 'destructive',
      });
    }
    refresh();
  };

  // ─── Events check-in count (for board tab badge) ─────────────────────────
  const eventsCheckedInCount = useMemo(() => {
    let count = 0;
    for (const ev of todaysEvents) {
      for (const att of ev.attendees ?? []) {
        if (att.checkinByDate?.[today]?.checkedInAt && !att.checkinByDate?.[today]?.checkedOutAt) {
          count++;
        }
      }
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kept as written: recounts when todaysEvents is re-read; adding today would also recount on its own when the date turns
  }, [todaysEvents, eventsVersion]);

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      <StationHeader active="dropoff" />

      <div className="flex-1 min-h-0 p-6">
        <div className="mx-auto h-full max-w-6xl flex flex-col min-h-0">

          {/* Top-level board switch: Drop-off | Events */}
          <div className="shrink-0 flex items-center gap-1 rounded-lg bg-muted p-1 mb-4 self-start">
            <button
              type="button"
              onClick={() => { setBoardTab('dropoff'); setSelectedEventId(null); }}
              className={`h-9 px-5 rounded-md text-sm font-semibold transition-colors ${
                boardTab === 'dropoff'
                  ? 'bg-background shadow text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Drop-off
            </button>
            <button
              type="button"
              onClick={() => setBoardTab('events')}
              className={`h-9 px-5 rounded-md text-sm font-semibold transition-colors flex items-center gap-2 ${
                boardTab === 'events'
                  ? 'bg-background shadow text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Events
              {eventsCheckedInCount > 0 && (
                <span className="text-[11px] tabular-nums rounded-full px-1.5 bg-emerald-500/20 text-emerald-400 font-bold">
                  {eventsCheckedInCount} in
                </span>
              )}
            </button>
          </div>

          {/* ── Events check-in board ─────────────────────────────────────── */}
          {boardTab === 'events' && (
            selectedEvent ? (
              <EventAttendeeList
                event={selectedEvent}
                onBack={() => setSelectedEventId(null)}
                checkInDate={today}
                onCheckIn={(attendeeId) => handleEventCheckIn(selectedEvent.id, attendeeId)}
                onCheckOut={(attendeeId) => handleEventCheckOut(selectedEvent.id, attendeeId)}
                onReprint={(attendeeId) => handleEventReprint(selectedEvent.id, attendeeId)}
                onAddAttendee={() => setShowAddAttendee(true)}
                refreshKey={eventsVersion}
              />
            ) : (
              <EventsBoardList
                events={todaysEvents}
                today={today}
                eventsVersion={eventsVersion}
                loaded={eventsLoaded}
                error={eventsError}
                onSelect={setSelectedEventId}
              />
            )
          )}

          {/* ── Drop-off board (existing, completely unchanged) ───────────── */}
          {boardTab === 'dropoff' && (
            <>
              {/* Overstay notification banner */}
              <OverstayBanner onReview={handleBannerTap} refreshKey={version} className="mb-3" />

              {/* Search */}
              <div className="shrink-0 relative mb-3">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search child, parent or phone…"
                  className="h-12 pl-12 text-base"
                />
              </div>

              {/* Service filter chips + WA flagged filter */}
              <div className="shrink-0 flex items-center gap-2 mb-3 flex-wrap">
                {SERVICE_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setServiceFilter(f.id)}
                    className={`h-9 px-4 rounded-full text-sm font-semibold transition-colors ${
                      serviceFilter === f.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setWaFlagged((v) => !v)}
                  className={`h-9 px-4 rounded-full text-sm font-semibold transition-colors flex items-center gap-2 ${
                    waFlagged
                      ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <WifiOff className="w-3.5 h-3.5" />
                  Unconfirmed
                  {waFlaggedCount > 0 && (
                    <span className={`text-[11px] tabular-nums rounded-full px-1.5 ${waFlagged ? 'bg-red-500/30' : 'bg-background/60'}`}>
                      {waFlaggedCount}
                    </span>
                  )}
                </button>
              </div>

              {/* Status tabs */}
              <div className="shrink-0 flex items-center gap-1 rounded-lg bg-muted p-1 mb-4">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTab(t.id)}
                    className={`flex-1 h-10 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                      tab === t.id
                        ? 'bg-background shadow text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t.label}
                    <span
                      className={`text-[11px] tabular-nums rounded-full px-1.5 ${
                        tab === t.id ? 'bg-muted text-foreground' : 'bg-background/60'
                      }`}
                    >
                      {counts[t.id]}
                    </span>
                  </button>
                ))}
              </div>

              {/* In Park: due-only filter chip */}
              {tab === 'in_park' && dueOnly && (
                <div className="shrink-0 mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full bg-amber-500/15 text-amber-300 text-xs font-semibold px-3 h-8">
                    Showing due soon / overdue
                    <button
                      type="button"
                      onClick={() => setDueOnly(false)}
                      aria-label="Clear filter"
                      className="hover:text-amber-100"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              )}

              {/* Upcoming: who's free to take a child */}
              {tab === 'registered' && (
                <div className="shrink-0 mb-3 text-xs text-muted-foreground">
                  {freeNannies.length > 0 ? (
                    <>
                      Nannies free now:{' '}
                      <span className="text-foreground font-semibold">
                        {freeNannies.map((n) => n.name).join(', ')}
                      </span>
                    </>
                  ) : (
                    'No nannies free right now.'
                  )}
                </div>
              )}

              {/* List */}
              {visibleFamilies.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
                  <Baby className="w-12 h-12 mb-3 opacity-40" />
                  <p>{boardError ?? (board ? 'No children in this list.' : 'Loading…')}</p>
                </div>
              ) : (
                <ScrollArea className="flex-1 -mx-1 px-1">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-2">
                    {visibleFamilies.map((family) => (
                      <FamilyCheckInCard
                        key={family[0].registrationId}
                        family={family}
                        onMessage={handleMessage}
                        onAssignNanny={setAssignFor}
                        onCheckIn={handleCheckIn}
                        onCheckOut={setCheckOutFor}
                        onCheckInBooked={setCheckInBookedFor}
                        onEdit={setEditFor}
                        onResend={(c) => void handleResend(c)}
                        onSimulateConfirm={(c) => void handleSimulateConfirm(c)}
                        onMarkFailed={(c) => void handleMarkFailed(c)}
                        onSaveAndResend={(c, phone, channel) => void handleSaveAndResend(c, phone, channel)}
                        onManagePickups={handleManagePickups}
                      />
                    ))}
                  </div>
                </ScrollArea>
              )}
            </>
          )}
        </div>
      </div>

      {assignFor && (
        <AssignNannyModal
          open={!!assignFor}
          onOpenChange={(open) => !open && setAssignFor(null)}
          checkIn={assignFor}
          nannies={nannies}
          softMax={softMax}
          onAssign={(id) => void handleAssign(id)}
        />
      )}

      {checkInBookedFor && (
        <CheckInBookedModal
          open={!!checkInBookedFor}
          onOpenChange={(open) => !open && setCheckInBookedFor(null)}
          family={checkInBookedFor}
          nannies={nannies}
          softMax={softMax}
          onConfirm={(items) => void handleConfirmCheckInBooked(items)}
        />
      )}

      {checkOutFor && (
        <CheckOutModal
          open={!!checkOutFor}
          onOpenChange={(open) => !open && setCheckOutFor(null)}
          checkIn={checkOutFor}
          wristband={checkOutWristband}
          prepaidFoodPolicy={prepaidFoodPolicy}
          onConfirm={handleConfirmCheckOut}
        />
      )}

      {editFor && (
        <EditCheckInModal
          open={!!editFor}
          onOpenChange={(open) => !open && setEditFor(null)}
          checkIn={editFor}
          nannies={nannies}
          softMax={softMax}
          onSave={(edits) => void handleSaveEdit(edits)}
        />
      )}

      <MessagingPanel
        open={!!messageCtx}
        onOpenChange={(open) => !open && setMessageCtx(null)}
        context={messageCtx}
        category="drop_off"
        onAddPickupFromPhoto={handleAddPickupFromPhoto}
      />

      <AuthorizedPickupSheet
        open={!!pickupsFor}
        onOpenChange={(open) => !open && setPickupsFor(null)}
        registrationId={pickupsFor?.registrationId ?? ''}
        parentName={pickupsFor?.parentName}
      />

      {selectedEvent && (
        <AddAttendeeModal
          open={showAddAttendee}
          onOpenChange={(o) => {
            setShowAddAttendee(o);
            if (!o) setAddedAttendee(null);
          }}
          event={selectedEvent}
          isParty={selectedEvent.type === 'party'}
          doorFeeTHB={doorFeeFor(selectedEvent)}
          tabChargeTHB={
            selectedEvent.type === 'party'
              ? resolveRateToday(getEventDropInPricing().partyGuestTHB)
              : undefined
          }
          onSell={handleAddAttendeeSell}
          onCheckIn={handleAddAttendeeCheckIn}
        />
      )}
    </div>
  );
}

// ─── Events board list (select-an-event panel) ──────────────────────────────
function EventsBoardList({
  events,
  today,
  loaded,
  error,
  onSelect,
}: {
  events: OtoEvent[];
  today: string;
  eventsVersion: number;
  /** S2-20 E1: false until today's first answer is in, so "No events today" is never said early. */
  loaded: boolean;
  /** S2-20 E1: why there is no list (no platform branch, a refused read), said where the list would be. */
  error: string | null;
  onSelect: (id: string) => void;
}) {
  if (events.length === 0) {
    if (!loaded) return <div className="flex-1" />;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
        <PartyPopper className="w-12 h-12 mb-3 opacity-40" />
        <p className="font-semibold">{error ? 'Events could not be loaded' : 'No events today'}</p>
        <p className="text-sm mt-1 text-muted-foreground/70">{error ?? 'Events with registered attendees appear here.'}</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 -mx-1 px-1">
      <div className="space-y-2 pb-2">
        {events.map((ev) => {
          const attendees = ev.attendees ?? [];
          const checkedInCount = attendees.filter(
            (a) => a.checkinByDate?.[today]?.checkedInAt && !a.checkinByDate?.[today]?.checkedOutAt,
          ).length;
          const isParty = ev.type === 'party';

          return (
            <button
              key={ev.id}
              type="button"
              onClick={() => onSelect(ev.id)}
              className="w-full text-left"
            >
              <Card className="p-4 flex items-center gap-4 bg-card/50 hover:bg-card transition-colors">
                {/* Time */}
                <div className="flex flex-col items-center justify-center w-16 shrink-0">
                  <span className="text-lg font-black tabular-nums leading-none">{ev.startTime}</span>
                  <span className="text-xs text-muted-foreground mt-0.5">{ev.endTime}</span>
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-bold flex-wrap">
                    <span className="truncate">{ev.title}</span>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${TYPE_BADGE_STYLE[ev.type]}`}
                    >
                      {TYPE_LABEL[ev.type]}
                    </span>
                    {ev.type === 'camp' && ev.dateRange && (
                      <span className="text-[10px] text-muted-foreground font-normal">
                        {ev.dateRange.start} – {ev.dateRange.end}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap mt-0.5">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {ev.location}
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {attendees.length} registered
                    </span>
                    {isParty && ev.childName && (
                      <span className="flex items-center gap-1">
                        {ev.childName}{ev.kidAge ? ` · ${ev.kidAge} yrs` : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right side: checked-in count + chevron */}
                <div className="flex items-center gap-3 shrink-0">
                  {checkedInCount > 0 && (
                    <span className="flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/10 rounded-full px-2.5 py-1">
                      {checkedInCount} in
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {ev.type === 'camp' ? <Tent className="w-4 h-4" /> : ev.type === 'event' ? <Sparkles className="w-4 h-4" /> : null}
                  </span>
                  <ChevronRight className="w-5 h-5 text-muted-foreground" />
                </div>
              </Card>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
