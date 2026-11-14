S.assert.equal(await S.runtime(),S.SHA);S.st.phase='native-extra-case';
const card=S.posPage.getByText('Kitchen plan',{exact:true}).locator('..');await card.scrollIntoViewIfNeeded();
S.assert.equal(await card.getByText('French fries',{exact:true}).count(),1,'base has no kids-only mark');S.assert.equal(await card.getByText(/French fries.*ZZ TEST 945 extra only.*kids only/).count(),1);S.assert.equal(await card.getByText(/Margherita.*ZZ TEST 945 own dish.*adults/).count(),1);
const words=await card.innerText();S.st.results.push({case:'native-extra-ui',words,at:new Date().toISOString()});await S.shotFor('pos','01-native-extra-does-not-mark-base.png',card);S.save();return {words,image:'01-native-extra-does-not-mark-base.png'};
