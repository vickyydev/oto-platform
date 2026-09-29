import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ApiError } from '@/api/client';
import { fleetApi, type StationRow } from '@/api/fleet';
import { CONTROL } from '@/components/Filters';
import { Field, Select, TextInput } from '@/components/Form';
import { Button } from '@/components/ui/button';

/** The manager claims the code on the display; the display receives its own credential. */
export function DisplayPairPanel({
  stations,
  onClose,
  onPaired,
}: {
  stations: StationRow[];
  onClose: () => void;
  onPaired: () => void;
}) {
  const [stationId, setStationId] = useState(stations[0]?.id ?? '');
  const [name, setName] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [paired, setPaired] = useState<{ display: string; station: string } | null>(null);
  const valid =
    stations.some((station) => station.id === stationId) &&
    name.trim().length > 0 &&
    /^[0-9]{6}$/.test(pairingCode);

  const submit = async () => {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(null);
    const code = pairingCode;
    setPairingCode('');
    try {
      const result = await fleetApi.claimDisplay(stationId, {
        pairingCode: code,
        name: name.trim(),
      });
      setPaired({ display: result.device.name, station: result.station.name });
      onPaired();
    } catch (err) {
      // Keep server bodies and the submitted code out of the page and evidence.
      setFailed(
        err instanceof ApiError && err.code === 'DISPLAY_PAIRING_INVALID'
          ? 'This code is no longer available. Get a new code on the display and try again.'
          : err instanceof ApiError && err.code === 'DISPLAY_STATION_OCCUPIED'
            ? 'This station already has a display. Revoke it in Paired screens before pairing another.'
          : err instanceof ApiError && err.status === 403
            ? 'You do not have permission to pair a display at this station.'
            : err instanceof ApiError && err.status === 404
              ? 'Display pairing is not available on this deployment.'
              : 'The display could not be paired. Check Paired screens before trying again.',
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
          {paired.display} is paired to {paired.station}. The display can now connect to this
          station.
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
        Open the customer display on its device, then enter the six-digit code it shows.
      </p>
      <Field label="Station">
        <Select
          value={stationId}
          onChange={setStationId}
          options={stations.map((station) => ({ value: station.id, label: station.name }))}
          disabled={busy}
        />
      </Field>
      <Field label="Display name" hint="Choose a name that makes this screen easy to find later.">
        <TextInput
          value={name}
          onChange={setName}
          placeholder="Counter 1 display"
          maxLength={80}
          disabled={busy}
        />
      </Field>
      <Field
        label="Pairing code"
        hint="The six digits shown on the display. The code is cleared when submitted."
      >
        <input
          className={CONTROL}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{6}"
          maxLength={6}
          value={pairingCode}
          onChange={(event) =>
            setPairingCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
          }
          disabled={busy}
        />
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
          Pair the display
        </Button>
      </div>
    </form>
  );
}
