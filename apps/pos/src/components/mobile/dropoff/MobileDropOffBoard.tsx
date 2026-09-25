import { useEffect, useMemo, useState } from 'react';
import { CheckIn, CheckInStatus, ContactChannel, DropOffServiceType, OtoEvent, AuthorizedPickupSource } from '@/types';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import {
  getCheckIns,
  getMockWristbands,
  getDropOffPricing,
  getNannyRoster,
  assignNanny,
  checkOut,
  markArrived,
  updateCheckIn,
  resendWaConfirmation,
  simulateWaConfirm,
  markWaConnectionFailed,
  getEventsForDate,
  checkInEventAttendee,
  checkOutEventAttendee,
  applyCheckInPhotos,
  addPickupFromChatPhoto,
  type CheckInEdits,
} from '@/mockApi';
import { remainingMinutes, dueState, computePrepaidFoodReconciliation } from '@/lib/dropoff';
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
import { MobileCheckOutView } from './MobileCheckOutView';
import { Search, Baby, X, PartyPopper, MapPin, Users, ChevronRight } from 'lucide-react';

type Tab = CheckInStatus;
type ServiceFilter = 'all' | DropOffServiceType;
type View = 'board' | 'detail';
type BoardTab = 'dropoff' | 'events';

const todayISO = () => new Date().toISOString().slice(0, 10);

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
 */
