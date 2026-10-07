import { useState } from 'react';
import { OtoEvent, PartyBooking, PartyPaymentMethod } from '@/types';
import {
  getEventById,
  addPartyPayment,
  addPartyExtraCharge,
  checkInEventAttendee,
  checkOutEventAttendee,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { EVENT_WRITE_PENDING, eventsToday, useEventsForDate } from '@/api/events';
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
 * The events are read from the platform (`GET /events`, S2-20 E1); the writes
 * still go through the mockApi mutators (addPartyPayment, addPartyExtraCharge)
 * until E2 to E4 put them on the platform. Version counter triggers re-reads
 * so the UI always reflects the latest state after a mutation.
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
  const selectedEvent = findEvent(selectedId, dayEvents);
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

  const handleTakePayment = (amount: number, method: PartyPaymentMethod) => {
    if (!operator || !selectedId) return;
    if (writePending(selectedId)) return;
    addPartyPayment(selectedId, {
      amount,
      method,
      takenBy: operator.name,
      takenById: operator.id,
    });
    bump();
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

  const handleChargeExtra = (
    items: { name: string; qty: number; lineTotal: number }[],
    total: number,
  ) => {
    if (!operator || !selectedId) return;
    if (writePending(selectedId)) return;
    addPartyExtraCharge(selectedId, {
      kind: 'fnb',
      items,
      total,
      chargedBy: operator.name,
      chargedById: operator.id,
    });
    bump();
    setStep('detail');
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
            // S2-20 E1: refused before the payment or F&B flow opens, so the
            // guest is never shown a "thank you" for money nothing recorded.
            onTakePayment={() => {
              if (!writePending(selectedEvent.id)) setStep('payment');
            }}
            onAddFnb={() => {
              if (!writePending(selectedEvent.id)) setStep('fnb');
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
