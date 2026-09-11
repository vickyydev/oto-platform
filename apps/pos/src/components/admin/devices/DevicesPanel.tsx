import { useState } from 'react';
import { Pencil, Trash2, Plus, Info, Printer, CreditCard } from 'lucide-react';
import type { Device, EdcTerminal } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DeviceFormDialog } from './DeviceFormDialog';
import { EdcTerminalFormDialog } from './EdcTerminalFormDialog';
import { DEVICE_CONNECTION_LABELS, DEVICE_TYPE_LABELS } from './deviceLabels';

/**
 * Admin editing screen for the branch's hardware: printers/scanners (devices)
 * and card-machine terminals (EDC). Reads the live shared catalog store and
 * writes back through its mutators, so edits flow to the POS in-session —
 * printers appear in Station Setup's picker and EDC terminals in End-of-Day
 * reconciliation channels.
 */
export function DevicesPanel() {
  const { devices, edcTerminals, mutators } = useCatalogStore();

  const [deviceFormOpen, setDeviceFormOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [pendingDeviceDelete, setPendingDeviceDelete] = useState<Device | null>(
    null
  );

  const [edcFormOpen, setEdcFormOpen] = useState(false);
  const [editingEdc, setEditingEdc] = useState<EdcTerminal | null>(null);
  const [pendingEdcDelete, setPendingEdcDelete] = useState<EdcTerminal | null>(
    null
  );

  const openAddDevice = () => {
    setEditingDevice(null);
    setDeviceFormOpen(true);
  };
  const openEditDevice = (device: Device) => {
    setEditingDevice(device);
    setDeviceFormOpen(true);
  };
  const confirmDeviceDelete = () => {
    if (pendingDeviceDelete) mutators.deleteDevice(pendingDeviceDelete.id);
    setPendingDeviceDelete(null);
  };

  const openAddEdc = () => {
    setEditingEdc(null);
    setEdcFormOpen(true);
  };
  const openEditEdc = (terminal: EdcTerminal) => {
    setEditingEdc(terminal);
    setEdcFormOpen(true);
  };
  const confirmEdcDelete = () => {
    if (pendingEdcDelete) mutators.deleteEdcTerminal(pendingEdcDelete.id);
    setPendingEdcDelete(null);
  };

  return (
    <div className="flex flex-col gap-10">
      {/* ───────── Devices ───────── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-foreground/60" />
            <h2 className="text-lg font-bold">Devices</h2>
            <span className="text-sm text-foreground/40">
              ({devices.length})
            </span>
          </div>
          <Button onClick={openAddDevice}>
            <Plus className="w-4 h-4" />
            Add device
          </Button>
        </div>

        {devices.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
            No devices yet. Use “Add device” to create one.
          </div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden md:block overflow-hidden rounded-2xl border border-foreground/10">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Label</TableHead>
                    <TableHead className="w-40">Type</TableHead>
                    <TableHead className="w-32">Connection</TableHead>
                    <TableHead className="w-40">Address</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {devices.map((device) => (
                    <TableRow key={device.id}>
                      <TableCell className="font-medium">
                        {device.label}
                      </TableCell>
                      <TableCell className="text-foreground/70">
                        {DEVICE_TYPE_LABELS[device.type]}
                      </TableCell>
                      <TableCell className="text-foreground/70">
                        {DEVICE_CONNECTION_LABELS[device.connection]}
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground/70">
                        {device.connection === 'network'
                          ? device.address ?? '—'
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => openEditDevice(device)}
                            aria-label={`Edit ${device.label}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setPendingDeviceDelete(device)}
                            aria-label={`Delete ${device.label}`}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: stacked cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{device.label}</div>
                    <div className="text-sm text-foreground/60">
                      {DEVICE_TYPE_LABELS[device.type]} ·{' '}
                      {DEVICE_CONNECTION_LABELS[device.connection]}
                    </div>
                    {device.connection === 'network' && device.address && (
                      <div className="text-xs tabular-nums text-foreground/40">
                        {device.address}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => openEditDevice(device)}
                      aria-label={`Edit ${device.label}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPendingDeviceDelete(device)}
                      aria-label={`Delete ${device.label}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ───────── EDC terminals ───────── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-foreground/60" />
            <h2 className="text-lg font-bold">EDC terminals</h2>
            <span className="text-sm text-foreground/40">
              ({edcTerminals.length})
            </span>
          </div>
          <Button onClick={openAddEdc}>
            <Plus className="w-4 h-4" />
            Add EDC terminal
          </Button>
        </div>

        {edcTerminals.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
            No EDC terminals yet. Use “Add EDC terminal” to create one.
          </div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden md:block overflow-hidden rounded-2xl border border-foreground/10">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-48">TID</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {edcTerminals.map((terminal) => (
                    <TableRow key={terminal.id}>
                      <TableCell className="font-mono text-sm tabular-nums">
                        {terminal.tid}
                      </TableCell>
                      <TableCell className="font-medium">
                        {terminal.label}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => openEditEdc(terminal)}
                            aria-label={`Edit ${terminal.label}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setPendingEdcDelete(terminal)}
                            aria-label={`Delete ${terminal.label}`}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: stacked cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {edcTerminals.map((terminal) => (
                <div
                  key={terminal.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{terminal.label}</div>
                    <div className="font-mono text-sm tabular-nums text-foreground/60">
                      {terminal.tid}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => openEditEdc(terminal)}
                      aria-label={`Edit ${terminal.label}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPendingEdcDelete(terminal)}
                      aria-label={`Delete ${terminal.label}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes are kept in memory for this prototype and reset on page reload.
      </p>

      {/* Forms */}
      <DeviceFormDialog
        open={deviceFormOpen}
        device={editingDevice}
        onOpenChange={setDeviceFormOpen}
        onSave={mutators.upsertDevice}
      />
      <EdcTerminalFormDialog
        open={edcFormOpen}
        terminal={editingEdc}
        onOpenChange={setEdcFormOpen}
        onSave={mutators.upsertEdcTerminal}
      />

      {/* Delete confirmations */}
      <AlertDialog
        open={pendingDeviceDelete !== null}
        onOpenChange={(open) => !open && setPendingDeviceDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete device?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeviceDelete
                ? `“${pendingDeviceDelete.label}” will be removed and no longer selectable in Station Setup.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeviceDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingEdcDelete !== null}
        onOpenChange={(open) => !open && setPendingEdcDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete EDC terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingEdcDelete
                ? `“${pendingEdcDelete.label}” (${pendingEdcDelete.tid}) will be removed and no longer appear in End-of-Day reconciliation.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmEdcDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
