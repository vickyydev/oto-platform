import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Pencil, Plus, RefreshCw, Route, Users } from 'lucide-react';
import { ApiError, idemKey } from '@/api/client';
import {
  inboxRoutingApi, type RoutingRule, type RoutingRules, type RoutingTeam, type RoutingTeams,
  type RuleCreate, type RulePatch, type TeamCreate, type TeamPatch,
} from '@/api/inbox-routing';
import { useSession } from '@/auth/SessionContext';
import type { EffectivePermission } from '@/api/platform';
import { Drawer } from '@/components/Drawer';
import { CheckRow, Field, NumberInput, Select, TextInput } from '@/components/Form';
import { SelectFilter } from '@/components/Filters';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Tag } from '@/components/redesign/chips';
import { Button } from '@/components/ui/button';

type Directory = RoutingTeams & RoutingRules;
type TeamIdentity = { key: TeamCreate['key']; branchId: string | null; label: string };
type Selection = { kind: 'team'; team: RoutingTeam | null } |
  { kind: 'rule'; rule: RoutingRule | null } | { kind: 'archive'; rule: RoutingRule };
type Intent = { kind: 'create-team'; body: TeamCreate } | { kind: 'edit-team'; id: string; body: TeamPatch } |
  { kind: 'create-rule'; body: RuleCreate } | { kind: 'edit-rule'; id: string; body: RulePatch } |
  { kind: 'archive-rule'; id: string };

function hasTarget(permissions: EffectivePermission[], operatorId: string, branchId: string | null) {
  return permissions.some(grant => grant.permission === 'inbox:routing:manage' && (
    grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === operatorId) ||
    branchId !== null && grant.scopeType === 'branch' && grant.scopeId === branchId
  ));
}

/** Actor, grants, seating and lock own the complete editor lifetime. */
export function TeamsRouting() {
  const working = useWorkingAuthority();
  const { me, permissions, locked } = useSession();
  const authority = JSON.stringify([working.epoch, me?.operatorContext, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.branch?.id, locked,
    permissions.map(grant => [grant.permission, grant.scopeType, grant.scopeId]).sort()]);
  const lifetime = useRef({ key: authority, epoch: 0 });
  if (lifetime.current.key !== authority) lifetime.current = { key: authority, epoch: lifetime.current.epoch + 1 };
  const authorityEpoch = lifetime.current.epoch;
  const isCurrent = useCallback(() => working.isCurrent() && lifetime.current.epoch === authorityEpoch, [authorityEpoch, working.isCurrent]);
  const allowed = !!me && permissions.some(grant => grant.permission === 'inbox:routing:manage' && (
    grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === me.operatorContext.effectiveOperatorId) ||
    grant.scopeType === 'branch' && grant.scopeId !== null
  ));
  if (!me || !allowed || locked) return <PermissionRequired permission="inbox:routing:manage" />;
  return <RoutingHost key={authority} isCurrent={isCurrent} canAt={branchId => hasTarget(permissions, me.operatorContext.effectiveOperatorId, branchId)} />;
}

