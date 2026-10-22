import { useCallback, useEffect, useRef, useState } from 'react';
import { PricingOverridesWithPorts } from '@oto/admin-screens/lifted/admin/pricing-overrides/PricingOverridesSection';
import type { PricingOverride } from '@oto/admin-screens/lifted/model/types';
import {
  holidayToPricingOverride,
  organisationApi,
  type OrganisationBranch,
} from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';

export function Holidays() {
  const { me, has } = useSession();
  const allowed = has('catalog:holiday:manage');
  const [branches, setBranches] = useState<OrganisationBranch[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [ranges, setRanges] = useState<PricingOverride[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  const selectedBranch = useRef(branchId);
  selectedBranch.current = branchId;
  const selected = branches?.find((row) => row.id === branchId);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setBranchError(null);
    void organisationApi.branchesApi
      .list()
      .then(({ branches: rows }) => {
        if (!active) return;
        const live = rows.filter((row) => !row.archived);
        setBranches(live);
        setBranchId((previous) =>
          live.some((row) => row.id === previous)
            ? previous
            : (live.find((row) => row.id === me?.branch?.id)?.id ?? live[0]?.id ?? ''),
        );
      })
      .catch((failure: unknown) => {
        if (active)
          setBranchError(
            failure instanceof Error ? failure.message : 'The parks could not be read.',
          );
      });
    return () => {
      active = false;
    };
  }, [allowed, me?.branch?.id, refresh]);

  const reload = useCallback(async () => {
    if (!branchId) return;
    const current = ++request.current;
    setError(null);
    try {
      const answer = await organisationApi.holidaysApi.holidays(branchId);
      if (current === request.current) setRanges(answer.holidays.map(holidayToPricingOverride));
    } catch (failure) {
      if (current === request.current) {
        setRanges(null);
        setError(failure instanceof Error ? failure.message : 'The holidays could not be read.');
      }
      throw failure;
    }
  }, [branchId]);

  useEffect(() => {
    if (!allowed || !branchId) return;
    setRanges(null);
    void reload().catch(() => {});
    return () => {
      request.current++;
    };
  }, [allowed, branchId, reload]);

  const getActiveBranch = useCallback(() => ({ id: selected?.code ?? '' }), [selected?.code]);
  const holidaySaleCounts = useCallback(async () => {
    if (!branchId) return {};
    const answer = await organisationApi.holidaysApi.holidays(branchId);
    return Object.fromEntries(answer.holidays.map((row) => [row.id, row.pricedSales]));
  }, [branchId]);

  if (!allowed) return <PermissionRequired permission="catalog:holiday:manage" />;
  return (
    <>
      <CommandBar
        sectionId="holidays"
        actions={
          branches && branches.length > 0 ? (
            <SelectChip
              label="Park"
              value={branchId}
              onChange={(value) => {
                request.current++;
                setRanges(null);
                setBranchId(value);
              }}
              options={branches.map((row) => ({ value: row.id, label: row.name }))}
            />
          ) : undefined
        }
      />
      {branchError && (
        <ErrorNote message={branchError} onRetry={() => setRefresh((value) => value + 1)} />
      )}
      {error && <ErrorNote message={error} onRetry={() => void reload().catch(() => {})} />}
      {!branches && !branchError ? (
        <Loading what="parks" />
      ) : branches?.length === 0 ? (
        <EmptyNote
          title="No parks here"
          detail="There is no reachable park to show a pricing calendar for."
        />
      ) : selected && ranges ? (
        <PricingOverridesWithPorts
          key={branchId}
          ports={{
            pricingOverrides: ranges,
            getActiveBranch,
            holidaySaleCounts,
            upsertPricingOverride: async (range) => {
              const target = branchId;
              const body = { name: range.name, startsOn: range.startDate, endsOn: range.endDate };
              if (ranges.some((row) => row.id === range.id))
                await organisationApi.holidaysApi.updateHoliday(target, range.id, body);
              else await organisationApi.holidaysApi.createHoliday(target, body);
              if (selectedBranch.current === target) await reload();
            },
            deletePricingOverride: async (id) => {
              const target = branchId;
              await organisationApi.holidaysApi.deleteHoliday(target, id);
              if (selectedBranch.current === target) await reload();
            },
          }}
        />
      ) : !error && !branchError && branchId ? (
        <Loading what="holidays" />
      ) : null}
    </>
  );
}
