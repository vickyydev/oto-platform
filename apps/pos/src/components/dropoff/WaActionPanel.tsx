/**
 * Shared WhatsApp action panel — rendered for pending / failed / unverified
 * check-ins on all three surfaces (iPad CheckInCard, iPad FamilyCheckInCard,
 * and mobile MobileChildDetail).
 *
 * For pending and failed states the panel also shows an inline phone editor so
 * staff can correct the parent's number and re-send without opening the full
 * EditCheckInModal. The existing Resend / Sim-confirm / Couldn't-reach buttons
 * are preserved unchanged.
 *
 * NOTE: real WhatsApp sending is the backend's WhatsApp Business webhook job;
 * all send/confirm behaviour here is mocked.
 */

import { useState, useEffect } from 'react';
import { CheckIn, ContactChannel, WaConnectionStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import {
  RefreshCw,
  Smartphone,
  WifiOff,
  CheckCircle2,
  PhoneOff,
  Send,
} from 'lucide-react';

interface WaActionPanelProps {
  checkIn: CheckIn;
  waStatus: WaConnectionStatus;
  onResend: (c: CheckIn) => void;
  onSimulateConfirm: (c: CheckIn) => void;
  onMarkFailed: (c: CheckIn) => void;
  /**
   * Called when staff correct the phone number / channel and press "Save & re-send".
   * The parent is responsible for calling updateCheckIn (audited) and refreshing state.
   */
  onSaveAndResend: (c: CheckIn, newPhone: string, newChannel: ContactChannel) => void;
  /**
   * 'compact' — iPad card style: smaller buttons, flex-wrap row layout.
   * 'full'    — mobile style: larger buttons, single-column grid.
   */
  variant?: 'compact' | 'full';
}

export function WaActionPanel({
  checkIn,
  waStatus,
  onResend,
  onSimulateConfirm,
  onMarkFailed,
  onSaveAndResend,
  variant = 'compact',
}: WaActionPanelProps) {
  const [phone, setPhone] = useState(checkIn.phone);
  const [channel, setChannel] = useState<ContactChannel>(normalizeChannel(checkIn.contactMethod));

  useEffect(() => {
    setPhone(checkIn.phone);
    setChannel(normalizeChannel(checkIn.contactMethod));
  }, [checkIn.phone, checkIn.contactMethod]);

  const showPhoneEditor = waStatus === 'pending' || waStatus === 'failed';
  const phoneChanged = phone !== checkIn.phone || channel !== checkIn.contactMethod;
  const phoneEmpty = !phone.trim();
  const canSave = showPhoneEditor && phoneChanged && !phoneEmpty;

  const isProblem = waStatus === 'failed' || waStatus === 'unverified';
  const channelLabel = CHANNEL_LABEL[normalizeChannel(checkIn.contactMethod)];

  if (variant === 'full') {
    return (
      <>
        <p className="text-xs text-foreground/80">
          {waStatus === 'pending'
            ? `Waiting for the parent to tap "Confirm received" in ${channelLabel}.`
            : `${channelLabel} unreachable — ask the parent to verify their number, then resend.`}
        </p>

        {showPhoneEditor && (
          <div className="space-y-2">
            <PhoneInput
              value={phone}
              onChange={setPhone}
              showKeypad={false}
              label="Parent's number"
              channel={channel}
              onChannelChange={setChannel}
            />
            <Button
              className="w-full h-12 gap-2 text-sm"
              disabled={!canSave}
              onClick={() => onSaveAndResend(checkIn, phone, channel)}
            >
              <Send className="w-4 h-4" />
              Save & re-send
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2">
          <Button
            variant="outline"
            className="h-12 gap-2 text-sm"
            onClick={() => onResend(checkIn)}
          >
            <RefreshCw className="w-4 h-4" />
            Resend confirmation
          </Button>
          {waStatus === 'pending' && (
            <Button
              variant="outline"
              className="h-12 gap-2 text-sm text-emerald-400"
              onClick={() => onSimulateConfirm(checkIn)}
            >
              <CheckCircle2 className="w-4 h-4" />
              Sim: parent confirms
            </Button>
          )}
          {waStatus !== 'failed' && (
            <Button
              variant="outline"
              className="h-12 gap-2 text-sm text-red-400"
              onClick={() => onMarkFailed(checkIn)}
            >
              <PhoneOff className="w-4 h-4" />
              Couldn't reach
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <div
      className={`rounded-lg px-3 py-2 flex flex-col gap-2 ${
        isProblem
          ? 'bg-red-500/10 border border-red-500/20'
          : 'bg-amber-500/10 border border-amber-500/20'
      }`}
    >
      <p className="text-xs font-semibold text-foreground/80">
        {isProblem
          ? `${channelLabel} unreachable — ask the parent to verify their number, then resend.`
          : `Waiting for parent to tap "Confirm received" in ${channelLabel}.`}
      </p>

      {showPhoneEditor && (
        <div className="flex items-end gap-2">
          <PhoneInput
            value={phone}
            onChange={setPhone}
            showKeypad={false}
            label=""
            className="flex-1 min-w-0"
            channel={channel}
            onChannelChange={setChannel}
          />
          <Button
            size="sm"
            className="h-10 gap-1.5 text-xs shrink-0"
            disabled={!canSave}
            onClick={() => onSaveAndResend(checkIn, phone, channel)}
          >
            <Send className="w-3.5 h-3.5" />
            Save & re-send
          </Button>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => onResend(checkIn)}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Resend
        </Button>
        {waStatus === 'pending' && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
            onClick={() => onSimulateConfirm(checkIn)}
          >
            <Smartphone className="w-3.5 h-3.5" />
            Sim: parent confirms
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
          onClick={() => onMarkFailed(checkIn)}
        >
          <WifiOff className="w-3.5 h-3.5" />
          Couldn't reach
        </Button>
      </div>
    </div>
  );
}