function RoutingHost({ canAt, isCurrent }: { canAt: (branchId: string | null) => boolean; isCurrent: () => boolean }) {
  const working = useWorkingAuthority();
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState('all');
  const [archived, setArchived] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const key = JSON.stringify([scope, archived, refresh]);
  const owner = useRef({ key, epoch: 0 });
  if (owner.current.key !== key) owner.current = { key, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const [result, setResult] = useState<{ epoch: number; data: Directory | null; error: string | null } | null>(null);
  const data = result?.epoch === epoch ? result.data : null;
  const error = result?.epoch === epoch ? result.error : null;
  useEffect(() => {
    let live = true;
    void working.run(() => Promise.all([inboxRoutingApi.teams(), inboxRoutingApi.rules()])).then(([teams, rules]) => {
      if (live && isCurrent() && owner.current.epoch === epoch) setResult({ epoch, data: { ...teams, ...rules }, error: null });
    }).catch((failure: unknown) => {
      if (live && isCurrent() && owner.current.epoch === epoch) setResult({ epoch, data: null,
        error: message(failure, 'Teams and routing could not be read.') });
    });
    return () => { live = false; };
  }, [epoch, isCurrent, working.run]);
  const reload = () => setRefresh(value => value + 1);
  const selectScope = (value: string) => { setSelection(null); setScope(value || 'all'); };
  return <>
    <CommandBar sectionId="teams-routing" actions={<Button variant="outline" onClick={reload} disabled={selection !== null}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
    </Button>} />
    <fieldset disabled={selection !== null} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
      <TeamsRoutingContent data={data} metadata={result?.data ?? null} error={error} scope={scope} archived={archived} canAt={canAt}
        onScope={selectScope} onArchived={value => { setSelection(null); setArchived(value); }}
        onRetry={reload} onSelect={setSelection} />
    </fieldset>
    {selection && data && <RoutingEditor key={JSON.stringify(selection)} selection={selection} directory={data} isCurrent={isCurrent}
      onClose={() => setSelection(null)} onSaved={() => { setSelection(null); reload(); }} />}
  </>;
}

const OPERATOR_WIDE_TEAM_LABEL = { birthdays: 'Birthdays & events', marketing: 'Marketing', gm: 'GM' } as const;

export function missingTeamIdentities(data: RoutingTeams): TeamIdentity[] {
  const held = (key: TeamCreate['key'], branchId: string | null) =>
    data.teamReferences.some(team => team.key === key && team.branchId === branchId);
  return [
    // `gm`: the playbook's GM team (SCRUM-220), operator-wide like Birthdays & events and Marketing.
    ...(data.operatorWide ? (['birthdays', 'marketing', 'gm'] as const).filter(key => !held(key, null))
      .map(key => ({ key, branchId: null, label: `${OPERATOR_WIDE_TEAM_LABEL[key]} · Operator-wide` })) : []),
    ...data.branches.filter(branch => !held('reception', branch.id))
      .map(branch => ({ key: 'reception' as const, branchId: branch.id, label: `Reception · ${branch.name}` })),
  ];
}

export function TeamsRoutingContent({ data, metadata = null, error, scope, archived, canAt, onScope, onArchived, onRetry, onSelect }: {
  data: Directory | null; error: string | null; scope: string; archived: boolean;
  metadata?: RoutingTeams | null;
  canAt: (branchId: string | null) => boolean;
  onScope: (value: string) => void; onArchived: (value: boolean) => void;
  onRetry: () => void; onSelect: (selection: Selection) => void;
}) {
  const choices = data ?? metadata;
  const filters = choices && <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
    <SelectFilter label="Routing scope" value={scope === 'all' ? '' : scope} onChange={onScope} anyLabel="All accessible scopes"
      options={[...(choices.operatorWide ? [{ value: 'operator', label: 'Operator-wide' }] : []),
        ...choices.branches.map(branch => ({ value: branch.id, label: branch.name }))]} />
    <CheckRow label="Show archived routing rules" checked={archived} onChange={onArchived} />
  </div>;
  if (error) return <>{filters}<div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div></>;
  if (!data) return <>{filters}<div role="status"><Loading what="teams and routing" /></div></>;
  const matches = (branchId: string | null) => scope === 'all' || (scope === 'operator' ? branchId === null : branchId === scope);
  const teams = data.teams.filter(team => matches(team.branchId));
  const rules = data.rules.filter(rule => matches(rule.branchId) && (archived ? rule.archivedAt !== null : rule.archivedAt === null));
  const missing = missingTeamIdentities(data).filter(identity => canAt(identity.branchId));
  return <>
    {filters}
    <CardShell title="Teams" icon={Users} note="existing system teams"
      actions={<Button variant="outline" disabled={!missing.length} onClick={() => onSelect({ kind: 'team', team: null })}>
        <Plus className="h-4 w-4" aria-hidden="true" /> Create missing team
      </Button>}>
      <p className="text-sm text-muted-foreground">Teams are retained by the system. Edit their details or archive routing rules; teams cannot be deleted. Team membership follows the linked department's Inbox role assignments.</p>
      {!missing.length && <p className="text-xs text-muted-foreground">All system team identities in your reach already exist.</p>}
      {!teams.length ? <EmptyNote title="No teams in this scope" detail="Choose another accessible scope to see its teams." /> :
        <StripedList label="Teams">{teams.map(team => <li key={team.id} className="min-w-0 p-3 @2xl:p-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><h3 className="font-bold break-words [overflow-wrap:anywhere]">{team.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground break-words">{team.branchName ?? 'Operator-wide'} · {team.key}</p></div>
            <Button size="sm" variant="outline" disabled={!canAt(team.branchId)} onClick={() => onSelect({ kind: 'team', team })}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit team
            </Button>
          </div>
          <dl className="mt-3 grid min-w-0 gap-2 text-sm @2xl:grid-cols-3">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Department</dt><dd className="break-words">{team.departmentName ?? 'No linked department'}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Colour</dt><dd className="break-words">{team.colour}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Order</dt><dd>{team.sortOrder}</dd></div>
          </dl>
        </li>)}</StripedList>}
    </CardShell>
    <CardShell title="Routing rules" icon={Route} note={archived ? 'archived history' : 'current rules'}
      actions={<Button variant="outline" disabled={!data.teamReferences.length || (!data.operatorWide && !data.branches.length)}
        onClick={() => onSelect({ kind: 'rule', rule: null })}><Plus className="h-4 w-4" aria-hidden="true" /> Add routing rule</Button>}>
      <p className="text-sm text-muted-foreground">Highest priority wins, then the more specific language and park, then the oldest rule and its ID. Any language and Any park are wildcards. Team fallback stays in place when no rule matches or a named person is unavailable.</p>
      <p className="text-xs text-muted-foreground">Changes apply when routing runs. Saving or archiving a rule does not reassign existing conversations.</p>
      {!rules.length ? <EmptyNote title={archived ? 'No archived rules in this scope' : 'No routing rules in this scope'}
        detail="The existing team fallback remains available. Choose another scope or add an explicit rule." /> :
        <StripedList label="Routing rules">{rules.map(rule => <li key={rule.id} className="min-w-0 p-3 @2xl:p-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><h3 className="font-bold break-words">{categoryLabel(rule.category)} · {rule.teamName ?? 'Unavailable team'}</h3>
              <p className="mt-1 text-sm text-muted-foreground break-words">{rule.branchName ?? 'Any park'} · {rule.language ?? 'Any language'} · Priority {rule.priority}</p>
            </div>
            <Tag>{rule.archivedAt ? 'Archived' : rule.active ? 'Active' : 'Inactive'}</Tag>
          </div>
          <dl className="mt-3 grid min-w-0 gap-2 text-sm @2xl:grid-cols-2">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Primary</dt><dd className="break-words">{rule.primaryKind === 'team' ? 'The team' : rule.primaryAccountName ?? 'Unavailable person · team fallback'}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Backup</dt><dd className="break-words">{rule.backupAccountName ?? 'None'}{rule.backupAccountId && rule.autoAddBackup ? ' · added from the first message' : ''}</dd></div>
          </dl>
          {!rule.archivedAt && <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canAt(rule.branchId)} onClick={() => onSelect({ kind: 'rule', rule })}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit rule</Button>
            <Button size="sm" variant="outline" disabled={!canAt(rule.branchId)} onClick={() => onSelect({ kind: 'archive', rule })}><Archive className="h-3.5 w-3.5" aria-hidden="true" /> Archive rule</Button>
          </div>}
        </li>)}</StripedList>}
    </CardShell>
  </>;
}

