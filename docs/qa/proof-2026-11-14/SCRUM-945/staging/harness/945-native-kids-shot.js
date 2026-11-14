await S.posPage.reload({waitUntil:'domcontentloaded'});await S.posPage.getByRole('button',{name:'Next day',exact:true}).click();
const card=S.posPage.getByText('Kitchen plan',{exact:true}).locator('..');await card.waitFor();await card.scrollIntoViewIfNeeded();
await S.posPage.getByText('French fries · kids only',{exact:true}).waitFor();S.assert.equal(await card.getByText('French fries · kids only',{exact:true}).count(),1);S.assert.equal(await card.getByText(/Margherita.*ZZ TEST 945 own dish.*adults/).count(),1);
const words=await card.innerText();S.st.phase='native-valid-kids-set';S.st.results.push({case:'native-valid-kids-set-ui',words,at:new Date().toISOString()});await S.shotFor('pos','02-native-valid-kids-set.png',card);S.save();return {words,image:'02-native-valid-kids-set.png'};
