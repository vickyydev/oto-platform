import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { findPaymentMethod } from '@/lib/payments';
import { isCreditSettlement, paymentStageText as label, type PaymentStageController } from '@/lib/usePaymentStage';
import { NumberKeypad } from './NumberKeypad';
import { PaymentExpiry, PaymentQr } from './PaymentQr';

const format = (amount: number) => (amount / 100).toFixed(2);
export function paymentSubmitLabel(stage: PaymentStageController): string {
  if (stage.busy) return label('pending');
  // S2-14a — credit expected to cover the order: the press needs no tender.
  if (stage.state.outstandingSatang === 0 || stage.creditCoversAll) return label('complete');
  const kind = stage.state.method ? findPaymentMethod(stage.state.method)?.kind : null;
  return label(kind === 'cash' ? 'recordCash' : kind === 'qr' ? 'startQr' : kind === 'card' ? 'startCard' : 'selectMethod');
}

export function PaymentTenderPanel({ stage, showSubmit = true }: { stage: PaymentStageController; showSubmit?: boolean }) {
  const { state } = stage;
  const kind = state.method ? findPaymentMethod(state.method)?.kind : null;
  const [field, setField] = useState<'amount' | 'cash' | null>(null);
  const [text, setText] = useState('');
  const [approvalCode, setApprovalCode] = useState('');
  const [tid, setTid] = useState('');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    setField(null); setApprovalCode(''); setTid(''); setNote(''); setChecked(false);
  }, [state.saleId, state.attempt?.id, state.outstandingSatang]);
  const enter = (next: string) => {
    if (!/^\d*(\.\d{0,2})?$/.test(next)) return;
    const [whole = '', fraction = ''] = next.split('.');
    const amount = Number(whole || 0) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount)) return;
    setText(next);
    if (field === 'cash') stage.setTenderedSatang(amount); else stage.setAmountSatang(amount);
  };
  const chooseField = (next: 'amount' | 'cash') => {
    setField(next); setText('');
    if (next === 'cash') stage.setTenderedSatang(0); else stage.setAmountSatang(0);
  };
  return <div className="mt-6 space-y-4" data-testid="payment-stage">
    {!stage.online && <p role="alert" className="rounded-xl border border-amber-500/40 p-4">{label('reconnect')}</p>}
    {state.settlements.length > 0 && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="font-semibold">{label('recorded')}</p>
      {state.settlements.map((part) => <p key={part.attemptId} className="text-sm">{isCreditSettlement(part) ? 'Credit' : findPaymentMethod(part.method)?.label ?? part.method} · ฿{format(part.amountSatang)}</p>)}
      <p className="mt-2 font-bold">{label('balance')} ฿{format(state.outstandingSatang)}</p>
    </div>}
    {state.method && !stage.locked && state.phase !== 'manual' && state.outstandingSatang > 0 && <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="payment-part-amount">{label('amount')}</Label>
          <Input id="payment-part-amount" inputMode="decimal" value={field === 'amount' ? text : format(state.amountSatang)}
            onFocus={() => chooseField('amount')} onChange={(event) => enter(event.target.value)} />
        </div>
        {kind === 'cash' && <div><Label htmlFor="payment-cash-received">{label('cashReceived')}</Label>
          <Input id="payment-cash-received" inputMode="decimal" value={field === 'cash' ? text : format(state.tenderedSatang)}
            onFocus={() => chooseField('cash')} onChange={(event) => enter(event.target.value)} />
        </div>}
      </div>
      {kind === 'cash' && <p className="text-lg font-bold">{label('change')} ฿{format(Math.max(0, state.tenderedSatang - state.amountSatang))}</p>}
      {field && <><NumberKeypad value={text} onChange={enter} maxLength={10} />
        <Button type="button" variant="outline" className="w-full h-12" disabled={text.includes('.')} onClick={() => enter(`${text || '0'}.`)}>{label('decimalPoint')}</Button></>}
    </div>}
    {state.attempt && <div className="rounded-xl border p-4" data-testid="payment-attempt-status">
      <p className="font-bold">{label(`status.${state.attempt.status}`)}</p>
      <p className="text-sm text-muted-foreground">{state.attempt.provider} · ฿{format(state.attempt.amountSatang)}</p>
      {state.attempt.offline && <p className="mt-2 font-semibold">{label('offlineRecorded')}</p>}
    </div>}
    {(state.qr.qrPayload || state.qr.qrImageUrl) && <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-center">
      <PaymentQr payload={state.qr.qrPayload} imageUrl={state.qr.qrImageUrl} className="w-48 h-48 mx-auto rounded-lg" />
      <p className="mt-2 font-bold">฿{format(state.attempt?.amountSatang ?? state.amountSatang)} · <PaymentExpiry expiresAt={state.qr.expiresAt} /></p>
      <p className="text-sm text-muted-foreground">{label('timeExpired')}</p>
    </div>}
    {state.phase === 'manual' && <div className="rounded-xl border p-4 space-y-3">
      <p className="font-bold">{label('manualTitle')}</p>
      <Label htmlFor="payment-approval">{label('approval')}</Label><Input id="payment-approval" value={approvalCode} onChange={(event) => setApprovalCode(event.target.value)} maxLength={12} />
      <Label htmlFor="payment-tid">{label('tid')}</Label><Input id="payment-tid" value={tid} onChange={(event) => setTid(event.target.value)} maxLength={32} />
      <Button className="w-full h-14" disabled={!approvalCode.trim() || !tid.trim() || stage.busy || !stage.online}
        onClick={() => { void stage.manual({ approvalCode, tid }); }}>{label('manualRecord')}</Button>
    </div>}
    {state.error && <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" role="alert">{state.error}</div>}
    <div className="flex flex-wrap gap-3">
      {state.retryable && <Button variant="outline" disabled={stage.busy || !stage.online} onClick={() => { void stage.retry(); }}>{label('checkAgain')}</Button>}
      {stage.canInquire && <Button variant="outline" onClick={() => { void stage.inquire(); }}>{label('askTerminal')}</Button>}
      {stage.canConfirm && <AlertDialog><AlertDialogTrigger asChild><Button variant="outline">{label('review')}</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{label('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{label('confirmDescription')}</AlertDialogDescription></AlertDialogHeader>
          <Label htmlFor="payment-confirm-note">{label('checkNote')}</Label><Input id="payment-confirm-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
          <label className="flex gap-2 items-center"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />{label('checkBox')}</label>
          <AlertDialogFooter><AlertDialogCancel>{label('back')}</AlertDialogCancel>
            <AlertDialogAction disabled={!checked || !note.trim()} onClick={() => { void stage.confirm(false, { note }); }}>{label('noMoney')}</AlertDialogAction>
            <AlertDialogAction disabled={!checked || !note.trim()} onClick={() => { void stage.confirm(true, { note }); }}>{label('moneyTaken')}</AlertDialogAction>
          </AlertDialogFooter></AlertDialogContent></AlertDialog>}
    </div>
    {showSubmit && <Button className="w-full h-16 text-xl font-bold" disabled={!stage.canSubmit} onClick={() => { void stage.submit(); }}>{paymentSubmitLabel(stage)}</Button>}
  </div>;
}
