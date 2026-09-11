import { useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { StationHeader } from '@/components/shared/StationHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MessagingPanel,
  MessagingContext,
} from '@/components/shared/MessagingPanel';
import {
  Contact,
  ConversationRow,
  deriveContacts,
  sortContactsByRecency,
} from '@/components/mobile/messaging/messagingUtils';

// iPad Messages inbox. Surfaces the same contactable parents (WhatsApp /
// Telegram / LINE) as the mobile Messages tab (today's parties + drop-off
// check-ins), and opens the shared MessagingPanel sheet for the selected
// conversation so the thread / composer / template logic lives in exactly
// one place.
export default function Messages() {
  const [selected, setSelected] = useState<Contact | null>(null);
  const [open, setOpen] = useState(false);

  const contacts = useMemo(() => sortContactsByRecency(deriveContacts()), []);

  const context: MessagingContext | null = selected
    ? {
        parentName: selected.name,
        phone: selected.phone,
        childName: selected.childName,
        channel: selected.channel,
      }
    : null;

  const openContact = (contact: Contact) => {
    setSelected(contact);
    setOpen(true);
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      <StationHeader active="messages" />

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="mx-auto h-full max-w-2xl flex flex-col">
          <div className="shrink-0 flex items-center gap-3 px-6 py-4 border-b">
            <span className="w-9 h-9 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
              <MessageCircle className="w-4 h-4" />
            </span>
            <div>
              <h1 className="font-bold text-lg leading-tight">Messages</h1>
              <p className="text-xs text-muted-foreground">
                In-app conversations with parents (WhatsApp, Telegram)
              </p>
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            {contacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-muted-foreground text-sm gap-2 px-8 text-center">
                <MessageCircle className="w-12 h-12 opacity-20" />
                <p>No contacts yet. Check-ins and party bookings will appear here.</p>
              </div>
            ) : (
              <div>
                {contacts.map((contact) => (
                  <ConversationRow
                    key={contact.phone}
                    contact={contact}
                    onSelect={() => openContact(contact)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <MessagingPanel
        open={open}
        onOpenChange={setOpen}
        context={context}
        category="general"
      />
    </div>
  );
}
