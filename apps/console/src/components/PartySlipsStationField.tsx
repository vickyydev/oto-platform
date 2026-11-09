/**
 * SCRUM-805 — the branch setting naming the station whose kitchen and bar
 * printers receive the party slips (birthday plan §5; the owner's decision 3:
 * "the park tags it later; until then the job records no printer and the party
 * page shows it").
 */

/** What the editor says under the chooser. */
export const PARTY_SLIPS_STATION_SENTENCE =
  'The park tags this later. Until a station is named, each party’s kitchen and bar slips are recorded as “no printer” at their slip time, and the party page shows it.';

export function PartySlipsStationField({
  value,
  stations,
  error,
  fieldClass,
  onChange,
}: {
  /** The station named now, or '' for none. */
  value: string;
  /** The park's live stations; null while they are read or when they could not be. */
  stations: ReadonlyArray<{ id: string; name: string }> | null;
  error: string | null;
  fieldClass: string;
  onChange: (stationId: string) => void;
}) {
  const listed = stations?.some((row) => row.id === value) ?? false;
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      Party slips printer station
      <select
        className={fieldClass}
        value={value}
        disabled={stations === null}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not named yet</option>
        {value && !listed && <option value={value}>The station named now</option>}
        {(stations ?? []).map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
      <span className="text-xs font-normal text-muted-foreground">{PARTY_SLIPS_STATION_SENTENCE}</span>
      {error && <span className="text-xs font-normal text-destructive">{error}</span>}
    </label>
  );
}
