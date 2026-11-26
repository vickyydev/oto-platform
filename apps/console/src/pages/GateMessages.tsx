import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw, Save, X } from 'lucide-react';
import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_CASE_INFO,
  GATE_MESSAGE_LABELS,
  GATE_MESSAGE_LABEL_INFO,
  GATE_MESSAGE_LABEL_MAX,
  GATE_MESSAGE_LANGS,
  GATE_MESSAGE_LANG_NAMES,
  GATE_MESSAGE_TEXT_MAX,
  GATE_READER_SCREEN,
  composeGateScreen,
  defaultGateMessages,
  previewGateScreen,
  type GateMessageCase,
  type GateMessageLabel,
  type GateMessageLang,
  type GateMessageTexts,
  type GateScreenFacts,
} from '@oto/shared';
import { ApiError, idemKey } from '@/api/client';
import { gateMessagesApi, type GateMessagesRead, type GateMessagesWrite } from '@/api/gate-messages';
import { organisationApi, type OrganisationBranch } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { Field, TextInput } from '@/components/Form';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip, StatusChip, Tag } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { useWorkingAuthority } from '@/lib/workingAuthority';
import { cn } from '@/lib/utils';

/**
 * SCRUM-1078 — what the gate readers at one park say, per case and language.
 *
 * The preview is drawn by `composeGateScreen` in `@oto/shared`, the same
 * function the gate box lays a reply out with, so what is shown here is what
 * the reader is sent. Wording only: nothing on this page decides whether a
 * gate opens.
 */

type Texts = GateMessagesRead['texts'];

/** The api's answer as the shared shape, every case and label in every language. */
function toTexts(from: Texts): GateMessageTexts {
  const out = defaultGateMessages();
  out.languages = from.languages.length ? [...from.languages] : out.languages;
  const cases = from.cases as Partial<Record<GateMessageCase, Partial<Record<GateMessageLang, string>>>>;
  const labels = from.labels as Partial<Record<GateMessageLabel, Partial<Record<GateMessageLang, string>>>>;
  for (const key of GATE_MESSAGE_CASES) {
    for (const lang of GATE_MESSAGE_LANGS) out.cases[key][lang] = cases[key]?.[lang] ?? '';
  }
  for (const key of GATE_MESSAGE_LABELS) {
    for (const lang of GATE_MESSAGE_LANGS) out.labels[key][lang] = labels[key]?.[lang] ?? '';
  }
  return out;
}

/** A fixed afternoon at the park: 16:10 in Bangkok, the band's play ending at 17:30. */
const SAMPLE_NOW = Date.parse('2026-11-26T09:10:00Z');
function sampleFacts(key: GateMessageCase): GateScreenFacts {
  return {
    kind: 'adult',
    ticketLabel: '2 Hours Play',
    timezone: 'Asia/Bangkok',
    now: SAMPLE_NOW,
    validUntil: SAMPLE_NOW + (key === 'OVER_TIME' ? -20 : 80) * 60_000,
    creditSatang: 35_000,
  };
}

const TEXTAREA =
  'w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';

