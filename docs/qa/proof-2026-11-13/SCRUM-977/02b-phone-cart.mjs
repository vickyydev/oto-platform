S.phase='phone form at the top after rotation and retained cart';const p=S.phone,{expect}=S;
await p.setViewportSize({width:740,height:360});await p.getByTestId('consent-form-body').evaluate(el=>el.scrollTop=0);await p.waitForTimeout(500);
await S.shot(p,'02b-phone-740x360-top-kept-child.png');
await p.setViewportSize({width:390,height:844});await p.getByTestId('consent-form-body').evaluate(el=>el.scrollTop=0);await p.waitForTimeout(500);
await S.shot(p,'02c-phone-upright-again-kept-child.png');
await p.getByRole('button',{name:'Return phone to staff',exact:true}).click();
await expect(p.getByPlaceholder("Child's name").first()).toHaveValue('ZZ TEST 977 child rotated');
const result={child:await p.getByPlaceholder("Child's name").first().inputValue(),text:S.flat(await p.locator('body').innerText()).slice(0,700)};
await S.shot(p,'02d-phone-returned-same-cart.png');S.receipt.reads.phoneCart=result;S.save();return result;
