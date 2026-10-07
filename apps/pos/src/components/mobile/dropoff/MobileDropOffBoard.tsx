import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReleaseView } from '@oto/shared';
import { CheckIn, CheckInStatus, ContactChannel, DropOffServiceType, OtoEvent } from '@/types';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import {
  getEventById,
  checkInEventAttendee,
  checkOutEventAttendee,
} from '@/mockApi';
import { EVENT_WRITE_PENDING, eventsToday, useEventsForDate } from '@/api/events';
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
import { releaseApi } from '@/api/release';
import { CheckInBookedModal, type BookedCheckInItem } from '@/components/dropoff/CheckInBookedModal';
import { remainingMinutes, dueState } from '@/lib/dropoff';
import { setDropOffHandoff } from '@/lib/dropoffHandoff';
import { eventBraceletPrintJobs, dispatchPrintJobs } from '@/lib/printRouting';
import { useOperator } from '@/auth/OperatorContext';
import { useStation } from '@/station/StationContext';
import { useBranch } from '@/branch/BranchContext';
import { useLocation } from 'wouter';
import { toast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { OverstayBanner } from '@/components/dropoff/OverstayBanner';
import { AssignNannyModal } from '@/components/dropoff/AssignNannyModal';
import { EditCheckInModal } from '@/components/dropoff/EditCheckInModal';
import { MessagingPanel, type MessagingContext } from '@/components/shared/MessagingPanel';
import { AuthorizedPickupSheet } from '@/components/shared/AuthorizedPickupSheet';
import { HandToCustomer } from '@/components/mobile/HandToCustomer';
import { useLanguage } from '@/i18n/LanguageContext';
import { MobileEventAttendeeList } from '../parties/MobileEventAttendeeList';
import { MobileChildCard } from './MobileChildCard';
import { MobileChildDetail } from './MobileChildDetail';
import { MobileCheckInConsent } from './MobileCheckInConsent';
import { MobileCheckOutView, type CollectorInput } from './MobileCheckOutView';
import { Search, Baby, X, PartyPopper, MapPin, Users, ChevronRight } from 'lucide-react';

type Tab = CheckInStatus;
type ServiceFilter = 'all' | DropOffServiceType;
type View = 'board' | 'detail';
type BoardTab = 'dropoff' | 'events';

// S2-20 E1 — the branch's trading day, not the UTC date (plan §4).
const todayISO = () => eventsToday();

const EVENT_TYPE_BADGE: Record<OtoEvent['type'], string> = {
  party: 'bg-violet-500/15 text-violet-400',
  camp: 'bg-emerald-500/15 text-emerald-400',
  event: 'bg-sky-500/15 text-sky-400',
};
const EVENT_TYPE_LABEL: Record<OtoEvent['type'], string> = {
  party: 'Party',
  camp: 'Camp',
  event: 'Event',
};

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

function tabOf(c: CheckIn): Tab {
  if (c.status === 'in_park') return 'in_park';
  if (c.status === 'out') return 'out';
  return 'registered';
}

function familyTab(family: CheckIn[]): Tab {
  if (family.some((c) => c.status === 'in_park')) return 'in_park';
  if (family.some((c) => c.status === 'registered')) return 'registered';
  return 'out';
}

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

/**
 * Portrait drop-off board for the mobile shell. Manages the full check-in /
 * check-out surface on a single phone screen:
 *   - Board list: segmented status tabs + All/Nanny/Drop-Off filter + search.
 *     One card per family (siblings share a registrationId).
 *   - Family detail: full-screen with all children, per-child edit/assign-nanny,
 *     and family-level check-in, check-out, and message actions.
 *   - Check-in: HandToCustomer takeover where the parent completes consent,
 *     food-authorization, and child-photo capture; staff then navigates to the
 *     Till for payment (same setDropOffHandoff path as the iPad).
 *   - Check-out: full-screen with live camera pickup-photo capture.
 *
 * THE DATA IS THE PLATFORM'S, through the same calls as the desktop board
 * (`pages/DropOff.tsx`): the board from `boardApi.board`, every edit, nanny
 * and contact-channel action through `boardApi`, the consent photo through
 * `checkinApi.uploadPhoto`, a booked family's check-in through
 * `boardApi.checkInBooked`, and the release through `releaseApi` (inside
 * MobileCheckOutView). Nothing here writes to the in-memory store; the events
 * tab alone stays on it, as the desktop board's does. Each call runs on the
 * lane the arbiter says (`lib/lane.ts`), so the counter's box answers while the
 * link is down.
 */
export function MobileDropOffBoard() {
  const { operator } = useOperator();
  const { t } = useLanguage();
  const [, navigate] = useLocation();

  // ── View ───────────────────────────────────────────────────────────────────
  const [view, setView] = useState<View>('board');
  /** The family on the detail screen, by registration: re-read from every board answer. */
  const [selectedRegId, setSelectedRegId] = useState<string | null>(null);

  // ── Board filters ──────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>('registered');
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all');
  const [query, setQuery] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [waFlagged, setWaFlagged] = useState(false);

  // ── Data / clock ───────────────────────────────────────────────────────────
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  // ── The board, from the platform (desktop `DropOff.tsx`, S2-13 round 2) ────
  // Re-read after every action (the `version` bump) and every 30 seconds so a
  // check-in at another till shows up here; the timers tick on `now` above.
  const { station } = useStation();
  const { branch } = useBranch();
  const platformBranchId = useMemo(() => {
    try {
      return requirePlatformBranchId(branch.id);
    } catch {
      return null;
    }
  }, [branch.id]);
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

  /** All check-ins grouped by registrationId. */
  const allByReg = useMemo(() => {
    const map = new Map<string, CheckIn[]>();
    for (const c of all) {
      const arr = map.get(c.registrationId);
      if (arr) arr.push(c);
      else map.set(c.registrationId, [c]);
    }
    return map;
  }, [all]);

  /** Tab counts are per-child. */
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

  /** The family on the detail screen, as the latest board answer holds it. */
  const selectedFamily = useMemo(() => {
    if (!selectedRegId) return null;
    const family = allByReg.get(selectedRegId);
    return family ? [...family].sort((a, b) => a.childName.localeCompare(b.childName)) : null;
  }, [allByReg, selectedRegId]);

  /**
   * Visible families: one CheckIn[] per registrationId, filtered and ordered.
   * A family appears if any child matches the active filters.
   */
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
          (c) =>
            !!c.phone.trim() &&
            (!c.waConnection || c.waConnection.status !== 'confirmed'),
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

    // Upcoming: soonest booked arrival first; walk-ins with no booked time last.
    if (tab === 'registered') {
      const earliest = (fam: CheckIn[]) =>
        Math.min(...fam.map((c) => (c.scheduledFor ? new Date(c.scheduledFor).getTime() : Infinity)));
      families.sort((a, b) => earliest(a) - earliest(b));
    }

    return families;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now is the 10-second tick: remainingMinutes() reads the clock itself, so this re-filters and re-sorts as children fall due
  }, [allByReg, tab, serviceFilter, query, dueOnly, waFlagged, now]);

  /** Count of families with an unconfirmed WA connection. */
  const waFlaggedCount = useMemo(() => {
    let count = 0;
    for (const children of allByReg.values()) {
      if (
        children.some(
          (c) =>
            !!c.phone.trim() &&
            (!c.waConnection || c.waConnection.status !== 'confirmed'),
        )
      ) {
        count++;
      }
    }
    return count;
  }, [allByReg]);

  // ── Overlay / modal state ──────────────────────────────────────────────────
  const [assignFor, setAssignFor] = useState<CheckIn | null>(null);
  const [editFor, setEditFor] = useState<CheckIn | null>(null);
  const [messageCtx, setMessageCtx] = useState<MessagingContext | null>(null);
  const [checkOutFor, setCheckOutFor] = useState<CheckIn | null>(null);
  const [pickupsFor, setPickupsFor] = useState<CheckIn | null>(null);
  // Booked (already-paid) children for the payment-free check-in.
  const [checkInBookedFor, setCheckInBookedFor] = useState<CheckIn[] | null>(null);

  const [checkInFor, setCheckInFor] = useState<CheckIn | null>(null);
  const [consentPhoto, setConsentPhoto] = useState<string | undefined>();
  const [consentMayOrderFood, setConsentMayOrderFood] = useState(true);
  const [consentAck, setConsentAck] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);

  const operatorName = operator?.name ?? 'Unknown';
  const operatorId = operator?.id ?? 'unknown';

  // ── Events check-in board (door check-in into today's events) ───────────────
  const today = todayISO();
  const [boardTab, setBoardTab] = useState<BoardTab>('dropoff');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventsVersion, setEventsVersion] = useState(0);
  const refreshEvents = () => setEventsVersion((v) => v + 1);

  // S2-20 E1 — `GET /events` for today, read again on the refresh bump, on
  // a switch to the Events tab and every 30 s while it is open, as the
  // drop-off board polls.
  const [eventsPoll, setEventsPoll] = useState(0);
  useEffect(() => {
    if (boardTab !== 'events') return;
    const id = window.setInterval(() => setEventsPoll((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [boardTab]);
  const { events: dayEvents, loaded: eventsLoaded, error: eventsError } = useEventsForDate(
    branch.id,
    today,
    `${eventsVersion}|${boardTab}|${eventsPoll}`,
  );
  const todaysEvents = useMemo(
    () => dayEvents.filter((e) => (e.attendees?.length ?? 0) > 0),
    [dayEvents],
  );

  /**
   * S2-20 E1 — the events are the OTO App's now, which the prototype's
   * in-memory mutators cannot find: a check-in, a check-out and a reprint are
   * written on the platform by E3, and until then say so rather than answer
   * "already checked in" for a child nobody checked in.
   */
  const writePending = (eventId: string): boolean => {
    if (getEventById(eventId)) return false;
    toast(EVENT_WRITE_PENDING);
    return true;
  };
  const selectedEvent = useMemo(
    () => (selectedEventId ? todaysEvents.find((e) => e.id === selectedEventId) ?? null : null),
    [selectedEventId, todaysEvents],
  );
  const eventsCheckedInCount = useMemo(() => {
    let n = 0;
    for (const ev of todaysEvents) {
      for (const a of ev.attendees ?? []) {
        const rec = a.checkinByDate?.[today];
        if (rec?.checkedInAt && !rec?.checkedOutAt) n++;
      }
    }
    return n;
  }, [todaysEvents, today]);

  const handleEventCheckIn = (eventId: string, attendeeId: string) => {
    if (writePending(eventId)) return;
    const result = checkInEventAttendee(eventId, attendeeId, today, { operatorName, operatorId });
    if (!result) {
      toast({ title: 'Already checked in', description: 'This child is already checked in for today.' });
      refreshEvents();
      return;
    }
    const ev = todaysEvents.find((e) => e.id === eventId);
    if (ev) {
      if (station) {
        const jobs = eventBraceletPrintJobs(station, {
          eventTitle: ev.title,
          eventDate: today,
          startTime: ev.startTime,
          endTime: ev.endTime,
          kidName: result.attendee.name,
          wristbandCode: result.wristbandCode,
          dietaryDetail: result.attendee.dietaryFlag ? result.attendee.dietaryDetail : undefined,
          allergyDetail: result.attendee.allergyFlag ? result.attendee.allergyDetail : undefined,
          parentName: result.parentWristbandCode ? result.attendee.parentName : undefined,
          parentWristbandCode: result.parentWristbandCode,
        });
        dispatchPrintJobs(jobs);
      } else {
        toast({
          title: 'Checked in — no printer',
          description: 'Check-in recorded. No station configured — bracelet not printed.',
        });
      }
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

  const handleEventReprint = (eventId: string, attendeeId: string) => {
    const ev = todaysEvents.find((e) => e.id === eventId);
    const attendee = ev?.attendees?.find((a) => a.id === attendeeId);
    const record = attendee?.checkinByDate?.[today];
    if (!ev || !attendee || !record) return;
    // No band code is known for a check-in the platform did not make (E3).
    if (writePending(eventId)) return;
    if (!station) {
      toast({ title: 'No printer configured', description: 'Set up this station before reprinting a band.' });
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
      title: 'Reprinting band',
      description: `${attendee.name} — band ${record.wristbandCode}${record.parentWristbandCode ? ` · parent ${record.parentWristbandCode}` : ''}`,
    });
  };

  /** The park's policy for unused prepaid food — the release view shows the platform's own answer once it has it. */
  const prepaidFoodPolicy = board?.prepaidFoodUnused ?? 'refund';

  // ── Helpers ────────────────────────────────────────────────────────────────

  const selectTab = (t: Tab) => {
    setTab(t);
    if (t !== 'in_park') setDueOnly(false);
  };

  const openDetail = (family: CheckIn[]) => {
    setSelectedRegId(family[0]?.registrationId ?? null);
    setView('detail');
  };

  const closeDetail = () => {
    setView('board');
    setSelectedRegId(null);
  };

  // ── Platform handlers (the desktop board's calls) ──────────────────────────

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
    setAssignFor(null);
    refresh();
  };

  const handleCheckIn = (c: CheckIn) => {
    setConsentPhoto(undefined);
    setConsentMayOrderFood(c.mayOrderFood);
    setConsentAck(false);
    setCheckInFor(c);
  };

  /**
   * The parent hands the phone back: the food choice and the photo (child and
   * guardian together, for pickup verification) are written to the platform —
   * an audited edit and the registration's consent photo — and only then does
   * staff go to the till for the payment. A refusal keeps the hand-over open.
   */
  const handleConsentDone = async () => {
    const c = checkInFor;
    if (!c || consentBusy) return;
    setConsentBusy(true);
    try {
      if (consentMayOrderFood !== c.mayOrderFood) {
        await boardApi.edit(c.id, { mayOrderFood: consentMayOrderFood });
      }
      if (consentPhoto) {
        await checkinApi.uploadPhoto(c.registrationId, consentPhoto, [c.id]);
      }
    } catch (err) {
      toast({ title: 'Could not save', description: messageOf(err), variant: 'destructive' });
      setConsentBusy(false);
      return;
    }
    setConsentBusy(false);
    setCheckInFor(null);
    setDropOffHandoff(c.registrationId);
    navigate('/');
  };

  const handleManagePickups = (c: CheckIn) => setPickupsFor(c);

  /**
   * Promote a chat photo to the pickup list — through the platform
   * (`releaseApi.promoteFromChat`: the image stored under the registration,
   * the person added `from_chat`, audited).
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
        toast({ title: 'Pickup added', description: `${added.name} added to the authorized pickup list.` });
        refresh();
      })
      .catch((err: unknown) => {
        toast({ title: 'Could not add the pickup', description: messageOf(err), variant: 'destructive' });
      });
  };

  /**
   * After the view RELEASED the child on the platform (it writes the release
   * itself — R-92, the pickup photo, the prepaid settlement), the board only
   * tells the counter what was recorded and re-reads itself. It never releases
   * a second time.
   */
  const handleConfirmCheckOut = (
    _pickupPhotoUrl: string,
    _collectorInput: CollectorInput,
    release: ReleaseView,
  ) => {
    if (!checkOutFor) return;
    const childName = release.childName || checkOutFor.childName;
    let description = `${childName} was released to their pickup.`;
    const settlement = release.settlement ?? null;
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
    if (view === 'detail') closeDetail();
    setCheckOutFor(null);
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
   * "Mark Arrived" on a booked family. On the platform a booked child is one
   * already paid for ("Leave as booked" at the till linked the sale), and
   * arriving is checking them in on that sale with no payment (R-90) — the
   * desktop board's booked check-in (`boardApi.checkInBooked`), with its
   * nanny, consent and photo confirmation.
   */
  const handleMarkArrived = (c: CheckIn) => {
    const family = allByReg.get(c.registrationId) ?? [c];
    const booked = family.filter((k) => k.status === 'registered' && !!k.scheduledFor);
    setCheckInBookedFor(booked.length > 0 ? booked : [c]);
  };

  const handleConfirmCheckInBooked = async (items: BookedCheckInItem[]) => {
    const family = checkInBookedFor ?? [];
    try {
      for (const it of items) {
        if (!it.childPhotoUrl) continue;
        const kid = family.find((k) => k.id === it.checkInId);
        if (kid) await checkinApi.uploadPhoto(kid.registrationId, it.childPhotoUrl, [kid.id]);
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
  // platform's messaging adapter; the chip reads the family's state.
  const handleResend = async (c: CheckIn) => {
    if (!c.phone.trim()) {
      toast({
        title: 'No contact number',
        description: `Add a number for ${c.parentName} before resending.`,
        variant: 'destructive',
      });
      return;
    }
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
    const target = editFor;
    setEditFor(null);
    const body = editsToPatch(target, edits);
    if (Object.keys(body).length === 0) {
      toast({ title: 'No changes', description: `Nothing changed for ${target.childName}.` });
      return;
    }
    try {
      const res = await boardApi.edit(target.id, body);
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
      toast({ title: 'Could not save', description: messageOf(err), variant: 'destructive' });
    }
    refresh();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* ── Board ── */}
      {/* The board also stands in when the open family is no longer on it. */}
      {(view === 'board' || !selectedFamily) && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Board switch: Drop-off | Events (hidden while an event roster is open) */}
          {!(boardTab === 'events' && selectedEvent) && (
            <div className="mx-4 mt-3 shrink-0 flex items-center gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                onClick={() => {
                  setBoardTab('dropoff');
                  setSelectedEventId(null);
                }}
                className={`flex-1 h-9 rounded-md text-sm font-semibold transition-colors ${
                  boardTab === 'dropoff'
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground'
                }`}
              >
                Drop-off
              </button>
              <button
                type="button"
                onClick={() => setBoardTab('events')}
                className={`flex-1 h-9 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  boardTab === 'events'
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground'
                }`}
              >
                Events
                {eventsCheckedInCount > 0 && (
                  <span className="text-[10px] tabular-nums rounded-full px-1.5 bg-emerald-500/20 text-emerald-400 font-bold">
                    {eventsCheckedInCount} in
                  </span>
                )}
              </button>
            </div>
          )}

          {boardTab === 'events' ? (
            selectedEvent ? (
              <MobileEventAttendeeList
                event={selectedEvent}
                onBack={() => setSelectedEventId(null)}
                checkInDate={today}
                onCheckIn={(attendeeId) => handleEventCheckIn(selectedEvent.id, attendeeId)}
                onCheckOut={(attendeeId) => handleEventCheckOut(selectedEvent.id, attendeeId)}
                onReprint={(attendeeId) => handleEventReprint(selectedEvent.id, attendeeId)}
                refreshKey={eventsVersion}
              />
            ) : (
              <EventsCheckInList
                events={todaysEvents}
                today={today}
                loaded={eventsLoaded}
                error={eventsError}
                onSelect={setSelectedEventId}
              />
            )
          ) : (
          <>
          {/* Overstay banner */}
          <OverstayBanner
            onReview={() => {
              selectTab('in_park');
              setDueOnly(true);
            }}
            refreshKey={version}
            className="mx-4 mt-3"
          />

          {/* Search */}
          <div className="mx-4 mt-3 relative shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search child, parent or phone…"
              className="h-10 pl-9 text-sm"
            />
          </div>

          {/* Service filter chips */}
          <div className="mx-4 mt-2 shrink-0 flex items-center gap-2 overflow-x-auto">
            {SERVICE_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setServiceFilter(f.id)}
                className={`h-8 px-3 rounded-full text-xs font-semibold transition-colors shrink-0 ${
                  serviceFilter === f.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}

            {/* WA unconfirmed flagged filter */}
            <button
              type="button"
              onClick={() => setWaFlagged((v) => !v)}
              className={`h-8 px-3 rounded-full text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0 ${
                waFlagged
                  ? 'bg-red-500/90 text-white'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              WA unconfirmed
              {waFlaggedCount > 0 && (
                <span
                  className={`text-[10px] tabular-nums rounded-full px-1.5 ${
                    waFlagged ? 'bg-white/25' : 'bg-background/60'
                  }`}
                >
                  {waFlaggedCount}
                </span>
              )}
            </button>
          </div>

          {/* Status tabs */}
          <div className="mx-4 mt-2 shrink-0 flex items-center gap-1 rounded-lg bg-muted p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTab(t.id)}
                className={`flex-1 h-8 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1 ${
                  tab === t.id
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
                <span
                  className={`text-[10px] tabular-nums rounded-full px-1 ${
                    tab === t.id ? 'bg-muted text-foreground' : 'bg-background/60'
                  }`}
                >
                  {counts[t.id]}
                </span>
              </button>
            ))}
          </div>

          {/* Due-only chip */}
          {tab === 'in_park' && dueOnly && (
            <div className="mx-4 mt-1.5 shrink-0">
              <span className="inline-flex items-center gap-2 rounded-full bg-amber-500/15 text-amber-300 text-xs font-semibold px-3 h-7">
                Due soon / overdue
                <button
                  type="button"
                  onClick={() => setDueOnly(false)}
                  aria-label="Clear filter"
                  className="hover:text-amber-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            </div>
          )}

          {/* Upcoming: free nannies */}
          {tab === 'registered' && (
            <div className="mx-4 mt-1.5 shrink-0 text-xs text-muted-foreground">
              {freeNannies.length > 0 ? (
                <>
                  Free nannies:{' '}
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
            <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground px-4">
              <Baby className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">{boardError ?? (board ? 'No children in this list.' : 'Loading…')}</p>
            </div>
          ) : (
            <ScrollArea className="flex-1 mt-2 min-h-0">
              <div className="px-4 pb-4 space-y-2">
                {visibleFamilies.map((family) => (
                  <MobileChildCard
                    key={family[0].registrationId}
                    family={family}
                    onTap={openDetail}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
          </>
          )}
        </div>
      )}

      {/* ── Family detail ── */}
      {view === 'detail' && selectedFamily && (
        <MobileChildDetail
          family={selectedFamily}
          onBack={closeDetail}
          onMessage={handleMessage}
          onAssignNanny={setAssignFor}
          onCheckIn={handleCheckIn}
          onCheckOut={(c) => setCheckOutFor(c)}
          onMarkArrived={handleMarkArrived}
          onEdit={setEditFor}
          onResend={(c) => void handleResend(c)}
          onSimulateConfirm={(c) => void handleSimulateConfirm(c)}
          onMarkFailed={(c) => void handleMarkFailed(c)}
          onSaveAndResend={(c, phone, channel) => void handleSaveAndResend(c, phone, channel)}
          onManagePickups={handleManagePickups}
        />
      )}

      {/* ── Check-out full-screen (above detail / board) ── */}
      {checkOutFor && (
        <MobileCheckOutView
          checkIn={checkOutFor}
          prepaidFoodPolicy={prepaidFoodPolicy}
          onConfirm={handleConfirmCheckOut}
          onCancel={() => setCheckOutFor(null)}
        />
      )}

      {/* ── Check-in consent (HandToCustomer overlay, highest z) ── */}
      {checkInFor && (
        <HandToCustomer
          title={t('handToCustomer.checkInTitle', { name: checkInFor.parentName })}
          subtitle={t('handToCustomer.checkInSubtitle')}
          handBackLabel={t('handToCustomer.parentDoneHandBack')}
          onDone={() => void handleConsentDone()}
          onCancel={() => setCheckInFor(null)}
        >
          <MobileCheckInConsent
            checkIn={checkInFor}
            photoUrl={consentPhoto}
            mayOrderFood={consentMayOrderFood}
            consentAck={consentAck}
            onPhotoCapture={(url) => setConsentPhoto(url)}
            onPhotoClear={() => setConsentPhoto(undefined)}
            onMayOrderFoodChange={setConsentMayOrderFood}
            onConsentAckChange={setConsentAck}
          />
        </HandToCustomer>
      )}

      {/* ── Shared modals (Dialog-based, render above everything) ── */}
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
    </div>
  );
}

// ─── Events check-in list (today's events with attendees) ────────────────────
function EventsCheckInList({
  events,
  today,
  loaded,
  error,
  onSelect,
}: {
  events: OtoEvent[];
  today: string;
  /** S2-20 E1: false until today's first answer is in, so "No events today" is never said early. */
  loaded: boolean;
  /** S2-20 E1: why there is no list, said where the list would be. */
  error: string | null;
  onSelect: (id: string) => void;
}) {
  if (events.length === 0) {
    if (!loaded) return <div className="flex-1" />;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground px-4">
        <PartyPopper className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-semibold">{error ? 'Events could not be loaded' : 'No events today'}</p>
        <p className="text-xs mt-1 text-muted-foreground/70">
          {error ?? 'Events with registered attendees appear here.'}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 mt-3 min-h-0">
      <div className="px-4 pb-4 space-y-2">
        {events.map((ev) => {
          const attendees = ev.attendees ?? [];
          const checkedInCount = attendees.filter(
            (a) =>
              a.checkinByDate?.[today]?.checkedInAt && !a.checkinByDate?.[today]?.checkedOutAt,
          ).length;

          return (
            <button
              key={ev.id}
              type="button"
              onClick={() => onSelect(ev.id)}
              className="w-full text-left"
            >
              <Card className="p-3 bg-card/50 hover:bg-card transition-colors active:scale-[0.99]">
                <div className="flex items-start gap-3">
                  {/* Time column */}
                  <div className="flex flex-col items-center justify-center w-14 shrink-0 pt-0.5">
                    <span className="text-base font-black tabular-nums leading-none">
                      {ev.startTime}
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">{ev.endTime}</span>
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-bold truncate text-sm">{ev.title}</span>
                      <span
                        className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0 ${EVENT_TYPE_BADGE[ev.type]}`}
                      >
                        {EVENT_TYPE_LABEL[ev.type]}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {ev.location}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {attendees.length} registered
                      </span>
                    </div>
                  </div>

                  {/* Checked-in count + chevron */}
                  <div className="flex items-center gap-2 shrink-0">
                    {checkedInCount > 0 && (
                      <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 rounded-full px-2 py-0.5">
                        {checkedInCount} in
                      </span>
                    )}
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              </Card>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
