import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  Printer,
  Baby,
  User,
  ScanLine,
  ArrowLeft,
  ArrowRight,
  Check,
  Settings,
  Info,
  Camera,
  ChefHat,
  GlassWater,
  Ticket,
  Home,
  PartyPopper,
  Layers,
  Loader2,
  Cpu,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { StationCapability, ScannerMode, StationProfile, Device, DeviceType } from '@/types';
import { getAvailableDevices } from '@/mockApi';
import {
  adminApi,
  stationsApi,
  type ApiBox,
  type ApiDevice,
  type StaffCandidate,
  type StationAccessScope,
  type StationInput,
  type StationKind,
} from '@/api/platform';
import { isMissingRoute } from '@/api/client';
import { useStation } from '@/station/StationContext';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { ROLE_TO_API, toPrototypeDevices, type DeviceRole } from '@/station/fleet';
import { deviceById, testPrint, testScan } from '@/lib/printRouting';
import { DevicePicker } from '@/components/station/DevicePicker';
import { BoxPicker } from '@/components/station/BoxPicker';
import { ModeOption } from '@/components/station/ModeOption';
import { StaffAccessPicker } from '@/components/station/StaffAccessPicker';
import { StationPicker } from '@/components/station/StationPicker';
import { StationShell } from '@/components/station/StationShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

// ─── Capability metadata ──────────────────────────────────────────────────────

const CAP_META: Record<
  StationCapability,
  { label: string; description: string; icon: ReactNode; roles: DeviceRole[] }
> = {
  tickets: {
    label: 'Sell tickets',
    description: 'Entry tickets, bracelets, add-ons',
    icon: <Ticket className="w-5 h-5" />,
    roles: ['receipt', 'kids', 'adult'],
  },
  fnb: {
    label: 'F&B orders',
    description: 'Food & drink ordering station',
    icon: <ChefHat className="w-5 h-5" />,
    roles: ['kitchen', 'bar', 'receipt'],
  },
  dropoff: {
    label: 'Drop-off',
    description: 'Unaccompanied child check-in',
    icon: <Home className="w-5 h-5" />,
    roles: ['kids'],
  },
  parties: {
    label: 'Parties',
    description: 'Party bookings and extras',
    icon: <PartyPopper className="w-5 h-5" />,
    roles: ['receipt'],
  },
};

const ROLE_ORDER: DeviceRole[] = ['receipt', 'kids', 'adult', 'kitchen', 'bar'];

/** Which devices can fill each slot, in the prototype's own vocabulary. */
const ROLE_DEVICE_TYPE: Record<DeviceRole, DeviceType> = {
  receipt: 'receipt_printer',
  kids: 'bracelet_printer',
  adult: 'bracelet_printer',
  kitchen: 'kitchen_printer',
  bar: 'bar_printer',
};

function deriveDeviceRoles(caps: StationCapability[]): DeviceRole[] {
  if (caps.length === 0) return ROLE_ORDER;
  return ROLE_ORDER.filter((role) => caps.some((c) => CAP_META[c].roles.includes(role)));
}

// ─── Step key types ───────────────────────────────────────────────────────────

type StepKey = 'capabilities' | 'name' | 'box' | DeviceRole | 'scanner' | 'access' | 'ready';

/**
 * The wizard's steps. The two S2-04 additions sit where the order of the work
 * puts them: the box before every device step, because the box is a machine
 * already standing at the counter and the devices on offer are the ones plugged
 * into it; and who may use the station last, once there is a station to give
 * people.
 */
