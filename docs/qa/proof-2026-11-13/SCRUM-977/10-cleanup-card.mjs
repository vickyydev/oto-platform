S.phase='final cleanup and evidence limits';
await S.admin.post('/api/auth/sign-out',{headers:{'idempotency-key':S.randomUUID()}});
S.receipt.cleanup.adminMe=(await S.admin.get('/api/me')).status();S.assert.equal(S.receipt.cleanup.adminMe,401);
S.receipt.cleanup.noRegistrations=S.receipt.registrationsPosted.length===0;S.save();
const p=await S.browser.newPage({viewport:{width:1180,height:900}});
const body=JSON.stringify({source:S.sha,at:new Date().toISOString(),cleanup:S.receipt.cleanup,proof:{phoneRotation:'both sizes, values and cart kept',landscapeFormShare:'67 to 70 percent',displayHelp:'same action ID; automatic in 1.342 seconds; no Retry',card:'one not-sent command; true reason; same sale after reload'},limits:['Browser and simulator proof only; no physical terminal or Pi acceptance','Idle updater and photo retry/contrast/party pins tested locally; no second staging build or physical offline photo test']},null,2).replace(/&/g,'&amp;').replace(/</g,'&lt;');
await p.setContent(`<body style="margin:0;padding:24px;background:#102030;color:#f1f5f9;font:16px/1.5 system-ui"><h2>SCRUM-977 / 975 / 979 - staging cleanup readback</h2><pre style="white-space:pre-wrap;font:14px/1.4 monospace">${body}</pre></body>`);
await p.screenshot({path:S.resolve(S.out,'10-cleanup-and-proof-limits.png'),fullPage:true});await p.close();return {adminMe:401,closedPages:Object.keys(S.pages).length};
