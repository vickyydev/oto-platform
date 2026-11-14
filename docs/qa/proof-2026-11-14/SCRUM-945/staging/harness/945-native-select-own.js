await S.posPage.getByRole('button',{name:new RegExp('^'+S.st.station.name)}).click();await S.sleep(2500);
return {headings:await S.posPage.getByRole('heading').allTextContents(),buttons:await S.posPage.getByRole('button').allTextContents(),urlPath:new URL(S.posPage.url()).pathname};
