import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ContactChannel, WaMessage, WaTemplate } from '@/types';
import {
  getThread,
  getMessageTemplates,
  sendWhatsAppMessage,
  updateMessageStatus,
  injectInboundPhotoMessage,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { CHANNEL_COLOR, CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import { Check, CheckCheck, Send, Info, MessageCircle, ImagePlus, ShieldCheck, X } from 'lucide-react';

// The recipient + the context used to resolve template placeholders.
export interface MessagingContext {
  parentName: string;
  phone: string;
  childName?: string;
  // The time a template's {time} placeholder should resolve to (e.g. booked
  // end time for drop-off, party start time for parties).
  time?: string;
  /** When set, enables "Add as authorized pickup" on inbound photo messages. */
  registrationId?: string;
  /** Contact channel for this thread; defaults to 'whatsapp' when omitted. */
  channel?: ContactChannel;
}

interface MessagingPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: MessagingContext | null;
  // Which template group to surface first for this surface.
  category: WaTemplate['category'];
  /**
   * Called when staff promote a chat photo to an authorized pickup.
   * Only invoked when context.registrationId is set.
   */
  onAddPickupFromPhoto?: (
    messageId: string,
    imageUrl: string,
    input: { name: string; relationship?: string; phone?: string },
  ) => void;
}

// This is the POS-side of messaging; in production it shares the WhatsApp
// Business inbox with the wider Oto app.

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Fill {placeholder} tokens from the context. Unknown tokens are left as-is so
// staff can see (and complete) them before sending.
function resolveTemplate(body: string, ctx: MessagingContext): string {
  return body
    .replaceAll('{parentName}', ctx.parentName || '')
    .replaceAll('{childName}', ctx.childName || '')
    .replaceAll('{time}', ctx.time || '');
}

// Outbound status ticks: sent ✓ / delivered ✓✓ / read ✓✓ (blue).
function StatusTicks({ status }: { status: WaMessage['status'] }) {
  if (status === 'sending') return <span className="text-[10px] opacity-70">Sending…</span>;
  if (status === 'failed') return <span className="text-[10px] text-red-300">Failed</span>;
  if (status === 'sent') return <Check className="w-3.5 h-3.5 opacity-70" />;
  if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 opacity-70" />;
  // read
  return <CheckCheck className="w-3.5 h-3.5 text-sky-300" />;
}

interface PromoteFormState {
  messageId: string;
  imageUrl: string;
  name: string;
  relationship: string;
  phone: string;
}

export function MessagingPanel({
  open,
  onOpenChange,
  context,
  category,
  onAddPickupFromPhoto,
}: MessagingPanelProps) {
  const { operator } = useOperator();
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [activeTemplateId, setActiveTemplateId] = useState<string | undefined>();
  const [promoteForm, setPromoteForm] = useState<PromoteFormState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pending status-animation timers, cleared on unmount so a closed/navigated
  // panel never writes stale state.
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    },
    [],
  );

  const templates = useMemo(() => getMessageTemplates(), []);
  // Surface this surface's templates first, then the rest.
  const orderedTemplates = useMemo(
    () => [
      ...templates.filter((t) => t.category === category),
      ...templates.filter((t) => t.category !== category),
    ],
    [templates, category],
  );

  // Load the recipient's thread whenever the panel opens for a recipient.
  useEffect(() => {
    if (open && context) {
      setMessages([...getThread(context.phone)]);
      setDraft('');
      setActiveTemplateId(undefined);
      setPromoteForm(null);
    }
  }, [open, context]);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // A conversation window is "open" if the parent replied within 24h — only then
  // is free-text allowed; otherwise WhatsApp requires an approved template.
  const windowOpen = useMemo(() => {
    const lastInbound = [...messages]
      .reverse()
      .find((m) => m.direction === 'inbound');
    if (!lastInbound) return false;
    return Date.now() - new Date(lastInbound.at).getTime() < 24 * 60 * 60_000;
  }, [messages]);

  if (!context) return null;

  const pickTemplate = (tpl: WaTemplate) => {
    setActiveTemplateId(tpl.id);
    setDraft(resolveTemplate(tpl.body, context));
  };

  // Animate an outbound message through its delivery states, keeping the mock
  // store in sync as it goes.
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
    const sent = sendWhatsAppMessage({
      recipientPhone: context.phone,
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

  const handleSimPhoto = () => {
    const msg = injectInboundPhotoMessage(context.phone);
    setMessages((prev) => [...prev, msg]);
  };

  const handleStartPromote = (msg: WaMessage) => {
    if (!msg.imageUrl) return;
    setPromoteForm({
      messageId: msg.id,
      imageUrl: msg.imageUrl,
      name: '',
      relationship: '',
      phone: '',
    });
  };

  const handleConfirmPromote = () => {
    if (!promoteForm || !promoteForm.name.trim()) return;
    onAddPickupFromPhoto?.(promoteForm.messageId, promoteForm.imageUrl, {
      name: promoteForm.name,
      relationship: promoteForm.relationship || undefined,
      phone: promoteForm.phone || undefined,
    });
    setPromoteForm(null);
  };

  const canPromote = !!context.registrationId && !!onAddPickupFromPhoto;
  const channelLabel = CHANNEL_LABEL[normalizeChannel(context.channel)];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md flex flex-col gap-0 p-0"
      >
        <SheetHeader className="shrink-0 px-5 pt-5 pb-4 border-b text-left space-y-1">
          <SheetTitle className="flex items-center gap-2">
            <span
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${CHANNEL_COLOR[normalizeChannel(context.channel)].bg} ${CHANNEL_COLOR[normalizeChannel(context.channel)].text}`}
            >
              <MessageCircle className="w-4 h-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate">{context.parentName}</span>
              <span className="block text-xs font-normal font-mono text-muted-foreground">
                {context.phone}
              </span>
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            In-app {channelLabel} conversation with {context.parentName}
          </SheetDescription>
        </SheetHeader>

        {/* Conversation thread */}
        <ScrollArea className="flex-1 min-h-0">
          <div ref={scrollRef} className="px-4 py-4 flex flex-col gap-2">
            {messages.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-10">
                No messages yet. Pick a template to start the conversation.
              </div>
            )}
            {messages.map((m) => {
              const outbound = m.direction === 'outbound';
              const isPhotoMsg = !!m.imageUrl && !outbound;
              return (
                <div key={m.id} className={`flex flex-col ${outbound ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                      outbound
                        ? 'bg-emerald-600 text-white rounded-br-sm'
                        : 'bg-muted text-foreground rounded-bl-sm'
                    }`}
                  >
                    {/* Inline photo for inbound photo messages */}
                    {isPhotoMsg && (
                      <div className="mb-2 rounded-xl overflow-hidden">
                        <img
                          src={m.imageUrl}
                          alt="Parent photo"
                          className="w-full max-h-48 object-cover"
                        />
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <div
                      className={`flex items-center gap-1 mt-1 text-[10px] ${
                        outbound ? 'justify-end text-foreground/80' : 'text-muted-foreground'
                      }`}
                    >
                      <span>{fmtTime(m.at)}</span>
                      {outbound && <StatusTicks status={m.status} />}
                    </div>
                  </div>

                  {/* "Add as authorized pickup" — only on inbound photo messages when canPromote */}
                  {isPhotoMsg && canPromote && promoteForm?.messageId !== m.id && (
                    <button
                      type="button"
                      onClick={() => handleStartPromote(m)}
                      className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-sky-400 hover:text-sky-300 transition-colors px-1"
                    >
                      <ShieldCheck className="w-3 h-3" />
                      Add as authorized pickup
                    </button>
                  )}

                  {/* Promote form inline below photo message */}
                  {isPhotoMsg && promoteForm?.messageId === m.id && (
                    <div className="mt-2 w-[85%] rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 space-y-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-sky-400 flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" />
                          Add as authorized pickup
                        </span>
                        <button
                          type="button"
                          onClick={() => setPromoteForm(null)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <Input
                        value={promoteForm.name}
                        onChange={(e) => setPromoteForm((f) => f ? { ...f, name: e.target.value } : f)}
                        placeholder="Name (required)"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={promoteForm.relationship}
                        onChange={(e) => setPromoteForm((f) => f ? { ...f, relationship: e.target.value } : f)}
                        placeholder="Relationship (optional)"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={promoteForm.phone}
                        onChange={(e) => setPromoteForm((f) => f ? { ...f, phone: e.target.value } : f)}
                        placeholder="Phone (optional)"
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        className="w-full h-8 text-xs gap-1"
                        disabled={!promoteForm.name.trim()}
                        onClick={handleConfirmPromote}
                      >
                        <ShieldCheck className="w-3 h-3" />
                        Save as authorized pickup
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {/* Composer */}
        <div className="shrink-0 border-t p-4 space-y-3">
          {/* Template picker + sim photo button */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {orderedTemplates.map((tpl) => (
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
            {/* Simulate inbound photo — dev/demo only */}
            <button
              type="button"
              onClick={handleSimPhoto}
              title="Simulate inbound photo from parent (demo)"
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold border border-dashed border-sky-500/40 text-sky-400 hover:text-sky-300 transition-colors flex items-center gap-1"
            >
              <ImagePlus className="w-3 h-3" />
              Sim photo
            </button>
          </div>

          {!windowOpen && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 text-amber-300 px-3 py-2 text-xs">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              No open chat window — outside the 24h reply window, {channelLabel} only
              delivers approved templates. Pick one above.
            </div>
          )}

          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              rows={2}
              className="resize-none min-h-[48px]"
            />
            <Button
              type="button"
              size="lg"
              className="h-12 px-4 shrink-0 gap-2"
              disabled={!draft.trim()}
              onClick={handleSend}
            >
              <Send className="w-4 h-4" />
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
