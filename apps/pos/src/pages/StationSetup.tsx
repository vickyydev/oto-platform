import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
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
} from 'lucide-react';
import { StationCapability, ScannerMode, StationProfile } from '@/types';
import { getAvailableDevices } from '@/mockApi';
import { useStation } from '@/station/StationContext';
import { deviceById, testPrint, testScan } from '@/lib/printRouting';
import { DevicePicker } from '@/components/station/DevicePicker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo-oto.png';

// ─── Capability metadata ──────────────────────────────────────────────────────

type DeviceRole = 'receipt' | 'kids' | 'adult' | 'kitchen' | 'bar';

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

function deriveDeviceRoles(caps: StationCapability[]): DeviceRole[] {
  if (caps.length === 0) return ROLE_ORDER;
  return ROLE_ORDER.filter((role) => caps.some((c) => CAP_META[c].roles.includes(role)));
}

// ─── Step key types ───────────────────────────────────────────────────────────

type StepKey = 'capabilities' | 'name' | DeviceRole | 'scanner' | 'ready';

function buildWizardSteps(caps: StationCapability[]): StepKey[] {
  return ['capabilities', 'name', ...deriveDeviceRoles(caps), 'scanner', 'ready'];
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StationSetup() {
  const { station, setStation } = useStation();
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();

  const devices = getAvailableDevices();
  const receiptPrinters = devices.filter((d) => d.type === 'receipt_printer');
  const braceletPrinters = devices.filter((d) => d.type === 'bracelet_printer');
  const kitchenPrinters = devices.filter((d) => d.type === 'kitchen_printer');
  const barPrinters = devices.filter((d) => d.type === 'bar_printer');
  const scanners = devices.filter((d) => d.type === 'scanner');

  // Capabilities: absent on existing station = does everything
  const [capabilities, setCapabilities] = useState<StationCapability[]>(
    station?.capabilities ?? [],
  );
  const [name, setName] = useState(station?.stationName ?? '');
  const [receiptId, setReceiptId] = useState<string | undefined>(station?.receiptPrinterId);
  const [kidsId, setKidsId] = useState<string | undefined>(station?.kidsBraceletPrinterId);
  const [adultId, setAdultId] = useState<string | undefined>(station?.adultBraceletPrinterId);
  const [kitchenId, setKitchenId] = useState<string | undefined>(station?.kitchenPrinterId);
  const [barId, setBarId] = useState<string | undefined>(station?.barPrinterId);

  // Scanner: default to camera on mobile, device if scanner already exists on iPad
  const defaultScannerMode: ScannerMode =
    station?.scannerMode ??
    (isMobile ? 'camera' : station?.scannerId ? 'device' : 'camera');
  const [scannerMode, setScannerMode] = useState<ScannerMode>(defaultScannerMode);
  const [scannerId, setScannerId] = useState<string | undefined>(station?.scannerId);

  const isWizard = !station;
  const [stepIdx, setStepIdx] = useState(0);

  const buildProfile = (): StationProfile => ({
    stationId: station?.stationId ?? `station-${Math.random().toString(36).slice(2, 8)}`,
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

  const save = (announceReady: boolean) => {
    setStation(buildProfile());
    toast(
      announceReady
        ? { title: 'Station ready', description: `${name.trim() || 'This station'} is set up.` }
        : { title: 'Station saved', description: 'Your changes are active on this iPad.' },
    );
    navigate('/');
  };

  const toggleCapability = (cap: StationCapability) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  // ─── Wizard mode ────────────────────────────────────────────────────────────
  if (isWizard) {
    const steps = buildWizardSteps(capabilities);
    const step = steps[stepIdx];

    // Recalculate steps whenever capabilities change — clamp stepIdx if steps shrunk
    const clampedIdx = Math.min(stepIdx, steps.length - 1);
    if (clampedIdx !== stepIdx) setStepIdx(clampedIdx);

    // Only the name step gates Next; all device/scanner steps are freely skippable
    const canAdvance = step === 'name' ? name.trim().length > 0 : true;

    const visibleRoles = deriveDeviceRoles(capabilities);

    return (
      <Shell subtitle="First-time setup">
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

            {step === 'receipt' && (
              <DeviceStep
                icon={<Printer className="w-6 h-6" />}
                title="Receipt printer"
                subtitle="Optional — skip if this station doesn't need one."
                devices={receiptPrinters}
                selectedId={receiptId}
                onSelect={setReceiptId}
                onClear={() => setReceiptId(undefined)}
                onTest={() => testPrint(deviceById(receiptId))}
                testLabel="Test print"
              />
            )}

            {step === 'kids' && (
              <DeviceStep
                icon={<Baby className="w-6 h-6" />}
                title="Kids bracelet printer"
                subtitle="Optional — skip if this station doesn't print bracelets."
                devices={braceletPrinters}
                selectedId={kidsId}
                onSelect={setKidsId}
                onClear={() => setKidsId(undefined)}
                onTest={() => testPrint(deviceById(kidsId))}
                testLabel="Test print"
              />
            )}

            {step === 'adult' && (
              <DeviceStep
                icon={<User className="w-6 h-6" />}
                title="Adult bracelet printer"
                subtitle="Optional — skip if this station doesn't print adult bracelets."
                devices={braceletPrinters}
                selectedId={adultId}
                onSelect={setAdultId}
                onClear={() => setAdultId(undefined)}
                onTest={() => testPrint(deviceById(adultId))}
                testLabel="Test print"
              />
            )}

            {step === 'kitchen' && (
              <DeviceStep
                icon={<ChefHat className="w-6 h-6" />}
                title="Kitchen printer"
                subtitle="Optional — skip if kitchen tickets print elsewhere."
                devices={kitchenPrinters}
                selectedId={kitchenId}
                onSelect={setKitchenId}
                onClear={() => setKitchenId(undefined)}
                onTest={() => testPrint(deviceById(kitchenId))}
                testLabel="Test print"
              />
            )}

            {step === 'bar' && (
              <DeviceStep
                icon={<GlassWater className="w-6 h-6" />}
                title="Bar printer"
                subtitle="Optional — skip if bar tickets print elsewhere."
                devices={barPrinters}
                selectedId={barId}
                onSelect={setBarId}
                onClear={() => setBarId(undefined)}
                onTest={() => testPrint(deviceById(barId))}
                testLabel="Test print"
              />
            )}

            {step === 'scanner' && (
              <ScannerStep
                isMobile={isMobile}
                mode={scannerMode}
                onModeChange={setScannerMode}
                scanners={scanners}
                scannerId={scannerId}
                onScannerSelect={setScannerId}
              />
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
              <Button size="lg" className="px-8" onClick={() => save(true)}>
                Finish setup
              </Button>
            ) : (
              <Button
                size="lg"
                className="px-8"
                disabled={!canAdvance}
                onClick={() => setStepIdx((i) => Math.min(steps.length - 1, i + 1))}
              >
                {step !== 'capabilities' && step !== 'name' ? 'Skip / Next' : 'Next'}
                <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
            )}
          </div>
        </Card>
      </Shell>
    );
  }

  // ─── Settings mode ─────────────────────────────────────────────────────────
  const visibleRoles = deriveDeviceRoles(capabilities);

  return (
    <Shell subtitle="Station settings">
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

          {/* Device cards — only roles relevant to chosen capabilities */}
          {visibleRoles.includes('receipt') && (
            <DeviceCard
              icon={<Printer className="w-5 h-5" />}
              title="Receipt printer"
              note="Optional — leave unset to skip receipt printing on this station."
              devices={receiptPrinters}
              selectedId={receiptId}
              onSelect={setReceiptId}
              onClear={() => setReceiptId(undefined)}
              onTest={() => testPrint(deviceById(receiptId))}
              testLabel="Test print"
            />
          )}
          {visibleRoles.includes('kids') && (
            <DeviceCard
              icon={<Baby className="w-5 h-5" />}
              title="Kids bracelet printer"
              note="Optional — leave unset to skip kids bracelet printing."
              devices={braceletPrinters}
              selectedId={kidsId}
              onSelect={setKidsId}
              onClear={() => setKidsId(undefined)}
              onTest={() => testPrint(deviceById(kidsId))}
              testLabel="Test print"
            />
          )}
          {visibleRoles.includes('adult') && (
            <DeviceCard
              icon={<User className="w-5 h-5" />}
              title="Adult bracelet printer"
              note="Optional — leave unset to skip adult bracelet printing."
              devices={braceletPrinters}
              selectedId={adultId}
              onSelect={setAdultId}
              onClear={() => setAdultId(undefined)}
              onTest={() => testPrint(deviceById(adultId))}
              testLabel="Test print"
            />
          )}
          {visibleRoles.includes('kitchen') && (
            <DeviceCard
              icon={<ChefHat className="w-5 h-5" />}
              title="Kitchen printer"
              note="Optional — leave unset to skip kitchen ticket printing."
              devices={kitchenPrinters}
              selectedId={kitchenId}
              onSelect={setKitchenId}
              onClear={() => setKitchenId(undefined)}
              onTest={() => testPrint(deviceById(kitchenId))}
              testLabel="Test print"
            />
          )}
          {visibleRoles.includes('bar') && (
            <DeviceCard
              icon={<GlassWater className="w-5 h-5" />}
              title="Bar printer"
              note="Optional — leave unset to skip bar ticket printing."
              devices={barPrinters}
              selectedId={barId}
              onSelect={setBarId}
              onClear={() => setBarId(undefined)}
              onTest={() => testPrint(deviceById(barId))}
              testLabel="Test print"
            />
          )}

          {/* Scanner */}
          <Card className="p-6 bg-card/50">
            <SectionTitle icon={<ScanLine className="w-5 h-5" />} title="Wristband scanner" />
            <div className="mt-4">
              <ScannerStep
                isMobile={isMobile}
                mode={scannerMode}
                onModeChange={setScannerMode}
                scanners={scanners}
                scannerId={scannerId}
                onScannerSelect={setScannerId}
                compact
              />
            </div>
          </Card>

          <div className="flex justify-end">
            <Button size="lg" className="px-8" onClick={() => save(false)}>
              Save changes
            </Button>
          </div>
        </div>
      </ScrollArea>
    </Shell>
  );
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
  mode,
  onModeChange,
  scanners,
  scannerId,
  onScannerSelect,
  compact,
}: {
  isMobile: boolean;
  mode: ScannerMode;
  onModeChange: (m: ScannerMode) => void;
  scanners: import('@/types').Device[];
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
      </div>

      {mode === 'device' && (
        <>
          <NoteLine text="Bluetooth scanners pair in iOS Settings → Bluetooth before they appear here." />
          {scanners.length > 0 ? (
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
    </>
  );

  if (compact) return <div>{content}</div>;

  return (
    <StepWrap icon={<ScanLine className="w-6 h-6" />} title="Wristband scanner">
      {content}
    </StepWrap>
  );
}

function ModeOption({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors flex items-start gap-3',
        active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
      )}
    >
      <div
        className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={cn('font-semibold', active && 'text-primary')}>{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      {active && <Check className="w-5 h-5 text-primary shrink-0 mt-1" />}
    </button>
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
}) {
  const capLabel =
    capabilities.length === 0
      ? 'Does everything'
      : capabilities.map((c) => CAP_META[c].label).join(', ');

  const scannerLabel =
    scannerMode === 'camera'
      ? 'Camera / manual input'
      : deviceById(scannerId)?.label ?? 'Not set';

  const rows: [string, string][] = [
    ['Station', name],
    ['Does', capLabel],
    ...(roles.includes('receipt')
      ? [['Receipt printer', deviceById(receiptId)?.label ?? 'Not set'] as [string, string]]
      : []),
    ...(roles.includes('kids')
      ? [['Kids bracelet', deviceById(kidsId)?.label ?? 'Not set'] as [string, string]]
      : []),
    ...(roles.includes('adult')
      ? [['Adult bracelet', deviceById(adultId)?.label ?? 'Not set'] as [string, string]]
      : []),
    ...(roles.includes('kitchen')
      ? [['Kitchen printer', deviceById(kitchenId)?.label ?? 'Not set'] as [string, string]]
      : []),
    ...(roles.includes('bar')
      ? [['Bar printer', deviceById(barId)?.label ?? 'Not set'] as [string, string]]
      : []),
    ['Scanner', scannerLabel],
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

function Shell({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="shrink-0 flex items-center justify-between px-6 h-16 border-b bg-card/30">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Oto home">
            <img src={logoUrl} alt="Oto" className="h-8 w-auto cursor-pointer" />
          </Link>
          <div className="text-sm text-muted-foreground border-l pl-3">{subtitle}</div>
        </div>
        <Link href="/">
          <Button variant="ghost" size="sm">
            Close
          </Button>
        </Link>
      </div>
      <div className="flex-1 flex flex-col p-6 overflow-hidden">{children}</div>
    </div>
  );
}

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
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  devices: import('@/types').Device[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClear: () => void;
  onTest: () => void;
  testLabel: string;
  note?: string;
}) {
  return (
    <StepWrap icon={icon} title={title}>
      {subtitle && <p className="text-muted-foreground mb-4">{subtitle}</p>}
      {note && <NoteLine text={note} />}
      <DevicePicker devices={devices} selectedId={selectedId} onSelect={onSelect} />
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
  devices: import('@/types').Device[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClear: () => void;
  onTest: () => void;
  testLabel: string;
}) {
  const { icon, title, note, devices, selectedId, onSelect, onClear, onTest, testLabel } = props;
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
      <DevicePicker devices={devices} selectedId={selectedId} onSelect={onSelect} />
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

