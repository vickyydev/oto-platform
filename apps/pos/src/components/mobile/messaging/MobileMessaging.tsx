import { useEffect, useMemo, useRef, useState } from 'react';
import { WaMessage, WaTemplate } from '@/types';
import {
  getThread,
  getMessageTemplates,
  sendWhatsAppMessage,
  updateMessageStatus,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { ArrowLeft, Info, MessageCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CHANNEL_COLOR, CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import {
  Contact,
  ConversationRow,
  StatusTicks,
  deriveContacts,
  fmtTime,
  initials,
  resolveTemplate,
  sortContactsByRecency,
} from './messagingUtils';

// ---------------------------------------------------------------------------
// Full-screen thread view
// ---------------------------------------------------------------------------
interface ThreadViewProps {
  contact: Contact;
  onBack: () => void;
}

function ThreadView({ contact, onBack }: ThreadViewProps) {
  const { operator } = useOperator();
  const [messages, setMessages] = useState<WaMessage[]>(() => [
    ...getThread(contact.phone),
  ]);
  const [draft, setDraft] = useState('');
  const [activeTemplateId, setActiveTemplateId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);

  const templates = useMemo<WaTemplate[]>(() => getMessageTemplates(), []);

  // Clear pending status-animation timers on unmount.
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    },
    [],
  );

  // Pin scroll to the bottom whenever messages update.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 24h free-text window: open when the parent replied within the last 24 hours.
  const windowOpen = useMemo(() => {
    const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
    if (!lastInbound) return false;
    return Date.now() - new Date(lastInbound.at).getTime() < 24 * 60 * 60_000;
  }, [messages]);

  const pickTemplate = (tpl: WaTemplate) => {
    setActiveTemplateId(tpl.id);
    setDraft(resolveTemplate(tpl.body, contact));
  };

  const animateStatus = (id: string) => {
    const steps: { status: WaMessage['status']; delay: number }[] = [
      { status: 'sent', delay: 500 },
      { status: 'delivered', delay: 1400 },
      { status: 'read', delay: 2800 },
    ];
    for (const step of steps) {
      const timer = window.setTimeout(() => {
        updateMessageStatus(id, step.status);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, status: step.status } : m)),
        );
      }, step.delay);
      timersRef.current.push(timer);
    }
  };

  const handleSend = () => {
    const body = draft.trim();
    if (!body) return;
    // 24h gate: free-text is only allowed inside an open conversation window.
    // Templates are always allowed. Enforce at send time, not only via UI state.
    if (!windowOpen && !activeTemplateId) return;
    const sent = sendWhatsAppMessage({
      recipientPhone: contact.phone,
      body,
      templateId: activeTemplateId,
      sentBy: operator?.name,
      sentById: operator?.id,
    });
    setMessages((prev) => [...prev, sent]);
    setDraft('');
    setActiveTemplateId(undefined);
    animateStatus(sent.id);
  };

  const canSendFreeText = windowOpen || !!activeTemplateId;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Thread header */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-3 border-b bg-card/30">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span
          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${CHANNEL_COLOR[normalizeChannel(contact.channel)].bg} ${CHANNEL_COLOR[normalizeChannel(contact.channel)].text}`}
        >
          {initials(contact.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm truncate">{contact.name}</p>
          <p className="text-xs font-mono text-muted-foreground truncate">{contact.phone}</p>
        </div>
      </div>

      {/* Message bubbles */}
      <ScrollArea className="flex-1 min-h-0">
        <div ref={scrollRef} className="px-4 py-4 flex flex-col gap-2 max-w-full">
          {messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-10">
              No messages yet. Pick a template below to start the conversation.
            </div>
          )}
          {messages.map((m) => {
            const outbound = m.direction === 'outbound';
            return (
              <div
                key={m.id}
                className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                  outbound
                    ? 'self-end bg-emerald-600 text-white rounded-br-sm'
                    : 'self-start bg-muted text-foreground rounded-bl-sm'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <div
                  className={`flex items-center gap-1 mt-1 text-[10px] ${
                    outbound ? 'justify-end text-white/80' : 'text-muted-foreground'
                  }`}
                >
                  <span>{fmtTime(m.at)}</span>
                  {outbound && <StatusTicks status={m.status} />}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Compose area */}
      <div className="shrink-0 border-t p-4 space-y-3 bg-background">
        {/* Template pills — always available regardless of window state */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => pickTemplate(tpl)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors ${
                activeTemplateId === tpl.id
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              {tpl.name}
            </button>
          ))}
        </div>

        {/* 24h window closed banner */}
        {!windowOpen && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 text-amber-300 px-3 py-2 text-xs">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            No open chat window — outside the 24h reply window, {CHANNEL_LABEL[normalizeChannel(contact.channel)]} only
            delivers approved templates. Pick one above.
          </div>
        )}

        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              canSendFreeText
                ? 'Type a message…'
                : 'Select a template to message outside the 24h window'
            }
            rows={2}
            disabled={!canSendFreeText}
            className="resize-none min-h-[48px]"
          />
          <Button
            type="button"
            size="lg"
            className="h-12 px-4 shrink-0 gap-2"
            disabled={!draft.trim() || !canSendFreeText}
            onClick={handleSend}
          >
            <Send className="w-4 h-4" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root surface — conversation list; tapping a contact opens its thread view.
// Contacts are derived from operational data (today's parties + all check-ins)
// so the list stays in sync with whoever staff have been managing today.
// ---------------------------------------------------------------------------
export function MobileMessaging() {
  const [selected, setSelected] = useState<Contact | null>(null);

  // Derive contacts once on mount. The list only grows intra-session when staff
  // check in new children or add parties — a re-mount picks up changes naturally.
  const contacts = useMemo(() => sortContactsByRecency(deriveContacts()), []);

  if (selected) {
    return <ThreadView contact={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Surface header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b">
        <span className="w-8 h-8 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
          <MessageCircle className="w-4 h-4" />
        </span>
        <h1 className="font-bold text-base">Messages</h1>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div>
          {contacts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground text-sm gap-2 px-8 text-center">
              <MessageCircle className="w-10 h-10 opacity-20" />
              <p>No contacts yet. Check-ins and party bookings will appear here.</p>
            </div>
          )}
          {contacts.map((contact) => (
            <ConversationRow
              key={contact.phone}
              contact={contact}
              onSelect={() => setSelected(contact)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