function categoryLabel(category: RuleCreate['category']) {
  return { birthdays: 'Birthdays & events', general: 'General enquiries', marketing: 'Marketing', gm: 'GM' }[category];
}

async function perform(intent: Intent, key: string) {
  if (intent.kind === 'create-team') return inboxRoutingApi.createTeam(intent.body, key);
  if (intent.kind === 'edit-team') return inboxRoutingApi.editTeam(intent.id, intent.body, key);
  if (intent.kind === 'create-rule') return inboxRoutingApi.createRule(intent.body, key);
  if (intent.kind === 'edit-rule') return inboxRoutingApi.editRule(intent.id, intent.body, key);
  return inboxRoutingApi.archiveRule(intent.id, key);
}

/** An uncertain reply retains the exact intent and key; edits cannot alter a retry. */
function useRoutingWrite(onSaved: () => void, isCurrent: () => boolean) {
  const working = useWorkingAuthority();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const pending = useRef<{ intent: Intent; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (intent: Intent) => {
    if (!working.isCurrent() || !mounted.current || !isCurrent() || inFlight.current) return;
    pending.current ??= { intent: structuredClone(intent), key: idemKey() };
    const held = pending.current;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await working.run(() => perform(held.intent, held.key));
      if (!working.isCurrent() || !mounted.current || !isCurrent()) return;
      pending.current = null; setUncertain(false); onSaved();
    } catch (failure) {
      if (!working.isCurrent() || !mounted.current || !isCurrent()) return;
      const definite = failure instanceof ApiError && failure.status < 500 &&
        ![408, 429].includes(failure.status) && failure.code !== 'IDEMPOTENCY_IN_FLIGHT';
      if (definite) pending.current = null;
      setUncertain(!definite);
      setError(message(failure, 'The save did not return a confirmed result.'));
    } finally {
      inFlight.current = false;
      if (working.isCurrent() && mounted.current && isCurrent()) setBusy(false);
    }
  };
  return { save, busy, uncertain, error, disabled: busy || uncertain };
}

