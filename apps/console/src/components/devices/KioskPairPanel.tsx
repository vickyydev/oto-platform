import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { normaliseKioskPairingCode } from '@oto/shared';
import { ApiError } from '@/api/client';
import { fleetApi, type StationRow } from '@/api/fleet';
import { CONTROL } from '@/components/Filters';
import { Field, Select, TextInput } from '@/components/Form';
import { Button } from '@/components/ui/button';

/**
 * S2-20 K2 (SCRUM-217) — PAIR A SELF-SERVICE KIOSK, the way a display pairs
 * (`DisplayPairPanel`): the kiosk shows a code — a K and six digits — and the
 * manager types it here against a kiosk station. The kiosk made its own secret
 * before it asked; claiming the code binds that secret to the station, with
 * the kiosk's device scope and nothing a person holds.
 */
export function KioskPairPanel({
  stations,
  onClose,
  onPaired,
}: {
  /** Kiosk stations at this branch, with a box, where this account may pair devices. */
  stations: StationRow[];
  onClose: () => void;
  onPaired: () => void;
}) {
  const [stationId, setStationId] = useState(stations[0]?.id ?? '');
  const [name, setName] = useState('');
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [paired, setPaired] = useState<{ kiosk: string; station: string } | null>(null);
  const code = normaliseKioskPairingCode(digits);
  const valid = stations.some((station) => station.id === stationId) && name.trim().length > 0 && code !== null;

  const submit = async () => {
    if (inFlight.current || !valid || !code) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(null);
    setDigits('');
    try {
      const result = await fleetApi.claimKiosk(stationId, { pairingCode: code, name: name.trim() });
      setPaired({ kiosk: result.device.name, station: result.station.name });
      onPaired();
    } catch (err) {
      // Server bodies and the submitted code stay out of the page, as on the display's panel.
      setFailed(
        err instanceof ApiError && err.code === 'KIOSK_PAIRING_INVALID'
          ? 'This code is no longer available. Get a new code on the kiosk and try again.'
          : err instanceof ApiError && err.code === 'KIOSK_STATION_OCCUPIED'
            ? 'This kiosk station already has a screen. Revoke it in Paired screens before pairing another.'
            : err instanceof ApiError && err.code === 'KIOSK_STATION_INVALID'
              ? 'A self-service kiosk pairs to a kiosk station only.'
              : err instanceof ApiError && err.status === 403
                ? 'You do not have permission to pair a kiosk at this station.'
                : err instanceof ApiError && err.status === 404
                  ? 'Kiosk pairing is not available on this deployment.'
                  : 'The kiosk could not be paired. Check Paired screens before trying again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (paired) {
    return (
      <>
        <p role="status" className="text-sm">
          {paired.kiosk} is paired to {paired.station}. The kiosk shows its attract screen within a few seconds.
        </p>
        <Button onClick={onClose}>Done</Button>
      </>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Open the kiosk at its address (/kiosk) on its screen, then enter the code it shows — a K and six digits.
      </p>
      <Field label="Kiosk station">
        <Select
          value={stationId}
          onChange={setStationId}
          options={stations.map((station) => ({ value: station.id, label: station.name }))}
          disabled={busy}
        />
      </Field>
      <Field label="Kiosk name" hint="Choose a name that makes this screen easy to find later.">
        <TextInput value={name} onChange={setName} placeholder="Lobby kiosk" maxLength={80} disabled={busy} />
      </Field>
      <Field label="Pairing code" hint="The K and six digits shown on the kiosk. The code is cleared when submitted.">
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg font-bold" aria-hidden>
            K
          </span>
          <input
            className={CONTROL}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label="Pairing code digits"
            maxLength={8}
            value={digits}
            onChange={(event) => setDigits(event.target.value.replace(/[^0-9kK]/g, '').slice(0, 7))}
            disabled={busy}
          />
        </div>
      </Field>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {failed}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !valid}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Pair the kiosk
        </Button>
      </div>
    </form>
  );
}