const sameText = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function GateMessages() {
  const { me, has } = useSession();
  const working = useWorkingAuthority();
  const allowed = has('admin:gate_message:read');
  const canEdit = has('admin:gate_message:manage');
  const [branches, setBranches] = useState<OrganisationBranch[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [branchError, setBranchError] = useState<string | null>(null);
  const [data, setData] = useState<GateMessagesRead | null>(null);
  const [draft, setDraft] = useState<GateMessageTexts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<GateMessageCase>('welcome');
  const [caseLang, setCaseLang] = useState<Partial<Record<GateMessageCase, GateMessageLang>>>({});
  const request = useRef(0);
  /** The save in flight or left uncertain: a retry of the same body reuses its key. */
  const pending = useRef<{ branchId: string; body: GateMessagesWrite; key: string } | null>(null);

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
        if (active) setBranchError(failure instanceof Error ? failure.message : 'The parks could not be read.');
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
      const answer = await working.run(() => gateMessagesApi.read(branchId));
      if (current !== request.current) return;
      setData(answer);
      setDraft(toTexts(answer.texts));
    } catch (failure) {
      if (current !== request.current) return;
      setData(null);
      setDraft(null);
      setError(failure instanceof Error ? failure.message : 'The gate messages could not be read.');
    }
  }, [branchId, working.run]);

  useEffect(() => {
    if (!allowed || !branchId) return;
    setData(null);
    setDraft(null);
    setSaved(false);
    setSaveError(null);
    pending.current = null;
    void reload();
    return () => {
      request.current++;
    };
  }, [allowed, branchId, reload]);

  const loaded = useMemo(() => (data ? toTexts(data.texts) : null), [data]);
  const defaults = useMemo(() => (data ? toTexts(data.defaults) : defaultGateMessages()), [data]);
  const dirty = !!draft && !!loaded && !sameText(draft, loaded);
  const editable = canEdit && !busy;

  const edit = (change: (next: GateMessageTexts) => void) => {
    if (!editable) return;
    setSaved(false);
    setDraft((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      change(next);
      return next;
    });
  };

  const save = async () => {
    if (!draft || !dirty || !editable || !branchId) return;
    const body: GateMessagesWrite = { languages: draft.languages, cases: draft.cases, labels: draft.labels };
    const held =
      pending.current && pending.current.branchId === branchId && sameText(pending.current.body, body)
        ? pending.current
        : { branchId, body, key: idemKey() };
    pending.current = held;
    const current = request.current;
    setBusy(true);
    setSaveError(null);
    try {
      const answer = await working.run(() => gateMessagesApi.save(held.branchId, held.body, held.key));
      pending.current = null;
      if (current !== request.current) return;
      setData(answer);
      setDraft(toTexts(answer.texts));
      setSaved(true);
    } catch (failure) {
      // A refusal the api answered is final; anything else may have saved, so a retry reuses the key.
      const definite = failure instanceof ApiError && failure.status < 500 && ![408, 429].includes(failure.status);
      if (definite) pending.current = null;
      if (current === request.current) {
        setSaveError(
          (failure instanceof Error ? failure.message : 'The save did not return a confirmed result.') +
            (definite ? '' : ' Press Save again to check whether it went through.'),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) return <PermissionRequired permission="admin:gate_message:read" />;

  const selectedName = branches?.find((row) => row.id === branchId)?.name ?? null;
  return (
    <>
      <CommandBar
        sectionId="gate-messages"
        place={selectedName}
        actions={
          branches && branches.length > 0 ? (
            <SelectChip
              label="Park"
              value={branchId}
              onChange={(value) => {
                // The same park again changes nothing: the read in flight is kept.
                if (value === branchId) return;
                request.current++;
                setBranchId(value);
              }}
              options={branches.map((row) => ({ value: row.id, label: row.name }))}
            />
          ) : undefined
        }
      />
      {branchError && <ErrorNote message={branchError} onRetry={() => setRefresh((value) => value + 1)} />}
      {error && <ErrorNote message={error} onRetry={() => void reload()} />}
      {!branches && !branchError ? (
        <Loading what="parks" />
      ) : branches?.length === 0 ? (
        <EmptyNote title="No parks here" detail="There is no reachable park to show gate messages for." />
      ) : data && draft && loaded ? (
        <div className="flex min-w-0 flex-col gap-5">
          <StatusLine data={data} canEdit={canEdit} />
          <div className="grid min-w-0 items-start gap-5 @4xl:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex min-w-0 flex-col gap-5">
              <LanguagesCard draft={draft} editable={editable} edit={edit} />
              <CardShell title="Messages" note="what the reader says for each case">
                <ul className="flex min-w-0 flex-col gap-3">
                  {GATE_MESSAGE_CASES.map((key) => {
                    const info = GATE_MESSAGE_CASE_INFO[key];
                    const lang = caseLang[key] ?? draft.languages[0] ?? 'en';
                    const custom = !sameText(draft.cases[key], defaults.cases[key]);
                    return (
                      <li
                        key={key}
                        className={cn(
                          'min-w-0 rounded-xl border p-3 flex flex-col gap-2',
                          selected === key ? 'border-primary' : 'border-border',
                        )}
                        onClick={() => setSelected(key)}
                        onFocusCapture={() => setSelected(key)}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{info.title}</span>
                          <StatusChip tone={info.opens ? 'ok' : 'idle'}>
                            {info.opens ? 'Opens the gate' : 'Does not open'}
                          </StatusChip>
                          {custom && <Tag variant="mint">Custom</Tag>}
                          <span className="flex-1" />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!editable || !custom}
                            onClick={() =>
                              edit((next) => {
                                next.cases[key] = { ...defaults.cases[key] };
                              })
                            }
                          >
                            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset to default
                          </Button>
                        </div>
                        <p className="text-sm text-muted-foreground">{info.when}</p>
                        <LangTabs
                          value={lang}
                          shown={draft.languages}
                          changed={(l) => draft.cases[key][l] !== defaults.cases[key][l]}
                          onChange={(l) => setCaseLang((previous) => ({ ...previous, [key]: l }))}
                        />
                        <Field
                          label={`${info.title} · ${GATE_MESSAGE_LANG_NAMES[lang]}`}
                          hint="Each line is one line on the reader. Empty: this language is skipped for this case."
                        >
                          <textarea
                            rows={3}
                            value={draft.cases[key][lang]}
                            maxLength={GATE_MESSAGE_TEXT_MAX}
                            disabled={!editable}
                            className={TEXTAREA}
                            onChange={(event) => {
                              const text = event.target.value;
                              edit((next) => {
                                next.cases[key][lang] = text;
                              });
                            }}
                          />
                        </Field>
                      </li>
                    );
                  })}
                </ul>
              </CardShell>
              <LabelsCard draft={draft} defaults={defaults} editable={editable} edit={edit} />
            </div>
            <div className="min-w-0 @4xl:sticky @4xl:top-4">
              <PreviewCard texts={draft} caseKey={selected} />
            </div>
          </div>
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              Saved. The gate uses the new wording after its next refresh; a gate box needs its new release
              (SCRUM-1078) before it shows saved texts.
            </p>
          )}
          {saveError && <ErrorNote message={saveError} />}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void save()} disabled={!dirty || busy}>
                <Save className="h-4 w-4" aria-hidden="true" />
                {busy ? 'Saving…' : 'Save gate messages'}
              </Button>
              {dirty && !busy && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft(structuredClone(loaded));
                    setSaveError(null);
                  }}
                >
                  Discard changes
                </Button>
              )}
            </div>
          )}
        </div>
      ) : !error && !branchError && branchId ? (
        <Loading what="gate messages" />
      ) : null}
    </>
  );
}