function WriteStatus({ write }: { write: ReturnType<typeof useRoutingWrite> }) {
  return <>{write.error && <div role="alert"><ErrorNote message={write.error} /></div>}
    {write.uncertain && <p role="status" className="text-sm text-muted-foreground">The result is uncertain. Retry this same change to check its result before editing or closing. The retry uses the original request.</p>}</>;
}

function RoutingEditor({ selection, directory, onClose, onSaved, isCurrent }: {
  selection: Selection; directory: Directory; onClose: () => void; onSaved: () => void; isCurrent: () => boolean;
}) {
  if (selection.kind === 'team') return <TeamEditor team={selection.team} directory={directory} onClose={onClose} onSaved={onSaved} isCurrent={isCurrent} />;
  if (selection.kind === 'rule') return <RuleEditor rule={selection.rule} directory={directory} onClose={onClose} onSaved={onSaved} isCurrent={isCurrent} />;
  return <ArchiveRule rule={selection.rule} onClose={onClose} onSaved={onSaved} isCurrent={isCurrent} />;
}

function TeamEditor({ team, directory, onClose, onSaved, isCurrent }: {
  team: RoutingTeam | null; directory: Directory; onClose: () => void; onSaved: () => void; isCurrent: () => boolean;
}) {
  const missing = missingTeamIdentities(directory);
  const [identity, setIdentity] = useState(0);
  const [name, setName] = useState(team?.name ?? '');
  const [colour, setColour] = useState(team?.colour ?? '');
  const [sortOrder, setSortOrder] = useState<number | null>(team?.sortOrder ?? 0);
  const [departmentId, setDepartmentId] = useState(team?.departmentId ?? '');
  const write = useRoutingWrite(onSaved, isCurrent);
  const chosen = missing[identity];
  const branchId = team ? team.branchId : chosen?.branchId ?? null;
  const valid = !!name.trim() && !!colour.trim() && pgInteger(sortOrder) && (team !== null || !!chosen);
  const body: TeamPatch = { name: name.trim(), colour: colour.trim(), sortOrder: sortOrder ?? 0, departmentId: departmentId || null };
  const save = () => {
    if (!valid) return;
    if (team) void write.save({ kind: 'edit-team', id: team.id, body });
    else if (chosen) void write.save({ kind: 'create-team', body: { ...body, name: name.trim(), colour: colour.trim(), key: chosen.key, branchId: chosen.branchId } });
  };
  return <Drawer title={team ? 'Edit team' : 'Create missing team'} subtitle={team?.name}
    onClose={() => { if (!write.disabled) onClose(); }} footer={<div className="flex flex-wrap gap-2">
      <Button onClick={save} disabled={write.busy || (!write.uncertain && !valid)}>{write.busy ? 'Saving…' : write.uncertain ? 'Retry same save' : 'Save team'}</Button>
      <Button variant="outline" disabled={write.disabled} onClick={onClose}>Cancel</Button>
    </div>}>
    <WriteStatus write={write} />
    {team ? <p className="text-sm text-muted-foreground">System identity: {team.key} · {team.branchName ?? 'Operator-wide'}. The key and park stay fixed.</p> :
      <Field label="System team identity"><Select value={String(identity)} disabled={write.disabled} onChange={value => { setIdentity(Number(value)); setDepartmentId(''); }}
        options={missing.map((option, index) => ({ value: String(index), label: option.label }))} /></Field>}
    <Field label="Team name"><TextInput value={name} onChange={setName} disabled={write.disabled} /></Field>
    <Field label="Colour" hint="Keep the existing colour label or value used by Inbox."><TextInput value={colour} onChange={setColour} disabled={write.disabled} /></Field>
    <Field label="Sort order"><NumberInput value={sortOrder} onChange={setSortOrder} disabled={write.disabled} /></Field>
    <Field label="Department" hint="People join through Inbox role assignments for this department."><Select value={departmentId} onChange={setDepartmentId} disabled={write.disabled}
      placeholder="No linked department" options={directory.departments.filter(department => department.branchId === null || branchId !== null && department.branchId === branchId)
        .map(department => ({ value: department.id, label: department.name }))} /></Field>
  </Drawer>;
}

