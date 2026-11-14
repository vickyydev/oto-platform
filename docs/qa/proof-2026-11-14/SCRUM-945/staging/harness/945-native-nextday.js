await S.posPage.getByRole('button',{name:'Next day',exact:true}).click();await S.sleep(2000);
const ownWords=await S.posPage.getByText(/ZZ TEST 945/).allTextContents();return {ownWords,headings:await S.posPage.getByRole('heading').allTextContents()};