function buildWizardSteps(caps: StationCapability[], fleet: boolean): StepKey[] {
  return [
    'capabilities',
    'name',
    ...(fleet ? (['box'] as StepKey[]) : []),
    ...deriveDeviceRoles(caps),
    'scanner',
    ...(fleet ? (['access'] as StepKey[]) : []),
    'ready',
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Everything reached through "Set up station" in the header.
 *
 * Which surface that is depends on who is asking. Staff switch between the
 * stations they may work and never set one up — the owner's rule, and the
 * reason the wizard is behind a permission rather than behind a warning.
 * Administrators reach the wizard and the settings from the picker.
 */
export default function StationSetup() {
  const [location] = useLocation();
  const { station, active, fleetAvailable } = useStation();
  const { can } = useOperator();

  // The fleet routes are not on this deployment yet, so there is no list of
  // stations to pick from and nothing to gate. Keep the prototype's own
  // behaviour exactly: the wizard when this iPad has no station, its settings
  // when it has one, both against the mock device catalogue.
  if (!fleetAvailable) return <StationEditor wizard={!station} />;

  if (location.endsWith('/new')) {
    return can('admin:station:create') ? (
      <StationEditor wizard />
    ) : (
      <SetupRefused action="set a station up" />
    );
  }

  if (location.endsWith('/settings')) {
    if (!can('admin:station:update')) return <SetupRefused action="change a station" />;
    // The whole record, not just the profile: a till that is working a station
    // it remembers while the API is unreachable knows its name and nothing
    // else, and editing from that would write a station rather than change one.
    if (!active) return <StationPicker />;
    return <StationEditor wizard={false} />;
  }

  return <StationPicker />;
}

/** What a non-administrator gets for opening the wizard's address directly. */
function SetupRefused({ action }: { action: string }) {
  const [, navigate] = useLocation();
  return (
    <StationShell subtitle="Station setup">
      <Card className="p-6 flex flex-col items-center text-center gap-4 bg-card/50 max-w-3xl mx-auto w-full">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
          <ShieldAlert className="w-8 h-8" />
        </span>
        <h2 className="text-2xl font-bold">Manager access required</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Only a POS manager or an administrator can {action}. Pick the station you are working
          instead — the list shows the ones that are yours.
        </p>
        <Button variant="secondary" onClick={() => navigate('/station-setup')}>
          Pick a station
        </Button>
      </Card>
    </StationShell>
  );
}

// ─── The editor: the prototype's wizard and settings ─────────────────────────

function StationEditor({ wizard }: { wizard: boolean }) {
  const { station, active, fleetAvailable, pick, setStation, reload } = useStation();
  const { branch } = useBranch();
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();

  const fleet = fleetAvailable;
  const branchApiId = branch.apiId;
  // A wizard starts from nothing even when this iPad is already working a
  // station: an administrator setting up the counter next door must not have
  // that station's devices offered as this one's.
  const seed = wizard ? null : station;
  const seedStation = wizard ? null : active;

  // --- the box, and the devices it reported -----------------------------------
  const [boxes, setBoxes] = useState<ApiBox[] | null>(null);
  const [boxId, setBoxId] = useState<string | undefined>(seedStation?.boxId ?? undefined);
  const [boxDevices, setBoxDevices] = useState<ApiDevice[] | null>(null);

  // --- who may work it ---------------------------------------------------------
  const [accessScope, setAccessScope] = useState<StationAccessScope>(
    seedStation?.accessScope === 'selected_staff' ? 'selected_staff' : 'all_staff',
  );
  // Empty until the record arrives: taking a station does not hand this iPad
  // the list of who else may work it, so there is nothing here to seed from.
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [staff, setStaff] = useState<StaffCandidate[] | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffBranchFiltered, setStaffBranchFiltered] = useState(true);
  /**
   * Whether the person has already changed who may use this station.
   *
   * The record below is read to seed the answer, and a read that lands after
   * somebody has started editing must not undo what they did.
   */
  const accessEdited = useRef(false);
  /**
   * Where "who may use this station" stands. `known` means the answer on screen
   * is one somebody can save — the record was read, or the person set it
   * themselves. Until then it is not written at all: a list sent empty takes
   * everybody off the station, and the station then disappears from the pickers
   * of the people who were working it.
   */
  const [accessSource, setAccessSource] = useState<'known' | 'pending' | 'failed'>(
    wizard ? 'known' : 'pending',
  );

  const [saving, setSaving] = useState(false);

  const apiFail = (title: string) => (err: unknown) =>
    toast({
      title,
      description: err instanceof Error ? err.message : 'Unknown error',
      variant: 'destructive',
    });

  useEffect(() => {
    if (!fleet || !branchApiId) return;
    let cancelled = false;
    stationsApi
      .boxes(branchApiId)
      .then((r) => {
        if (!cancelled) setBoxes(r.boxes);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBoxes([]);
        apiFail("Couldn't load this branch's boxes")(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, branchApiId]);

  /**
   * Settings mode edits a station that already exists, and the record this till
   * is holding came from taking it — which carries no staff list, because an
   * iPad on a counter has no business with the names of everybody else who may
   * stand there. So the list is read from the station itself. Without this,
   * saving would write an empty list over the people already on it and the
   * station would vanish from their pickers.
   */
  const editingId = wizard ? null : (seedStation?.id ?? null);
  useEffect(() => {
    if (!fleet || !editingId) return;
    let cancelled = false;
    stationsApi
      .get(editingId)
      .then(({ station: record }) => {
        if (cancelled || accessEdited.current) return;
        setAccessScope(record.accessScope === 'selected_staff' ? 'selected_staff' : 'all_staff');
        setStaffIds((record.staff ?? []).map((s) => s.accountId));
        setAccessSource('known');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAccessSource('failed');
        apiFail("Couldn't read who may use this station")(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, editingId]);

  useEffect(() => {
    if (!fleet || !boxId) {
      setBoxDevices(null);
      return;
    }
    let cancelled = false;
    stationsApi
      .boxDevices(boxId)
      .then((r) => {
        if (!cancelled) setBoxDevices(r.devices);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBoxDevices([]);
        apiFail("Couldn't load what that box has")(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, boxId]);

  // The staff list is only worth fetching once somebody decides to name people.
  useEffect(() => {
    if (!fleet || !branchApiId || accessScope !== 'selected_staff' || staff !== null) return;
    let cancelled = false;
    setStaffLoading(true);
    void (async () => {
      try {
        const { staff: candidates } = await stationsApi.staffCandidates(branchApiId);
        if (!cancelled) {
          setStaff(candidates);
          setStaffBranchFiltered(true);
        }
      } catch (err) {
        if (cancelled) return;
        if (!isMissingRoute(err)) {
          setStaff([]);
          apiFail("Couldn't load this branch's staff")(err);
        } else {
          // The narrowed route is not deployed here yet. Falling back to the
          // operator's whole directory keeps the wizard usable, and the picker
          // says the list is not filtered rather than implying it is.
          try {
            const { accounts } = await adminApi.accounts();
            if (cancelled) return;
            setStaff(
              accounts.map((a) => ({
                accountId: a.id,
                name: a.employee?.name ?? null,
                phone: a.phone,
                status: a.status,
              })),
            );
            setStaffBranchFiltered(false);
          } catch (fallbackErr) {
            if (cancelled) return;
            setStaff([]);
            apiFail("Couldn't load the staff list")(fallbackErr);
          }
        }
      } finally {
        if (!cancelled) setStaffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, branchApiId, accessScope, staff]);

  const boxName = boxes?.find((b) => b.id === boxId)?.name ?? seedStation?.boxName ?? 'the box';

  // Under the fleet the devices on offer are the ones this box reported and
  // nothing else; without it, the prototype's catalogue as before.
  const devices: Device[] = fleet
    ? boxDevices
      ? toPrototypeDevices(boxDevices, boxName)
      : []
    : getAvailableDevices();

  const devicesFor = (role: DeviceRole) =>
    devices.filter((d) => d.type === ROLE_DEVICE_TYPE[role]);
  const scanners = devices.filter((d) => d.type === 'scanner');

  // Capabilities: absent on existing station = does everything
  const [capabilities, setCapabilities] = useState<StationCapability[]>(seed?.capabilities ?? []);
  const [name, setName] = useState(seed?.stationName ?? '');
  const [receiptId, setReceiptId] = useState<string | undefined>(seed?.receiptPrinterId);
  const [kidsId, setKidsId] = useState<string | undefined>(seed?.kidsBraceletPrinterId);
  const [adultId, setAdultId] = useState<string | undefined>(seed?.adultBraceletPrinterId);
  const [kitchenId, setKitchenId] = useState<string | undefined>(seed?.kitchenPrinterId);
  const [barId, setBarId] = useState<string | undefined>(seed?.barPrinterId);

  // Scanner: default to camera on mobile, device if scanner already exists on iPad
  const defaultScannerMode: ScannerMode =
    seed?.scannerMode ?? (isMobile ? 'camera' : seed?.scannerId ? 'device' : 'camera');
  const [scannerMode, setScannerMode] = useState<ScannerMode>(defaultScannerMode);
  const [scannerId, setScannerId] = useState<string | undefined>(seed?.scannerId);

  const [stepIdx, setStepIdx] = useState(0);

  /**
   * Changing the box empties every device slot. The old choices named devices
   * plugged into the old box, and a printer does not move because a station
   * did.
   */
  const chooseBox = (id: string) => {
    if (id === boxId) return;
    setBoxId(id);
    setReceiptId(undefined);
    setKidsId(undefined);
    setAdultId(undefined);
    setKitchenId(undefined);
    setBarId(undefined);
    if (scannerMode === 'box') setScannerId(undefined);
  };

  const deviceLabel = (id?: string): string =>
    (id ? devices.find((d) => d.id === id)?.label : undefined) ?? 'Not set';

  const visibleRoles = deriveDeviceRoles(capabilities);

  const buildProfile = (): StationProfile => ({
    stationId: seed?.stationId ?? `station-${Math.random().toString(36).slice(2, 8)}`,
    stationName: name.trim() || 'Unnamed Station',
    capabilities,
    receiptPrinterId: receiptId,
    kidsBraceletPrinterId: kidsId,
    adultBraceletPrinterId: adultId,
    kitchenPrinterId: kitchenId,
    barPrinterId: barId,
    scannerId: scannerMode === 'device' ? scannerId : undefined,
    scannerMode,
  });

  /**
   * What the station tells the box to drive, one device per role.
   *
   * The set is sent whole and replaces what was there, so a role that is not in
   * it is a role with nothing assigned: clearing a printer is leaving it out,
   * and a role the capabilities hid is left out for the same reason.
   */
  const deviceAssignments = (): StationInput['devices'] => {
    const chosen: Array<[DeviceRole, string | undefined]> = [
      ['receipt', receiptId],
      ['kids', kidsId],
      ['adult', adultId],
      ['kitchen', kitchenId],
      ['bar', barId],
    ];
    const assignments: StationInput['devices'] = [];
    for (const [role, id] of chosen) {
      if (id && visibleRoles.includes(role)) {
        assignments.push({ role: ROLE_TO_API[role], deviceId: id });
      }
    }
    // A scanner on the box belongs to the station; the iPad's own camera and a
    // scanner paired to the iPad do not, and are kept on the device instead.
    if (scannerMode === 'box' && scannerId) {
      assignments.push({ role: 'scanner', deviceId: scannerId });
    }
    return assignments;
  };

  const save = async (announceReady: boolean) => {
    if (!fleet) {
      setStation(buildProfile());
      toast(
        announceReady
          ? { title: 'Station ready', description: `${name.trim() || 'This station'} is set up.` }
          : { title: 'Station saved', description: 'Your changes are active on this iPad.' },
      );
      navigate('/');
      return;
    }
    if (!branchApiId || !boxId) {
      toast({
        title: "Couldn't save the station",
        description: branchApiId
          ? 'Choose the box this station runs on first.'
          : 'This branch is not on the platform yet.',
        variant: 'destructive',
      });
      return;
    }
    const stationName = name.trim() || 'Unnamed Station';
    setSaving(true);
    try {
      const core = {
        boxId,
        name: stationName,
        kind: stationKind(seedStation?.kind),
        capabilities,
        devices: deviceAssignments(),
      };
      const access = {
        accessScope,
        staffAccountIds: accessScope === 'selected_staff' ? staffIds : [],
      };
      let savedId: string;
      if (wizard || !seedStation) {
        savedId = (await stationsApi.create(branchApiId, { ...core, ...access })).station.id;
      } else {
        // Both lists are written whole, so leaving the access pair out of the
        // patch is how the station keeps the people it already has when this
        // screen never managed to read them.
        await stationsApi.update(
          seedStation.id,
          accessSource === 'known' ? { ...core, ...access } : core,
        );
        savedId = seedStation.id;
      }
      await reload();
      try {
        // Open the till on what was just set up. The pick goes through the same
        // refusal as anybody else's, so an administrator who left themselves off
        // a named list finds out here rather than at the next shift.
        await pick(savedId, scannerMode === 'box' ? undefined : scannerMode);
        toast(
          announceReady
            ? { title: 'Station ready', description: `${stationName} is set up and yours.` }
            : { title: 'Station saved', description: `${stationName} is up to date.` },
        );
        navigate('/');
      } catch {
        toast({
          title: `${stationName} is set up`,
          description:
            'It is kept for the staff on its list, and you are not on it, so it is not in your picker.',
        });
        navigate('/station-setup');
      }
    } catch (err) {
      apiFail("Couldn't save the station")(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleCapability = (cap: StationCapability) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  // Both of these mark the answer as the person's own: the record's version of
  // it cannot land afterwards and undo them, and what is on screen is now
  // something to save rather than something still being read.
  const chooseAccessScope = (scope: StationAccessScope) => {
    accessEdited.current = true;
    setAccessSource('known');
    setAccessScope(scope);
  };

  const toggleStaff = (accountId: string) => {
    accessEdited.current = true;
    setAccessSource('known');
    setStaffIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId],
    );
  };

  /**
   * A test print is a command to the box, not a message down a wire from this
   * iPad: the cloud queues it, the box runs it, and the result shows up in its
   * command history. Without the fleet it stays the prototype's simulated
   * message.
   */
  const runTestPrint = (deviceId?: string) => {
    if (!fleet) {
      testPrint(deviceById(deviceId));
      return;
    }
    if (!deviceId || !boxId) {
      toast({ title: 'No printer selected', description: 'Choose a printer first.' });
      return;
    }
    stationsApi
      .testPrint(boxId, deviceId)
      .then(() =>
        toast({
          title: 'Test print queued',
          description: `${boxName} runs it on its next poll and records the result.`,
        }),
      )
      .catch(apiFail("Couldn't send the test print"));
  };

  const deviceStepProps = (role: DeviceRole, id: string | undefined, set: (v?: string) => void) => ({
    devices: devicesFor(role),
    selectedId: id,
    onSelect: (value: string) => set(value),
    onClear: () => set(undefined),
    onTest: () => runTestPrint(id),
    testLabel: 'Test print',
    empty: fleet ? emptyDeviceNote(boxId, boxDevices) : undefined,
  });

  const scannerStep = (compact?: boolean) => (
    <ScannerStep
      isMobile={isMobile}
      fleet={fleet}
      boxName={boxName}
      mode={scannerMode}
      onModeChange={(m) => {
        setScannerMode(m);
        if (m !== 'box' && m !== 'device') setScannerId(undefined);
      }}
      scanners={scanners}
      scannerId={scannerId}
      onScannerSelect={setScannerId}
      compact={compact}
    />
  );

  // ─── Wizard mode ────────────────────────────────────────────────────────────
  if (wizard) {
    const steps = buildWizardSteps(capabilities, fleet);
    const step = steps[stepIdx];

    // Recalculate steps whenever capabilities change — clamp stepIdx if steps shrunk
    const clampedIdx = Math.min(stepIdx, steps.length - 1);
    if (clampedIdx !== stepIdx) setStepIdx(clampedIdx);

    // Only the name step and the box step gate Next; every device and scanner
    // step is freely skippable, and a station with no box has nothing to drive.
    const canAdvance =
      step === 'name' ? name.trim().length > 0 : step === 'box' ? boxId !== undefined : true;

    return (
      <StationShell subtitle="First-time setup">
        <Card className="p-6 flex flex-col bg-card/50 max-w-3xl mx-auto w-full">
          <div className="flex items-center justify-between mb-1 text-sm text-muted-foreground">
            <span>
              Step {stepIdx + 1} of {steps.length}
            </span>
            <span>{Math.round(((stepIdx + 1) / steps.length) * 100)}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden mb-6">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }}
            />
          </div>

          <div className="min-h-[280px]">
            {step === 'capabilities' && (
              <StepWrap icon={<Layers className="w-6 h-6" />} title="What does this station do?">
                <p className="text-muted-foreground mb-4">
                  Pick everything that applies — the setup will only show the devices you need.
                  Leave all unselected if this station does everything.
                </p>
                <CapabilityPicker
                  selected={capabilities}
                  onToggle={toggleCapability}
                />
                {capabilities.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-3">
                    Nothing selected — this station will be set up for all roles.
                  </p>
                )}
              </StepWrap>
            )}

            {step === 'name' && (
              <StepWrap icon={<Settings className="w-6 h-6" />} title="Name this station">
                <p className="text-muted-foreground mb-4">
                  Give this iPad a name staff will recognise — e.g. "Front Desk 1".
                </p>
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Station name"
                  className="h-14 text-lg"
                />
              </StepWrap>
            )}

            {step === 'box' && (
              <StepWrap icon={<Cpu className="w-6 h-6" />} title="Which box runs this station?">
                <p className="text-muted-foreground mb-4">
                  The box is the machine under the counter that drives the printers, the scanner and
                  the card machine. Pick the one this station is plugged into — the devices it
                  reported are what the next steps offer.
                </p>
                {boxes === null ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : boxes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No box has registered at {branch.name} yet. A box registers itself the first
                    time it is switched on with its claim code.
                  </p>
                ) : (
                  <BoxPicker boxes={boxes} selectedId={boxId} onSelect={chooseBox} />
                )}
              </StepWrap>
            )}

            {step === 'receipt' && (
              <DeviceStep
                icon={<Printer className="w-6 h-6" />}
                title="Receipt printer"
                subtitle="Optional — skip if this station doesn't need one."
                {...deviceStepProps('receipt', receiptId, setReceiptId)}
              />
            )}

            {step === 'kids' && (
              <DeviceStep
                icon={<Baby className="w-6 h-6" />}
                title="Kids bracelet printer"
                subtitle="Optional — skip if this station doesn't print bracelets."
                {...deviceStepProps('kids', kidsId, setKidsId)}
              />
            )}

            {step === 'adult' && (
              <DeviceStep
                icon={<User className="w-6 h-6" />}
                title="Adult bracelet printer"
                subtitle="Optional — skip if this station doesn't print adult bracelets."
                {...deviceStepProps('adult', adultId, setAdultId)}
              />
            )}

            {step === 'kitchen' && (
              <DeviceStep
                icon={<ChefHat className="w-6 h-6" />}
                title="Kitchen printer"
                subtitle="Optional — skip if kitchen tickets print elsewhere."
                {...deviceStepProps('kitchen', kitchenId, setKitchenId)}
              />
            )}

            {step === 'bar' && (
              <DeviceStep
                icon={<GlassWater className="w-6 h-6" />}
                title="Bar printer"
                subtitle="Optional — skip if bar tickets print elsewhere."
                {...deviceStepProps('bar', barId, setBarId)}
              />
            )}

            {step === 'scanner' && scannerStep()}

            {step === 'access' && (
              <StepWrap icon={<UserCheck className="w-6 h-6" />} title="Who may use this station?">
                <p className="text-muted-foreground mb-4">
                  Staff pick their station when they sign in. A station kept for named people is not
                  in anybody else's list at all, so nobody is left looking at a till that turns them
                  away.
                </p>
                <StaffAccessPicker
                  scope={accessScope}
                  onScopeChange={chooseAccessScope}
                  staff={staff}
                  loading={staffLoading}
                  branchFiltered={staffBranchFiltered}
                  selected={staffIds}
                  onToggle={toggleStaff}
                />
              </StepWrap>
            )}

            {step === 'ready' && (
              <StepWrap icon={<Check className="w-6 h-6" />} title="Station ready" accent>
                <p className="text-muted-foreground mb-4">
                  Review the assignments below, then finish. Missing devices are fine — they'll be
                  skipped when not needed.
                </p>
                <ReadySummary
                  name={name.trim() || 'Unnamed Station'}
                  capabilities={capabilities}
                  roles={visibleRoles}
                  receiptId={receiptId}
                  kidsId={kidsId}
                  adultId={adultId}
                  kitchenId={kitchenId}
                  barId={barId}
                  scannerMode={scannerMode}
                  scannerId={scannerId}
                  deviceLabel={deviceLabel}
                  boxName={fleet ? boxName : undefined}
                  access={fleet ? accessLine(accessScope, staffIds.length) : undefined}
                />
              </StepWrap>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t">
            <Button
              variant="ghost"
              size="lg"
              disabled={stepIdx === 0}
              onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            >
              <ArrowLeft className="w-5 h-5 mr-1" />
              Back
            </Button>
            {step === 'ready' ? (
              <Button size="lg" className="px-8" disabled={saving} onClick={() => void save(true)}>
                {saving && <Loader2 className="w-5 h-5 mr-1 animate-spin" />}
                Finish setup
              </Button>
            ) : (
              <Button
                size="lg"
                className="px-8"
                disabled={!canAdvance}
                onClick={() => setStepIdx((i) => Math.min(steps.length - 1, i + 1))}
              >
                {step !== 'capabilities' && step !== 'name' && step !== 'box'
                  ? 'Skip / Next'
                  : 'Next'}
                <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
            )}
          </div>
        </Card>
      </StationShell>
    );
  }

  // ─── Settings mode ─────────────────────────────────────────────────────────

  return (
    <StationShell subtitle="Station settings">
      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto w-full space-y-5 pb-8">
          {/* Capabilities */}
          <Card className="p-6 bg-card/50">
            <SectionTitle icon={<Layers className="w-5 h-5" />} title="Station capabilities" />
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Choose what this station handles — only the relevant devices are shown below.
              Leave all unselected to show everything.
            </p>
            <CapabilityPicker selected={capabilities} onToggle={toggleCapability} />
            {capabilities.length === 0 && (
              <p className="text-xs text-muted-foreground mt-3">
                No capabilities selected — all device roles are shown.
              </p>
            )}
          </Card>

          {/* Station name */}
          <Card className="p-6 bg-card/50">
            <SectionTitle icon={<Settings className="w-5 h-5" />} title="Station name" />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Station name"
              className="h-14 text-lg mt-3"
            />
          </Card>

          {/* The box — before the devices, because it decides what they can be. */}
          {fleet && (
            <Card className="p-6 bg-card/50">
              <SectionTitle icon={<Cpu className="w-5 h-5" />} title="Box" />
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                The machine under this counter. Changing it clears the devices below, because they
                are plugged into the old one.
              </p>
              {boxes === null ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : boxes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No box has registered at {branch.name} yet.
                </p>
              ) : (
                <BoxPicker boxes={boxes} selectedId={boxId} onSelect={chooseBox} />
              )}
            </Card>
          )}

          {/* Device cards — only roles relevant to chosen capabilities */}
          {visibleRoles.includes('receipt') && (
            <DeviceCard
              icon={<Printer className="w-5 h-5" />}
              title="Receipt printer"
              note="Optional — leave unset to skip receipt printing on this station."
              {...deviceStepProps('receipt', receiptId, setReceiptId)}
            />
          )}
          {visibleRoles.includes('kids') && (
            <DeviceCard
              icon={<Baby className="w-5 h-5" />}
              title="Kids bracelet printer"
              note="Optional — leave unset to skip kids bracelet printing."
              {...deviceStepProps('kids', kidsId, setKidsId)}
            />
          )}
          {visibleRoles.includes('adult') && (
            <DeviceCard
              icon={<User className="w-5 h-5" />}
              title="Adult bracelet printer"
              note="Optional — leave unset to skip adult bracelet printing."
              {...deviceStepProps('adult', adultId, setAdultId)}
            />
          )}
          {visibleRoles.includes('kitchen') && (
            <DeviceCard
              icon={<ChefHat className="w-5 h-5" />}
              title="Kitchen printer"
              note="Optional — leave unset to skip kitchen ticket printing."
              {...deviceStepProps('kitchen', kitchenId, setKitchenId)}
            />
          )}
          {visibleRoles.includes('bar') && (
            <DeviceCard
              icon={<GlassWater className="w-5 h-5" />}
              title="Bar printer"
              note="Optional — leave unset to skip bar ticket printing."
              {...deviceStepProps('bar', barId, setBarId)}
            />
          )}

          {/* Scanner */}
          <Card className="p-6 bg-card/50">
            <SectionTitle icon={<ScanLine className="w-5 h-5" />} title="Wristband scanner" />
            <div className="mt-4">{scannerStep(true)}</div>
          </Card>

          {/* Who may use it */}
          {fleet && (
            <Card className="p-6 bg-card/50">
              <SectionTitle icon={<UserCheck className="w-5 h-5" />} title="Who may use this station" />
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Staff pick their station when they sign in. A station kept for named people is not in
                anybody else's list at all.
              </p>
              {accessSource === 'failed' && (
                <p className="text-sm text-amber-600 dark:text-amber-400 mb-4">
                  Who may use this station could not be read just now, so what is shown here may not
                  be the whole list. Saving leaves it exactly as it is unless you change it.
                </p>
              )}
              <StaffAccessPicker
                scope={accessScope}
                onScopeChange={chooseAccessScope}
                staff={staff}
                loading={staffLoading}
                branchFiltered={staffBranchFiltered}
                selected={staffIds}
                onToggle={toggleStaff}
                compact
              />
            </Card>
          )}

          <div className="flex justify-end">
            <Button size="lg" className="px-8" disabled={saving} onClick={() => void save(false)}>
              {saving && <Loader2 className="w-5 h-5 mr-1 animate-spin" />}
              Save changes
            </Button>
          </div>
        </div>
      </ScrollArea>
    </StationShell>
  );
}

// ─── Small helpers shared by both modes ──────────────────────────────────────

const KINDS: StationKind[] = ['till', 'kiosk', 'gate', 'display', 'booth'];

/**
 * A station set up from the till is a till unless it already was something
 * else. Booths and gates are configured from the Console, which is where the
 * rest of their settings live, so this screen keeps what it was given rather
 * than quietly turning a gate into a counter.
 */
function stationKind(existing: string | undefined): StationKind {
  const known = KINDS.find((k) => k === existing);
  return known ?? 'till';
}

/** Why a device list is empty, when the box is the reason. */
function emptyDeviceNote(boxId: string | undefined, reported: ApiDevice[] | null): string {
  if (!boxId) return 'Choose the box first — its devices are the ones on offer.';
  if (reported === null) return 'Reading what the box has…';
  return 'The box has not reported a device of this kind.';
}

function accessLine(scope: StationAccessScope, named: number): string {
  if (scope === 'all_staff') return 'All staff at this branch';
  return named === 1 ? '1 named staff member' : `${named} named staff`;
}

// ─── Capability picker ────────────────────────────────────────────────────────

function CapabilityPicker({
  selected,
  onToggle,
}: {
  selected: StationCapability[];
  onToggle: (cap: StationCapability) => void;
}) {
  const caps: StationCapability[] = ['tickets', 'fnb', 'dropoff', 'parties'];
  return (
    <div className="grid grid-cols-2 gap-3">
      {caps.map((cap) => {
        const meta = CAP_META[cap];
        const active = selected.includes(cap);
        return (
          <button
            key={cap}
            type="button"
            onClick={() => onToggle(cap)}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors min-h-[80px]',
              active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={cn('font-semibold', active && 'text-primary')}>{meta.label}</span>
              {active && <Check className="w-4 h-4 text-primary shrink-0" />}
            </div>
            <div className="text-xs text-muted-foreground">{meta.description}</div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Scanner step (used in both wizard + settings) ────────────────────────────

function ScannerStep({
  isMobile,
  fleet,
  boxName,
  mode,
  onModeChange,
  scanners,
  scannerId,
  onScannerSelect,
  compact,
}: {
  isMobile: boolean;
  /** With a box there is a third place a scanner can live (R-15). */
  fleet: boolean;
  boxName: string;
  mode: ScannerMode;
  onModeChange: (m: ScannerMode) => void;
  scanners: Device[];
  scannerId?: string;
  onScannerSelect: (id: string) => void;
  compact?: boolean;
}) {
  const content = (
    <>
      <p className={cn('text-muted-foreground mb-4', compact && 'text-sm')}>
        {isMobile
          ? 'This device defaults to camera scanning. You can optionally assign a physical scanner instead.'
          : 'Choose how this station scans wristbands.'}
      </p>

      <div className="flex flex-col gap-3 mb-4">
        <ModeOption
          active={mode === 'camera'}
          icon={<Camera className="w-5 h-5" />}
          label="Use this device's camera"
          description="Staff type or scan via the on-screen input. No hardware needed."
          onClick={() => onModeChange('camera')}
        />
        <ModeOption
          active={mode === 'device'}
          icon={<ScanLine className="w-5 h-5" />}
          label="Assign a physical scanner"
          description="Bluetooth/USB scanner paired to this iPad."
          onClick={() => onModeChange('device')}
        />
        {fleet && (
          <ModeOption
            active={mode === 'box'}
            icon={<Cpu className="w-5 h-5" />}
            label="Scanner on the box"
            description="Plugged into the box, so its scans reach the till, the display and the gate alike."
            onClick={() => onModeChange('box')}
          />
        )}
      </div>

      {mode === 'device' && (
        <>
          <NoteLine text="Bluetooth scanners pair in iOS Settings → Bluetooth before they appear here." />
          {scanners.length > 0 && !fleet ? (
            <>
              <DevicePicker devices={scanners} selectedId={scannerId} onSelect={onScannerSelect} />
              <Button
                variant="outline"
                className="mt-4"
                disabled={!scannerId}
                onClick={() => testScan(deviceById(scannerId))}
              >
                Test scan
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No scanners found. Pair a scanner in iOS Settings first.
            </p>
          )}
        </>
      )}

      {mode === 'box' && (
        <>
          <NoteLine text={`Scanners plugged into ${boxName}. The box publishes each scan to the whole station.`} />
          {scanners.length > 0 ? (
            <DevicePicker devices={scanners} selectedId={scannerId} onSelect={onScannerSelect} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {boxName} has not reported a scanner.
            </p>
          )}
        </>
      )}
    </>
  );

  if (compact) return <div>{content}</div>;

  return (
    <StepWrap icon={<ScanLine className="w-6 h-6" />} title="Wristband scanner">
      {content}
    </StepWrap>
  );
}

// ─── Review summary (wizard ready step) ──────────────────────────────────────

function ReadySummary({
  name,
  capabilities,
  roles,
  receiptId,
  kidsId,
  adultId,
  kitchenId,
  barId,
  scannerMode,
  scannerId,
  deviceLabel,
  boxName,
  access,
}: {
  name: string;
  capabilities: StationCapability[];
  roles: DeviceRole[];
  receiptId?: string;
  kidsId?: string;
  adultId?: string;
  kitchenId?: string;
  barId?: string;
  scannerMode: ScannerMode;
  scannerId?: string;
  deviceLabel: (id?: string) => string;
  /** Absent without the fleet, where a station has no box. */
  boxName?: string;
  /** Absent without the fleet, where every station is open to everybody. */
  access?: string;
}) {
  const capLabel =
    capabilities.length === 0
      ? 'Does everything'
      : capabilities.map((c) => CAP_META[c].label).join(', ');

  const scannerLabel =
    scannerMode === 'camera' ? 'Camera / manual input' : deviceLabel(scannerId);

  const rows: [string, string][] = [
    ['Station', name],
    ['Does', capLabel],
    ...(boxName ? [['Box', boxName] as [string, string]] : []),
    ...(roles.includes('receipt')
      ? [['Receipt printer', deviceLabel(receiptId)] as [string, string]]
      : []),
    ...(roles.includes('kids')
      ? [['Kids bracelet', deviceLabel(kidsId)] as [string, string]]
      : []),
    ...(roles.includes('adult')
      ? [['Adult bracelet', deviceLabel(adultId)] as [string, string]]
      : []),
    ...(roles.includes('kitchen')
      ? [['Kitchen printer', deviceLabel(kitchenId)] as [string, string]]
      : []),
    ...(roles.includes('bar') ? [['Bar printer', deviceLabel(barId)] as [string, string]] : []),
    ['Scanner', scannerLabel],
    ...(access ? [['Who may use it', access] as [string, string]] : []),
  ];

  return (
    <div className="rounded-xl border divide-y">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between px-4 py-3">
          <span className="text-muted-foreground">{label}</span>
          <span
            className={cn(
              'font-semibold',
              value === 'Not set' && 'text-muted-foreground font-normal italic',
            )}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Layout + small presentational helpers ────────────────────────────────────

function StepWrap({
  icon,
  title,
  accent,
  children,
}: {
  icon: ReactNode;
  title: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center ${
            accent ? 'bg-emerald-500/20 text-emerald-500' : 'bg-primary/15 text-primary'
          }`}
        >
          {icon}
        </div>
        <h2 className="text-2xl font-bold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function DeviceStep({
  icon,
  title,
  subtitle,
  devices,
  selectedId,
  onSelect,
  onClear,
  onTest,
  testLabel,
  note,
  empty,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  devices: Device[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClear: () => void;
  onTest: () => void;
  testLabel: string;
  note?: string;
  /** Shown in place of an empty picker, saying why there is nothing to pick. */
  empty?: string;
}) {
  return (
    <StepWrap icon={icon} title={title}>
      {subtitle && <p className="text-muted-foreground mb-4">{subtitle}</p>}
      {note && <NoteLine text={note} />}
      {devices.length === 0 && empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <DevicePicker devices={devices} selectedId={selectedId} onSelect={onSelect} />
      )}
      <div className="flex gap-3 mt-4">
        <Button variant="outline" disabled={!selectedId} onClick={onTest}>
          {testLabel}
        </Button>
        {selectedId && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onClear}>
            Clear selection
          </Button>
        )}
      </div>
    </StepWrap>
  );
}

function DeviceCard(props: {
  icon: ReactNode;
  title: string;
  note?: string;
  devices: Device[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClear: () => void;
  onTest: () => void;
  testLabel: string;
  empty?: string;
}) {
  const { icon, title, note, devices, selectedId, onSelect, onClear, onTest, testLabel, empty } =
    props;
  return (
    <Card className="p-6 bg-card/50">
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={icon} title={title} />
        <div className="flex items-center gap-2">
          {selectedId && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onClear}
            >
              Clear
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!selectedId} onClick={onTest}>
            {testLabel}
          </Button>
        </div>
      </div>
      {note && <NoteLine text={note} />}
      {devices.length === 0 && empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <DevicePicker devices={devices} selectedId={selectedId} onSelect={onSelect} />
      )}
    </Card>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-primary">{icon}</span>
      <h3 className="text-lg font-bold">{title}</h3>
    </div>
  );
}

function NoteLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground mb-3">
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