function RuleEditor({ rule, directory, onClose, onSaved, isCurrent }: {
  rule: RoutingRule | null; directory: Directory; onClose: () => void; onSaved: () => void; isCurrent: () => boolean;
}) {
  const [teamId, setTeamId] = useState(rule?.teamId ?? directory.teamReferences[0]?.id ?? '');
  const [category, setCategory] = useState<RuleCreate['category']>(rule?.category ?? 'general');
  const [language, setLanguage] = useState(rule?.language ?? '');
  const [branchId, setBranchId] = useState(rule ? rule.branchId ?? '' : directory.operatorWide ? '' : directory.branches[0]?.id ?? '');
  const [primaryKind, setPrimaryKind] = useState<RuleCreate['primaryKind']>(rule?.primaryKind ?? 'team');
  const [primaryAccountId, setPrimaryAccountId] = useState(rule?.primaryAccountId ?? '');
  const [backupAccountId, setBackupAccountId] = useState(rule?.backupAccountId ?? '');
  const [autoAddBackup, setAutoAddBackup] = useState(rule?.autoAddBackup ?? true);
  const [priority, setPriority] = useState<number | null>(rule?.priority ?? 0);
  const [active, setActive] = useState(rule?.active ?? true);
  const write = useRoutingWrite(onSaved, isCurrent);
  const valid = !!teamId && pgInteger(priority) && (directory.operatorWide || !!branchId) &&
    (primaryKind === 'team' || !!primaryAccountId) && !(primaryKind === 'account' && primaryAccountId === backupAccountId);
  const body: RuleCreate = { teamId, category, language: language.trim() || null, branchId: branchId || null,
    primaryKind, primaryAccountId: primaryKind === 'account' ? primaryAccountId || null : null,
    backupAccountId: backupAccountId || null, autoAddBackup, priority: priority ?? 0, active };
  const save = () => {
    if (!valid) return;
    void write.save(rule ? { kind: 'edit-rule', id: rule.id, body } : { kind: 'create-rule', body });
  };
  const people = directory.accounts.map(account => ({ value: account.id, label: `${account.displayName}${account.status === 'active' ? '' : ` · ${account.status}`}` }));
  return <Drawer title={rule ? 'Edit routing rule' : 'Add routing rule'} subtitle="Changes do not reassign existing conversations."
    onClose={() => { if (!write.disabled) onClose(); }} footer={<div className="flex flex-wrap gap-2">
      <Button onClick={save} disabled={write.busy || (!write.uncertain && !valid)}>{write.busy ? 'Saving…' : write.uncertain ? 'Retry same save' : 'Save routing rule'}</Button>
      <Button variant="outline" disabled={write.disabled} onClick={onClose}>Cancel</Button>
    </div>}>
    <WriteStatus write={write} />
    <Field label="Team"><Select value={teamId} onChange={setTeamId} disabled={write.disabled} placeholder="Choose a team"
      options={directory.teamReferences.map(team => ({ value: team.id, label: `${team.name} · ${team.branchId === null ? 'Operator-wide' : directory.branches.find(branch => branch.id === team.branchId)?.name ?? 'Park team'}` }))} /></Field>
    <Field label="Category"><Select value={category} onChange={value => setCategory(value as RuleCreate['category'])} disabled={write.disabled}
      options={(['birthdays', 'general', 'marketing', 'gm'] as const).map(value => ({ value, label: categoryLabel(value) }))} /></Field>
    <Field label="Language" hint="Leave blank for any language. Existing language text is retained; matching ignores case."><TextInput value={language} onChange={setLanguage} disabled={write.disabled} /></Field>
    <Field label="Park" hint="Any park is an operator-wide wildcard."><Select value={branchId} onChange={setBranchId} disabled={write.disabled}
      placeholder={directory.operatorWide ? 'Any park' : undefined} options={directory.branches.map(branch => ({ value: branch.id, label: branch.name }))} /></Field>
    <Field label="Primary"><Select value={primaryKind} onChange={value => { setPrimaryKind(value as RuleCreate['primaryKind']); if (value === 'team') setPrimaryAccountId(''); }} disabled={write.disabled}
      options={[{ value: 'team', label: 'The team' }, { value: 'account', label: 'A named person' }]} /></Field>
    {primaryKind === 'account' && <Field label="Primary person"><Select value={primaryAccountId} onChange={setPrimaryAccountId} disabled={write.disabled} placeholder="Choose a person" options={people} /></Field>}
    <Field label="Backup person" hint="An unavailable person is not added; existing team fallback is preserved."><Select value={backupAccountId} onChange={setBackupAccountId} disabled={write.disabled} placeholder="No backup" options={people} /></Field>
    {primaryKind === 'account' && primaryAccountId && primaryAccountId === backupAccountId && <p role="alert" className="text-sm text-destructive">Primary and backup must be different people.</p>}
    <CheckRow checked={autoAddBackup} onChange={setAutoAddBackup} disabled={write.disabled} label="Add backup from the first message" />
    <Field label="Priority" hint="Higher numbers win. Existing negative priorities remain valid."><NumberInput value={priority} onChange={setPriority} disabled={write.disabled} /></Field>
    <CheckRow checked={active} onChange={setActive} disabled={write.disabled} label="Active rule" />
  </Drawer>;
}

function ArchiveRule({ rule, onClose, onSaved, isCurrent }: { rule: RoutingRule; onClose: () => void; onSaved: () => void; isCurrent: () => boolean }) {
  const write = useRoutingWrite(onSaved, isCurrent);
  return <Drawer title="Archive routing rule" subtitle={`${categoryLabel(rule.category)} · ${rule.teamName ?? 'Unavailable team'}`}
    onClose={() => { if (!write.disabled) onClose(); }} footer={<div className="flex flex-wrap gap-2">
      <Button variant="destructive" disabled={write.busy} onClick={() => void write.save({ kind: 'archive-rule', id: rule.id })}>
        {write.busy ? 'Archiving…' : write.uncertain ? 'Retry same archive' : 'Confirm archive'}
      </Button><Button variant="outline" disabled={write.disabled} onClick={onClose}>Cancel</Button>
    </div>}>
    <WriteStatus write={write} />
    <p className="text-sm">This rule will stop matching new routing decisions and remain in archived history. Existing conversations keep their assignments. The team's existing fallback remains.</p>
  </Drawer>;
}

function pgInteger(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}
function message(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

export default TeamsRouting;
