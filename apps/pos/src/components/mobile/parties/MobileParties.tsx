import { useEffect, useRef, useState } from 'react';
import { newId } from '@oto/shared';
import { OtoEvent, PartyBooking, PartyPaymentMethod } from '@/types';
import {
  getEventById,
  checkInEventAttendee,
  checkOutEventAttendee,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { EVENT_WRITE_PENDING, eventsToday, useEventsForDate } from '@/api/events';
import {
  chargePartyOnPlatform,
  partyWriteBlocker,
  payPartyOnPlatform,
  type PartyWriteIds,
  type PartyWriteOutcome,
} from '@/api/parties';
import { computePartyOutstanding } from '@/lib/party';
import { eventBraceletPrintJobs, dispatchPrintJobs } from '@/lib/printRouting';
import { toast } from '@/hooks/use-toast';
import { MobileEventsList } from './MobileEventsList';
import { MobilePartyDetail } from './MobilePartyDetail';
import { MobileEventAttendeeList } from './MobileEventAttendeeList';
import { MobilePartyPayment } from './MobilePartyPayment';
import { MobilePartyFnb } from './MobilePartyFnb';

type Step = 'list' | 'detail' | 'payment' | 'fnb';

function findEvent(id: string | null, events: readonly OtoEvent[]): OtoEvent | null {
  if (!id) return null;
  return events.find((e) => e.id === id) ?? null;
}

/**
 * S2-20 E1 — the events are the OTO App's now, which the prototype's in-memory
 * mutators cannot find: a check-in, a reprint, a payment and a charge are
 * written on the platform by E2 to E4, and until then say so.
 */
function writePending(eventId: string): boolean {
  if (getEventById(eventId)) return false;
  toast(EVENT_WRITE_PENDING);
  return true;
}

/**
 * Mobile Events surface (portrait).
 *
 * Step machine:
 *   list → detail (party)  → payment (HandToCustomer bill review → collect → done)
 *                           → fnb (menu grid + cart → charge)
 *        → detail (camp/event) — read-only attendee list, no billing actions
 *
 * The events are read from the platform (`GET /events`, S2-20 E1), and a
 * party's payment and F&B charge are written there (S2-20 E4,
 * `api/parties.ts`); the check-in writes still wait for E3. Version counter
 * triggers re-reads so the UI always reflects the latest state after a
 * mutation.
 */
// The branch's trading day, not the UTC date (plan §4).
const todayISO = () => eventsToday();

export function MobileParties() {
  const { operator } = useOperator();
  const { station } = useStation();
  const { branch } = useBranch();
  const today = todayISO();

  const [step, setStep] = useState<Step>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [version, setVersion] = useState(0);

  const bump = () => setVersion((v) => v + 1);

  // The selected day's events, where the event on screen is found again after each bump.
  const { events: dayEvents } = useEventsForDate(branch.id, selectedDate || today, version);
  // S2-20 E4 — the party as the platform last answered a write with it, until
  // the day's re-read brings it back: the "Payment recorded" screen shows the
  // balance the payment left, not the one before it.
  const [fresh, setFresh] = useState<PartyBooking | null>(null);
  useEffect(() => setFresh(null), [dayEvents]);
  const selectedEvent =
    fresh && fresh.id === selectedId ? (fresh as unknown as OtoEvent) : findEvent(selectedId, dayEvents);
  const isPartyEvent = selectedEvent?.type === 'party';
  // Check-in is scoped to today's session only (matches the iPad Events tab).
  // Browsing another date shows the roster read-only.
  const canCheckIn = selectedDate === today;

  const handleSelectEvent = (id: string, date: string) => {
    setSelectedId(id);
    setSelectedDate(date);
    setStep('detail');
  };

  const handleBackToList = () => {
    setStep('list');
    setSelectedId(null);
  };

  const handleBackToDetail = () => {
    bump();
    setStep('detail');
  };

  /**
   * S2-20 E4 — the party tab on the platform. The ids of a press are minted
   * when it is first sent and kept for a retry of it; a definite answer
   * clears them.
   */
  const ids = useRef<Partial<Record<'payment' | 'fnb', PartyWriteIds>>>({});
  const idsFor = (key: 'payment' | 'fnb') => (ids.current[key] ??= { id: newId(), actionId: newId() });
  const settled = (key: 'payment' | 'fnb', outcome: PartyWriteOutcome, failure: string): boolean => {
    if (outcome.ok || !outcome.retryable) ids.current[key] = undefined;
    bump();
    if (!outcome.ok) {
      toast({ title: failure, description: outcome.message, variant: 'destructive' });
      return false;
    }
    setFresh(outcome.party);
    return true;
  };
  const blockerOf = (needsStation = false) =>
    partyWriteBlocker({ branchSlug: branch.id, stationId: station?.stationId, needsStation });

  const handleTakePayment = async (amount: number, method: PartyPaymentMethod): Promise<boolean> => {
    if (!operator || !selectedEvent || selectedEvent.type !== 'party') return false;
    const blocked = blockerOf(true);
    if (blocked || !station) {
      if (blocked) toast(blocked);
      return false;
    }
    const party = selectedEvent as unknown as PartyBooking;
    const outcome = await payPartyOnPlatform({
      party,
      amount,
      method,
      outstanding: computePartyOutstanding(party),
      stationId: station.stationId,
      ids: idsFor('payment'),
    });
    return settled('payment', outcome, 'Payment not recorded');
  };

  const handleEventCheckIn = (eventId: string, attendeeId: string) => {
    if (!operator) return;
    if (writePending(eventId)) return;
    const result = checkInEventAttendee(eventId, attendeeId, today, {
      operatorName: operator.name,
      operatorId: operator.id,
    });
    if (!result) {
      toast({ title: 'Already checked in', description: 'This child is already checked in for today.' });
      bump();
      return;
    }
    const ev = getEventById(eventId);
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
    bump();
  };

  const handleEventReprint = (eventId: string, attendeeId: string) => {
    if (writePending(eventId)) return;
    const ev = getEventById(eventId);
    const attendee = ev?.attendees?.find((a) => a.id === attendeeId);
    const record = attendee?.checkinByDate?.[today];
    if (!ev || !attendee || !record) return;
    if (!station) {
      toast({
        title: 'No printer configured',
        description: 'Set up this station before reprinting a band.',
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
      title: 'Reprinting band',
      description: `${attendee.name} — band ${record.wristbandCode}${record.parentWristbandCode ? ` · parent ${record.parentWristbandCode}` : ''}`,
    });
  };

  const handleEventCheckOut = (eventId: string, attendeeId: string) => {
    if (!operator) return;
    if (writePending(eventId)) return;
    const att = checkOutEventAttendee(eventId, attendeeId, today, {
      operatorName: operator.name,
      operatorId: operator.id,
    });
    if (att) {
      toast({ title: 'Checked out', description: `${att.name} has been checked out.` });
    }
    bump();
  };

  const handleChargeExtra = async (
    items: { name: string; qty: number; lineTotal: number }[],
    total: number,
  ): Promise<boolean> => {
    if (!operator || !selectedEvent || selectedEvent.type !== 'party') return false;
    const blocked = blockerOf();
    if (blocked) {
      toast(blocked);
      return false;
    }
    const outcome = await chargePartyOnPlatform({
      party: selectedEvent as unknown as PartyBooking,
      kind: 'fnb',
      items,
      total,
      stationId: station?.stationId,
      ids: idsFor('fnb'),
    });
    if (!settled('fnb', outcome, 'Not charged to the party')) return false;
    setStep('detail');
    return true;
  };

  if (step === 'list' || !selectedEvent) {
    return (
      <div className="h-full overflow-hidden">
        <MobileEventsList version={version} onSelectEvent={handleSelectEvent} />
      </div>
    );
  }

  if (step === 'detail') {
    if (isPartyEvent) {
      return (
        <div className="h-full overflow-hidden">
          <MobilePartyDetail
            party={selectedEvent as unknown as PartyBooking}
            onBack={handleBackToList}
            // S2-20 E4: what the till can know is asked before the payment or
            // F&B flow opens, so the guest is never shown a "thank you" for
            // money nothing recorded.
            onTakePayment={() => {
              const blocked = blockerOf(true);
              if (blocked) toast(blocked);
              else setStep('payment');
            }}
            onAddFnb={() => {
              const blocked = blockerOf();
              if (blocked) toast(blocked);
              else setStep('fnb');
            }}
          />
        </div>
      );
    }
    return (
      <div className="h-full overflow-hidden">
        <MobileEventAttendeeList
          event={selectedEvent}
          onBack={handleBackToList}
          checkInDate={canCheckIn ? today : undefined}
          onCheckIn={
            canCheckIn ? (attendeeId) => handleEventCheckIn(selectedEvent.id, attendeeId) : undefined
          }
          onCheckOut={
            canCheckIn ? (attendeeId) => handleEventCheckOut(selectedEvent.id, attendeeId) : undefined
          }
          onReprint={
            canCheckIn ? (attendeeId) => handleEventReprint(selectedEvent.id, attendeeId) : undefined
          }
          refreshKey={version}
        />
      </div>
    );
  }

  if (!isPartyEvent) {
    return (
      <div className="h-full overflow-hidden">
        <MobileEventsList version={version} onSelectEvent={handleSelectEvent} />
      </div>
    );
  }

  if (step === 'payment') {
    return (
      <div className="h-full overflow-hidden">
        <MobilePartyPayment
          party={selectedEvent as unknown as PartyBooking}
          operatorName={operator?.name ?? ''}
          onConfirm={handleTakePayment}
          onBack={handleBackToDetail}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <MobilePartyFnb
        party={selectedEvent as unknown as PartyBooking}
        operatorName={operator?.name ?? ''}
        onCharge={handleChargeExtra}
        onBack={handleBackToDetail}
      />
    </div>
  );
}
