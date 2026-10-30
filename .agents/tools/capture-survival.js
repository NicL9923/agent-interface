// Playwright CLI function for empty and offline states on the loopback fixture app.
async (page, {origin, outputDir}) => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw Error('Use the fixture preview');
  const context = await page.context().browser().newContext({serviceWorkers:'block', reducedMotion:'reduce'});
  const tab = await context.newPage(); let mode='healthy'; const paths=[];
  await tab.route('**/api/bootstrap*', async route => {
    const response=await route.fetch(); const boot=await response.json();
    if(mode==='empty-home') boot.bots=[];
    if(mode==='empty-chat') boot.bots=boot.bots.map(bot=>({...bot,activity:'idle',lastMessage:undefined}));
    await route.fulfill({json:boot});
  });
  await tab.route('**/api/bots/*/conversation*', async route => {
    const response=await route.fetch();const value=await response.json();
    if(mode==='empty-chat') Object.assign(value,{messages:[],approvals:[],attention:[],toolCalls:[],activity:{state:'idle'},earlier:null});
    await route.fulfill({json:value});
  });
  await tab.route('**/api/today*', async route => {
    const response=await route.fetch();const value=await response.json();
    if(mode==='empty-home') Object.assign(value,{items:[],events:[],upcoming:[],unavailableBots:[],hasMore:false});
    await route.fulfill({json:value});
  });
  const shot=async name=>{
    await tab.mouse.move(0,0);await tab.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    const path=outputDir+'/'+name+'.png';await tab.screenshot({path,animations:'disabled'});paths.push(path);
    if(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Document overflow in '+name);
  };
  try {
    for(const width of [1440,390]) {
      await tab.setViewportSize({width,height:width===1440?1000:844});
      mode='empty-home';await tab.goto(origin);await tab.getByRole('button',{name:'Create an assistant',exact:true}).first().waitFor();await shot('empty-home-'+width);
      mode='empty-chat';await tab.goto(origin+'/?view=conversation&bot=ranch');await tab.getByRole('heading',{name:"Start with Ranch hand's role",exact:true}).waitFor();await shot('empty-chat-'+width);
      await tab.getByRole('button',{name:"Discuss Ranch hand's role",exact:true}).click();
      if(!await tab.locator('#message').inputValue()) throw Error('Empty-state action did not prepare a draft');
      await shot('empty-chat-draft-'+width);
      mode='healthy';await tab.goto(origin+'/?view=conversation&bot=ranch');await tab.locator('article[data-message-id]').first().waitFor();
      await tab.locator('#message').fill('Keep this draft while I am offline.');
      await context.setOffline(true);await tab.getByText("You're offline",{exact:true}).first().waitFor();
      if(await tab.locator('#message').inputValue()!=='Keep this draft while I am offline.') throw Error('Draft lost while offline');
      if(!await tab.getByRole('button',{name:'Send message',exact:true}).isDisabled()) throw Error('Send is enabled while offline');
      await shot('offline-chat-'+width);
      await context.setOffline(false);
      await tab.getByText("You're offline",{exact:true}).first().waitFor({state:'hidden'});
      await tab.waitForFunction(()=>Array.from(document.querySelectorAll('button[aria-label="Send message"],button[aria-label="Send guidance"]')).some(button=>!button.disabled));
      if(await tab.locator('#message').inputValue()!=='Keep this draft while I am offline.') throw Error('Draft lost after reconnect');
      await shot('reconnected-draft-'+width);
    }
    return {paths,realProvider:false,offlineDraftPreserved:true};
  } catch(error) { await tab.screenshot({path:outputDir+'/capture-failure.png'}).catch(()=>{});throw error; }
  finally {await context.setOffline(false);await context.close();}
}
