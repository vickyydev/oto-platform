S.phase='not-started card command and History truth';const {assert}=S;
const cmds=(await S.call('GET',`/boxes/${S.box.id}/commands?limit=100`)).body.commands.filter(c=>c.payload?.attemptId===S.refusedAttempt);
assert.equal(cmds.length,1);assert.equal(cmds[0].state,'failed');assert.equal(cmds[0].errorCode,'TERMINAL_NOT_ON_THIS_BOX');
const a=(await S.call('GET',`/payments/attempts/${S.refusedAttempt}`)).body;
assert.equal(a.attempt.status,'declined');
S.receipt.reads.cardCommands=cmds.map(c=>({id:c.id,state:c.state,errorCode:c.errorCode,kind:c.kind,mode:c.payload?.mode}));
const p=S.till;await p.getByRole('button',{name:'Back',exact:true}).first().click();await p.waitForTimeout(500);
return {commands:S.receipt.reads.cardCommands,buttons:await p.getByRole('button').allTextContents()};
