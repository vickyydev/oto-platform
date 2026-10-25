import { useMemo, useRef, useState } from 'react';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { OperatorsPanelWithPorts } from '@oto/admin-screens/lifted/admin/access/OperatorsPanel';
import { organisationApi } from '@/api/organisation';
import { Drawer } from '@/components/Drawer';
import { ErrorNote, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { usePlatformAuthority } from '@/lib/platformAuthority';

type RenameSelection = {
  id: string;
  name: string;
  version: number;
  refresh: () => Promise<unknown>;
};
export function Operators({ sectionId = 'operators' }: { sectionId?: string }) {
  const authority = usePlatformAuthority('admin:operator:read');
  if (!authority.allowed) return <PermissionRequired permission="admin:operator:read (platform-wide)" />;
  return <OperatorsContent key={authority.key} sectionId={sectionId} isCurrent={authority.isCurrent} />;
}

function OperatorsContent({ sectionId, isCurrent }: { sectionId: string; isCurrent: () => boolean }) {
  const version = useRef(0);
  const [renaming, setRenaming] = useState<RenameSelection | null>(null);
  // Reuse every native control and body. A retained native callback must not
  // dispatch its next request under a different session or refresh epoch.
  const guarded = useMemo(() => {
    const check = () => { if (!isCurrent()) throw new Error('The signed-in account changed. Open this page again.'); };
    const call = async <T,>(run: () => Promise<T>) => { check(); const answer = await run(); check(); return answer; };
    const admin = organisationApi.adminApi;
    const ops = organisationApi.opsApi;
    return {
      adminApi: {
        operators: () => call(() => admin.operators()),
        createOperator: (...args: Parameters<typeof admin.createOperator>) => call(() => admin.createOperator(...args)),
        archiveOperator: (...args: Parameters<typeof admin.archiveOperator>) => call(() => admin.archiveOperator(...args)),
        assignOperatorAdmin: (...args: Parameters<typeof admin.assignOperatorAdmin>) => call(() => admin.assignOperatorAdmin(...args)),
      },
      opsApi: {
        demoResetStatus: () => call(() => ops.demoResetStatus()),
        demoReset: (...args: Parameters<typeof ops.demoReset>) => call(() => ops.demoReset(...args)),
      },
      rename: (...args: Parameters<typeof admin.renameOperator>) => call(() => admin.renameOperator(...args)),
    };
  }, [isCurrent]);
  return (
    <>
      <CommandBar sectionId={sectionId} />
      <OperatorsPanelWithPorts
        ports={{
          adminApi: guarded.adminApi,
          opsApi: guarded.opsApi,
          toast: (...args) => { if (isCurrent()) adminToast(...args); },
          renderOperatorActions: (operator, refresh) => (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { if (isCurrent()) setRenaming({ ...operator, refresh, version: ++version.current }); }}
            >
              Rename
            </Button>
          ),
        }}
      />
      {renaming && (
        <RenameOperator
          key={renaming.version}
          selection={renaming}
          isCurrent={isCurrent}
          rename={guarded.rename}
          onClose={() =>
            setRenaming((current) => (current?.version === renaming.version ? null : current))
          }
        />
      )}
      <AdminNotifications />
    </>
  );
}
function RenameOperator({
  selection,
  onClose,
  isCurrent,
  rename,
}: {
  selection: RenameSelection;
  onClose: () => void;
  isCurrent: () => boolean;
  rename: typeof organisationApi.adminApi.renameOperator;
}) {
  const [name, setName] = useState(selection.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (saving || !name.trim() || !isCurrent()) return;
    setSaving(true);
    setError(null);
    try {
      await rename(selection.id, name.trim());
      if (!isCurrent()) return;
      await selection.refresh();
      if (!isCurrent()) return;
      onClose();
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : 'The operator could not be renamed.');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <Drawer
      title="Rename operator"
      subtitle={selection.name}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button disabled={saving || !name.trim()} onClick={() => void save()}>
            Save name
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert">
          <ErrorNote message={error} />
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Operator name
        <input
          className="w-full min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </Drawer>
  );
}
