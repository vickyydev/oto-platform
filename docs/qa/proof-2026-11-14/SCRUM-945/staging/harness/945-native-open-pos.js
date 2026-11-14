S.assert.equal((await S.pos('PUT','/me/session/branch',{branchId:'01a0bbdc-8c42-7753-b7e3-5ae19fb66d33'})).status,200);
await S.posPage.goto(S.POS+'/parties?party='+S.st.fixtures[0].id,{waitUntil:'domcontentloaded',timeout:120000});
await S.sleep(2500);
return {urlPath:new URL(S.posPage.url()).pathname,buttons:await S.posPage.getByRole('button').allTextContents(),headings:await S.posPage.getByRole('heading').allTextContents()};
