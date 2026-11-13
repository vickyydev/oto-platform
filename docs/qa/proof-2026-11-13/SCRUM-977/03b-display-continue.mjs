S.phase='display proof continued after harness tried a digit on the letter keyboard';const d=S.d,c=d.getByTestId('display-consent'),{expect,assert}=S;
await S.typeKeys(d,'DISPLAY');await S.hideKeys(d);
await c.getByRole('button',{name:/Tap to set age|yrs/}).first().tap();const dlg=d.getByRole('dialog').last();await dlg.waitFor();
await dlg.getByRole('button',{name:'6',exact:true}).tap();await dlg.getByRole('button',{name:/^Jan/}).first().tap();await dlg.getByRole('button',{name:'1',exact:true}).first().tap();await dlg.getByRole('button',{name:/Confirm/}).tap();await dlg.waitFor({state:'hidden'});
await c.getByRole('button',{name:'Continue',exact:true}).tap();await c.getByTestId('consent-allergies').waitFor();
await S.shot(d,'03-display-care-online.png');return {form:true};
