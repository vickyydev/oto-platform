import { useRef, useState } from 'react';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { OperatorsPanelWithPorts } from '@oto/admin-screens/lifted/admin/access/OperatorsPanel';
import { organisationApi } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { Drawer } from '@/components/Drawer';
import { ErrorNote, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';

type RenameSelection = {
  id: string;
  name: string;
  version: number;
  refresh: () => Promise<unknown>;
};
export function Operators() {
  const { me, has } = useSession();
  const version = useRef(0);
  const [renaming, setRenaming] = useState<RenameSelection | null>(null);
  if (!me?.isPlatformAdmin || !has('admin:operator:read')) {
    return <PermissionRequired permission="admin:operator:read (platform-wide)" />;
  }
  return (
    <>
      <CommandBar sectionId="operators" />
      <OperatorsPanelWithPorts
        ports={{
          adminApi: organisationApi.adminApi,
          opsApi: organisationApi.opsApi,
          toast: adminToast,
          renderOperatorActions: (operator, refresh) => (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRenaming({ ...operator, refresh, version: ++version.current })}
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
}: {
  selection: RenameSelection;
  onClose: () => void;
}) {
  const [name, setName] = useState(selection.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await organisationApi.adminApi.renameOperator(selection.id, name.trim());
      await selection.refresh();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operator could not be renamed.');
    } finally {
      setSaving(false);
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
