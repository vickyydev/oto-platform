import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckInBookedModal, type BookedCheckInItem } from '../../../src/components/dropoff/CheckInBookedModal';
import type { CheckIn } from '../../../src/types';
import '../../../src/index.css';

// Only the fixture and callback are supplied. The dialog, Radix checkbox,
// browser events and photo/consent gates are the production components.
const query = new URLSearchParams(location.search);
const family: CheckIn[] = [{
  id: 'zz-test-child', registrationId: 'zz-test-family',
  childName: 'ZZ TEST child', childAge: 7, parentName: 'ZZ TEST guardian',
  contactMethod: 'whatsapp', phone: '', mayOrderFood: false,
  confirmationsAccepted: query.has('recorded'), photoOnFile: !query.has('missingPhoto'),
  serviceType: 'drop_off', status: 'registered', registeredAt: '2026-11-03T00:00:00Z',
}];
function Harness() {
  const [open, setOpen] = useState(true);
  const [calls, setCalls] = useState<BookedCheckInItem[][]>([]);
  return h('main', null,
    h('button', { onClick: () => setOpen(true) }, 'Open booked arrival'),
    h('output', { id: 'confirmed' }, JSON.stringify(calls)),
    h(CheckInBookedModal, {
      open, onOpenChange: setOpen, family, nannies: [], softMax: 4,
      onConfirm: items => setCalls(previous => [...previous, items]),
    }),
  );
}
createRoot(document.getElementById('root')!).render(h(Harness));