export function MobileDropOffBoard() {
  const { operator } = useOperator();
  const { t } = useLanguage();
  const [, navigate] = useLocation();

  // ── View ───────────────────────────────────────────────────────────────────
  const [view, setView] = useState<View>('board');
  const [selectedFamily, setSelectedFamily] = useState<CheckIn[] | null>(null);

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

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the refresh bump: getCheckIns() reads the in-memory store, which changes outside React
  const all = useMemo(() => getCheckIns(), [version]);

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

  const freeNannies = useMemo(
    () => getNannyRoster().filter((n) => n.available),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-reads the nanny roster from the store whenever the check-ins are re-read
    [all, version],
  );

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

  const [checkInFor, setCheckInFor] = useState<CheckIn | null>(null);
  const [consentPhoto, setConsentPhoto] = useState<string | undefined>();
  const [consentMayOrderFood, setConsentMayOrderFood] = useState(true);
  const [consentAck, setConsentAck] = useState(false);

  const operatorName = operator?.name ?? 'Unknown';
  const operatorId = operator?.id ?? 'unknown';

  // ── Events check-in board (door check-in into today's events) ───────────────
  const { station } = useStation();
  const { branch } = useBranch();
  const today = todayISO();
  const [boardTab, setBoardTab] = useState<BoardTab>('dropoff');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventsVersion, setEventsVersion] = useState(0);
  const refreshEvents = () => setEventsVersion((v) => v + 1);

  const todaysEvents = useMemo(
    () => getEventsForDate(today, branch.id).filter((e) => (e.attendees?.length ?? 0) > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eventsVersion is the refresh bump: getEventsForDate() reads the in-memory events store, which changes outside React
    [eventsVersion, today, branch.id],
  );
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

  const dropOffPricing = useMemo(() => getDropOffPricing(), []);

  // Wristband + food reconciliation for the child being checked out.
  // Uses wristband.foodProvision as the authoritative source (it carries live
  // redeemedQty mutations from the F&B station, unlike checkIn.foodProvision).
  const checkOutWristband = useMemo(
    () =>
      checkOutFor
        ? getMockWristbands().find((w) => w.checkInId === checkOutFor.id)
        : undefined,
    [checkOutFor],
  );

  const checkOutReconciliation = useMemo(() => {
    if (!checkOutFor) return null;
    const fp = checkOutWristband?.foodProvision ?? checkOutFor.foodProvision;
    if (!fp || fp.mode === 'none') return null;
    const remaining = checkOutWristband?.creditBalanceTHB ?? 0;
    return computePrepaidFoodReconciliation(fp, remaining);
  }, [checkOutFor, checkOutWristband]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const selectTab = (t: Tab) => {
    setTab(t);
    if (t !== 'in_park') setDueOnly(false);
  };

  const openDetail = (family: CheckIn[]) => {
    setSelectedFamily(family);
    setView('detail');
  };

  const closeDetail = () => {
    setView('board');
    setSelectedFamily(null);
  };

  // Keep the selected family in sync with the latest data after mutations.
  const syncSelectedFamily = (updatedChild: CheckIn) => {
    if (!selectedFamily) return;
    const stillInFamily = selectedFamily.some((c) => c.id === updatedChild.id);
    if (!stillInFamily) return;
    // Re-read the full registration from the latest data.
    const latest = getCheckIns().filter((c) => c.registrationId === updatedChild.registrationId);
    if (latest.length > 0) {
      setSelectedFamily([...latest].sort((a, b) => a.childName.localeCompare(b.childName)));
    }
  };

  // ── Mutator handlers ───────────────────────────────────────────────────────

  const handleAssign = (nannyId: string) => {
    if (!assignFor) return;
    const res = assignNanny(assignFor.id, nannyId, { operatorName });
    if (res) {
      toast({
        title: 'Nanny assigned',
        description: `${res.assignedNannyName} is looking after ${res.childName}.`,
      });
      syncSelectedFamily(res);
      refresh();
    } else {
      toast({
        title: 'Could not assign',
        description: 'That nanny is no longer available.',
        variant: 'destructive',
      });
    }
    setAssignFor(null);
  };

  const handleCheckIn = (c: CheckIn) => {
    setConsentPhoto(undefined);
    setConsentMayOrderFood(c.mayOrderFood);
    setConsentAck(false);
    setCheckInFor(c);
  };

  const handleConsentDone = () => {
    const c = checkInFor;
    if (!c) return;
    if (consentMayOrderFood !== c.mayOrderFood) {
      updateCheckIn(
        c.id,
        {
          childName: c.childName,
          childAge: c.childAge,
          parentName: c.parentName,
          contactMethod: c.contactMethod,
          phone: c.phone,
          serviceType: c.serviceType,
          mayOrderFood: consentMayOrderFood,
          foodRestrictions: c.foodRestrictions,
          allergiesMedical: c.allergiesMedical,
          bookedDurationMinutes: c.bookedDurationMinutes,
          assignedNannyId: c.assignedNannyId,
        },
        { operatorName, operatorId },
      );
    }
    // Persist the photo captured during consent (child + parent together) to the
    // CheckIn record so it's available at pickup verification.
    if (consentPhoto) {
      applyCheckInPhotos(c.id, { childPhotoUrl: consentPhoto });
    }
    setCheckInFor(null);
    setDropOffHandoff(c.registrationId);
    navigate('/');
  };

  const handleManagePickups = (c: CheckIn) => setPickupsFor(c);

  const handleAddPickupFromPhoto = (
    _messageId: string,
    imageUrl: string,
    input: { name: string; relationship?: string; phone?: string },
  ) => {
    if (!messageCtx?.registrationId) return;
    addPickupFromChatPhoto(
      messageCtx.registrationId,
      { ...input, imageUrl },
      { operatorName, operatorId },
    );
    toast({ title: 'Pickup added', description: `${input.name} added to the authorized pickup list.` });
  };

  const handleConfirmCheckOut = (
    pickupPhotoUrl: string,
    collectorInput: {
      pickupId: string;
      name: string;
      relationship?: string;
      isDropperOff: boolean;
      source: AuthorizedPickupSource;
    },
  ) => {
    if (!checkOutFor) return;
    const policy = dropOffPricing.prepaidFoodRefundPolicy;
    const prepaidReconciliation =
      checkOutReconciliation && checkOutReconciliation.totalUnusedTHB > 0
        ? { unusedTHB: checkOutReconciliation.totalUnusedTHB, policy }
        : undefined;
    const res = checkOut(
      checkOutFor.id,
      { operatorName, operatorId },
      pickupPhotoUrl,
      prepaidReconciliation,
      collectorInput,
    );
    if (res) {
      const settlement = res.prepaidFoodSettlement;
      let description = `${res.childName} was released to their pickup.`;
      if (settlement && settlement.unusedTHB > 0) {
        if (settlement.settlementError === 'refund_no_sale') {
          toast({
            title: 'Manual refund required',
            description: `฿${settlement.unusedTHB} unused prepaid food could not be auto-refunded — the check-in sale was not found in Order History. Please issue a manual refund of ฿${settlement.unusedTHB} to the family.`,
            variant: 'destructive',
          });
        } else {
          description +=
            settlement.policy === 'refund'
              ? ` Prepaid food refund of ฿${settlement.unusedTHB} recorded.`
              : ` ฿${settlement.unusedTHB} prepaid food forfeited.`;
        }
      }
      toast({ title: 'Checked out', description });
      if (view === 'detail') closeDetail();
      setCheckOutFor(null);
      refresh();
    }
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

  const handleMarkArrived = (c: CheckIn) => {
    const res = markArrived(c.id, { operatorName });
    if (res) {
      toast({ title: 'Moved to Registered', description: `${res.childName} has arrived.` });
      syncSelectedFamily(res);
      refresh();
    }
  };

  const handleResend = (c: CheckIn) => {
    const res = resendWaConfirmation(c.id);
    if (res) {
      toast({
        title: 'Message resent',
        description: `Connection check resent to ${res.parentName} (${res.phone}).`,
      });
      syncSelectedFamily(res);
      refresh();
    } else {
      toast({
        title: 'No contact number',
        description: `Add a number for ${c.parentName} before resending.`,
        variant: 'destructive',
      });
    }
  };

  const handleSimulateConfirm = (c: CheckIn) => {
    const res = simulateWaConfirm(c.id);
    if (res) {
      toast({
        title: `${CHANNEL_LABEL[normalizeChannel(res.contactMethod)]} confirmed`,
        description: `${res.parentName} tapped "Confirm received" — channel is verified.`,
      });
      syncSelectedFamily(res);
      refresh();
    }
  };

  const handleMarkFailed = (c: CheckIn) => {
    const res = markWaConnectionFailed(c.id);
    if (res) {
      toast({
        title: 'Marked as unreachable',
        description: `Ask ${res.parentName} to update their number, then resend.`,
        variant: 'destructive',
      });
      syncSelectedFamily(res);
      refresh();
    }
  };

  const handleSaveAndResend = (c: CheckIn, newPhone: string, newChannel: ContactChannel) => {
    const edits: CheckInEdits = {
      childName: c.childName,
      childAge: c.childAge,
      parentName: c.parentName,
      contactMethod: newChannel,
      phone: newPhone,
      serviceType: c.serviceType,
      mayOrderFood: c.mayOrderFood,
      foodRestrictions: c.foodRestrictions,
      allergiesMedical: c.allergiesMedical,
      bookedDurationMinutes: c.bookedDurationMinutes,
      assignedNannyId: c.assignedNannyId,
    };
    const res = updateCheckIn(c.id, edits, { operatorName, operatorId });
    if (res) {
      toast({
        title: 'Number updated & re-sent',
        description: `Confirmation resent to ${res.parentName} (${res.phone}).`,
      });
      syncSelectedFamily(res);
      refresh();
    }
  };

  const handleSaveEdit = (edits: CheckInEdits) => {
    if (!editFor) return;
    const before = editFor.changeLog?.length ?? 0;
    const res = updateCheckIn(editFor.id, edits, { operatorName, operatorId });
    if (res) {
      const changed = (res.changeLog?.length ?? 0) - before;
      toast({
        title: changed > 0 ? 'Changes saved' : 'No changes',
        description:
          changed > 0
            ? `${changed} field${changed === 1 ? '' : 's'} updated for ${res.childName}.`
            : `Nothing changed for ${res.childName}.`,
      });
      syncSelectedFamily(res);
      refresh();
    } else {
      toast({ title: 'Could not save', variant: 'destructive' });
    }
    setEditFor(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* ── Board ── */}
      {view === 'board' && (
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
              <p className="text-sm">No children in this list.</p>
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
          onResend={handleResend}
          onSimulateConfirm={handleSimulateConfirm}
          onMarkFailed={handleMarkFailed}
          onSaveAndResend={handleSaveAndResend}
          onManagePickups={handleManagePickups}
        />
      )}

      {/* ── Check-out full-screen (above detail / board) ── */}
      {checkOutFor && (
        <MobileCheckOutView
          checkIn={checkOutFor}
          reconciliation={checkOutReconciliation}
          prepaidFoodPolicy={dropOffPricing.prepaidFoodRefundPolicy}
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
          onDone={handleConsentDone}
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
          onAssign={handleAssign}
        />
      )}

      {editFor && (
        <EditCheckInModal
          open={!!editFor}
          onOpenChange={(open) => !open && setEditFor(null)}
          checkIn={editFor}
          onSave={handleSaveEdit}
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
  onSelect,
}: {
  events: OtoEvent[];
  today: string;
  onSelect: (id: string) => void;
}) {
  if (events.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground px-4">
        <PartyPopper className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-semibold">No events today</p>
        <p className="text-xs mt-1 text-muted-foreground/70">
          Events with registered attendees appear here.
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
