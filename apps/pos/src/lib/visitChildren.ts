import type { ApiChild, HeldVisitWrite } from '@/api/platform';
import { apiChildToSavedChild } from '@/api/mappers';
import { childDetailsDraft, childDetailsPatch, type ChildDetailsDraft } from '@/components/shared/ChildDetailsFields';
import { heldWriteIdentity, heldWriteKey, type HeldWriteKey } from '@/lib/gateChildren';
import type { SavedChild } from '@/types';

/**
 * SCRUM-1060 — THE VISIT ITSELF, UNDER ONE HELD IDENTITY.
 *
 * After the children's changes, Confirm opens the family's visit (or adds the
 * children to the one the gate opened, `confirmVisitChildren`). Each press
 * minted a fresh visit id and key, so a press again after the visit's reply
 * was lost opened a second draft visit for the same family. The screen now
 * holds the visit's identity — the client-minted id and its key — beside the
 * children's keys while it is open, kept while the same children are
 * confirmed: a press again replays the visit the platform (or the counter
 * box, which takes the same id) already has. Other children ticked are
 * another confirmation, under a new identity; the screen opened again starts
 * afresh. The drop-off gate's own visit is held the same way, in its map.
 */
export function heldVisitWrite(
  writeKeys: Map<string, HeldWriteKey>,
  openVisitId: string | null,
  body: { memberId: string; childIds: readonly string[] },
): HeldVisitWrite {
  return heldWriteIdentity(writeKeys, 'visit', { openVisitId, memberId: body.memberId, childIds: body.childIds }, 'visit');
}

/**
 * SCRUM-1059 — "WHO'S VISITING TODAY?" SAVES A CHILD'S CHANGE UNDER ONE KEY.
 *
 * The membership check's window (`VisitChildrenModal`) writes each child staff
 * changed as a PATCH before it opens the visit. It sent them with no key, so a
 * reply lost on the way back and Confirm pressed again wrote the change a
 * second time: the platform changed, audited and published the child twice for
 * one edit. Each change now goes under a key the window holds while it is open
 * for the family (`heldWriteKey`, the rule the drop-off gate keeps since
 * SCRUM-1053): the same change sent again keeps its key and the platform
 * answers from the first write; a different change, or another child, takes a
 * new one, and the window opened again for the next family starts afresh.
 *
 * What is sent is unchanged: the full record's changed fields where the
 * detail read landed, otherwise the allergy line alone, as the window showed.
 */
export async function saveVisitChildren(input: {
  /** The family's saved children, in the window's order. */
  children: readonly SavedChild[];
  /** Each child as the platform holds it, where the window's detail read landed. */
  records: ReadonlyMap<string, ApiChild>;
  /** The details shown for each child with a record, as staff left them. */
  drafts: Readonly<Record<string, ChildDetailsDraft>>;
  /** The allergy line of a child with no record, as staff left it. */
  allergyDrafts: Readonly<Record<string, string>>;
  /** The keys this window holds, child by child, while it is open. */
  writeKeys: Map<string, HeldWriteKey>;
  updateChild: (childId: string, patch: Record<string, unknown>, idempotencyKey: string) => Promise<{ child: ApiChild }>;
}): Promise<SavedChild[]> {
  const updated: SavedChild[] = [];
  for (const child of input.children) {
    const patch = changeOf(child, input);
    if (!patch) {
      updated.push(child);
      continue;
    }
    const key = heldWriteKey(input.writeKeys, `update:${child.id}`, patch, 'visit-child');
    updated.push(apiChildToSavedChild((await input.updateChild(child.id, patch, key)).child));
  }
  return updated;
}

function changeOf(
  child: SavedChild,
  input: Pick<Parameters<typeof saveVisitChildren>[0], 'records' | 'drafts' | 'allergyDrafts'>,
): Record<string, unknown> | null {
  const record = input.records.get(child.id);
  const draft = input.drafts[child.id];
  if (record && draft) return childDetailsPatch(childDetailsDraft(record), draft);
  // No full record for this child (the detail read did not land): the
  // allergy line is the only thing on screen and the only thing sent.
  const allergies = (input.allergyDrafts[child.id] ?? '').trim();
  return allergies !== (child.allergiesMedical ?? '').trim() ? { allergies: allergies || null } : null;
}