function StatusLine({ data, canEdit }: { data: GateMessagesRead; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">
        {data.changed === 0
          ? 'The gate shows the built-in wording.'
          : `${data.changed} change${data.changed === 1 ? '' : 's'} from the built-in wording`}
        {data.updatedAt && (
          <>
            {' '}
            · Updated <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString('en-GB')}</time>
          </>
        )}
      </p>
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You can read these texts. Changing them needs <code className="font-mono text-xs">admin:gate_message:manage</code>.
        </p>
      )}
    </div>
  );
}

function LangTabs({
  value,
  shown,
  changed,
  onChange,
}: {
  value: GateMessageLang;
  shown: readonly GateMessageLang[];
  changed: (lang: GateMessageLang) => boolean;
  onChange: (lang: GateMessageLang) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Language">
      {GATE_MESSAGE_LANGS.map((lang) => {
        const isShown = shown.includes(lang);
        return (
          <button
            key={lang}
            type="button"
            aria-pressed={value === lang}
            title={`${GATE_MESSAGE_LANG_NAMES[lang]}${isShown ? ', shown on the gate' : ', not shown on the gate'}${changed(lang) ? ', changed' : ''}`}
            onClick={() => onChange(lang)}
            className={cn(
              'h-8 rounded-full border px-3 text-[12.5px] font-semibold',
              value === lang ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-foreground',
              !isShown && value !== lang && 'opacity-60',
            )}
          >
            {GATE_MESSAGE_LANG_NAMES[lang]}
            {changed(lang) ? ' •' : ''}
          </button>
        );
      })}
    </div>
  );
}

