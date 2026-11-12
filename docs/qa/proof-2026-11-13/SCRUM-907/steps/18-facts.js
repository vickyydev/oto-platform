S.phase = 'pictures of read-back facts: point 1 (permissions) and point 6 (the audit row)';
const look = S.receipt.reads.look;
const pm = look.permissions;
await S.facts('01a-permissions-manager-and-reception.png', 'SCRUM-907 point 1: GET /api/me/permissions on staging, each account in its own api session (signed out after)', [
  ['Branch manager: holds pos:party:kitchen_update', `${pm.manager.holdsKitchenUpdate} (scope ${pm.manager.kitchenUpdateScopes.map(s => s.scopeType + (s.scopeIsFloresta ? ' = Oto Play Park, Central Floresta' : '')).join(', ')})`],
  ['Branch manager: pos:party:* held', pm.manager.partyPermissions.join(', ')],
  ['Branch manager: permissions in all', String(pm.manager.total)],
  ['Reception: holds pos:party:kitchen_update', String(pm.reception.holdsKitchenUpdate)],
  ['Reception: pos:party:* held', pm.reception.partyPermissions.join(', ')],
  ['Reception: permissions in all', String(pm.reception.total)],
  ['Sign-outs (status, then GET /api/me after)', `manager ${pm.manager.signOut} / ${pm.manager.meAfter}; reception ${pm.reception.signOut} / ${pm.reception.meAfter}`],
], 'Read at 01:36 Bangkok, before anything was made.');
const a = S.receipt.reads.p6.audit;
const e = a.entries[0];
const lines = x => (x ?? []).map(l => `${l.name}${l.chosenOption ? ': ' + l.chosenOption : ''} x${l.qty}${l.note ? ' note "' + l.note + '"' : ''}`).join('; ');
await S.facts('06f-platform-audit-party-kitchen-update.png', 'SCRUM-907 point 6: GET /api/audit?action=party.kitchen_update&entityId=<ZZ TEST 907 party> (as the platform admin)', [
  ['Rows for the party after the manager\'s Save', String(a.rows)],
  ['action / entityType / at (Bangkok)', `${e.action} / ${e.entityType} / ${e.at}`],
  ['before: food', lines(e.before.food)],
  ['before: bar', lines(e.before.bar)],
  ['before: cake', `${e.before.cake.time} "${e.before.cake.note}"`],
  ['after: food', lines(e.after.food)],
  ['after: bar', lines(e.after.bar)],
  ['after: cake', `${e.after.cake.time} "${e.after.cake.note}"`],
  ['after: by', `[name] (${e.after.by.role})`],
  ['after: changes', e.after.changes.map(c => c.op + (c.lineId ? ' ' + c.lineId : '') + (c.name ? ' ' + c.name : '') + (c.qty ? ' x' + c.qty : '') + (c.option ? ' -> ' + c.option : '') + (c.time ? ' ' + c.time : '') + (c.note ? ' "' + c.note + '"' : '')).join('; ')],
  ['after: editId / replayed / station', `${e.after.editId} / ${e.after.replayed} / the ZZ TEST till (${e.after.stationId === S.station.id})`],
  ['Rows after the refused change (point 10) and the two door refusals (point 11)', String(S.receipt.reads.p11.kitchenEditAudit)],
]);
return S.shots.slice(-2);