function LanguagesCard({
  draft,
  editable,
  edit,
}: {
  draft: GateMessageTexts;
  editable: boolean;
  edit: (change: (next: GateMessageTexts) => void) => void;
}) {
  const remaining = GATE_MESSAGE_LANGS.filter((lang) => !draft.languages.includes(lang));
  const move = (from: number, to: number) =>
    edit((next) => {
      const [lang] = next.languages.splice(from, 1);
      if (lang) next.languages.splice(to, 0, lang);
    });
  return (
    <CardShell title="Languages shown on the gate" note="in this order">
      <p className="text-sm text-muted-foreground">
        Every scan’s text is shown in these languages, in this order: the first line in each language, then the
        second line in each language. The small words under the text (Adult, until, Credit) use the first language.
      </p>
      <ol className="flex flex-col gap-2">
        {draft.languages.map((lang, index) => (
          <li key={lang} className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2">
            <span className="w-6 text-sm font-semibold text-muted-foreground">{index + 1}.</span>
            <span className="flex-1 font-semibold">{GATE_MESSAGE_LANG_NAMES[lang]}</span>
            <Button variant="outline" size="sm" aria-label={`Move ${GATE_MESSAGE_LANG_NAMES[lang]} up`}
              disabled={!editable || index === 0} onClick={() => move(index, index - 1)}>
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button variant="outline" size="sm" aria-label={`Move ${GATE_MESSAGE_LANG_NAMES[lang]} down`}
              disabled={!editable || index === draft.languages.length - 1} onClick={() => move(index, index + 1)}>
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button variant="outline" size="sm" aria-label={`Remove ${GATE_MESSAGE_LANG_NAMES[lang]}`}
              disabled={!editable || draft.languages.length <= 1}
              onClick={() => edit((next) => { next.languages.splice(index, 1); })}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      {remaining.length > 0 && (
        <SelectChip
          label="Add language"
          showLabel
          value=""
          anyLabel="Pick a language"
          disabled={!editable}
          options={remaining.map((lang) => ({ value: lang, label: GATE_MESSAGE_LANG_NAMES[lang] }))}
          onChange={(value) => {
            const lang = remaining.find((l) => l === value);
            if (lang) edit((next) => { next.languages.push(lang); });
          }}
        />
      )}
    </CardShell>
  );
}

function LabelsCard({
  draft,
  defaults,
  editable,
  edit,
}: {
  draft: GateMessageTexts;
  defaults: GateMessageTexts;
  editable: boolean;
  edit: (change: (next: GateMessageTexts) => void) => void;
}) {
  const first = draft.languages[0] ?? 'en';
  return (
    <CardShell title="Labels" note="the small words around the facts the gate fills in">
      <p className="text-sm text-muted-foreground">
        The gate uses the labels of the first language shown ({GATE_MESSAGE_LANG_NAMES[first]}); an empty label uses
        the English one. {'{time}'} and {'{amount}'} mark where the value goes: keep them in.
      </p>
      <ul className="flex flex-col gap-3">
        {GATE_MESSAGE_LABELS.map((key) => {
          const info = GATE_MESSAGE_LABEL_INFO[key];
          const custom = !sameText(draft.labels[key], defaults.labels[key]);
          return (
            <li key={key} className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{info.title}</span>
                {custom && <Tag variant="mint">Custom</Tag>}
                <span className="flex-1" />
                <Button variant="outline" size="sm" disabled={!editable || !custom}
                  onClick={() => edit((next) => { next.labels[key] = { ...defaults.labels[key] }; })}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset to default
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{info.when}</p>
              <div className="grid min-w-0 gap-2 @2xl:grid-cols-5">
                {GATE_MESSAGE_LANGS.map((lang) => (
                  <Field key={lang} label={`${GATE_MESSAGE_LANG_NAMES[lang]}${lang === first ? ' (used)' : ''}`}>
                    <TextInput
                      value={draft.labels[key][lang]}
                      maxLength={GATE_MESSAGE_LABEL_MAX}
                      disabled={!editable}
                      onChange={(text) => edit((next) => { next.labels[key][lang] = text; })}
                    />
                  </Field>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}

function PreviewCard({ texts, caseKey }: { texts: GateMessageTexts; caseKey: GateMessageCase }) {
  const info = GATE_MESSAGE_CASE_INFO[caseKey];
  const preview = previewGateScreen(composeGateScreen(texts, caseKey, sampleFacts(caseKey)), caseKey);
  const refusal = !info.opens;
  return (
    <CardShell title="Preview" note={info.title} className="@4xl:w-[19rem]">
      <div className="inline-block self-start rounded-2xl bg-foreground p-3 text-background" aria-label="The reader’s screen">
        <div className="font-mono text-[13px] leading-snug" style={{ width: '15ch' }}>
          {preview.lines.map((line, index) => (
            <div
              key={index}
              className={cn('min-h-[1.25em] whitespace-pre-wrap [overflow-wrap:anywhere]', refusal && index === 0 && 'opacity-50')}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
      {refusal && (
        <p className="text-xs text-muted-foreground">
          The first line is the reader app’s own: it adds this line itself; it cannot be removed.
        </p>
      )}
      <p className="text-sm font-semibold">
        {preview.count} of {GATE_READER_SCREEN.lines} lines
      </p>
      {preview.tooLong && (
        <p role="alert" className="text-sm font-semibold" style={{ color: 'hsl(var(--status-warn))' }}>
          Longer than the reader’s screen: the end will not be seen.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The facts under the line (ticket, time, credit) are filled in by the gate and cannot be removed. The
        sample is an adult on a 2 Hours Play ticket at 16:10.
      </p>
      <p className="text-xs text-muted-foreground">
        A text only changes wording: nothing here changes whether the gate opens.
      </p>
    </CardShell>
  );
}
