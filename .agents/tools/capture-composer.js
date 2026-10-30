// Compact-composer review capture against the loopback fixture app.
async (page, {origin, outputDir}) => {
  if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname)) throw Error('Use the fixture preview');
  const context=await page.context().browser().newContext({serviceWorkers:'block',reducedMotion:'reduce'});
  await context.addInitScript(()=>localStorage.clear());
  const tab=await context.newPage();const shots=[];
  await tab.route('**/api/bootstrap*',async route=>{
    const response=await route.fetch();const boot=await response.json();
    boot.bots=boot.bots.map(bot=>({...bot,activity:'idle'}));
    await route.fulfill({json:boot});
  });
  await tab.route('**/api/bots/*/conversation*',async route=>{
    const response=await route.fetch();const value=await response.json();
    Object.assign(value,{approvals:[],attention:[],toolCalls:[],activity:{state:'idle'}});
    await route.fulfill({json:value});
  });
  const shot=async name=>{
    await tab.mouse.move(0,0);await tab.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    const path=outputDir+'/'+name+'.png';await tab.screenshot({path,animations:'disabled'});
    const box=await tab.locator('.composer').boundingBox();
    if(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Document overflow');
    shots.push({name,path,height:box.height,width:box.width});
  };
  try{
    for(const width of [1440,768,390,320]){
      await tab.setViewportSize({width,height:width===1440?1000:844});
      await tab.goto(origin+'/?view=conversation&bot=ranch');
      await tab.locator('#message').waitFor();await tab.locator('#message').fill('');
      await shot('idle-'+width);
      await tab.locator('#message').fill('Can you check the gate before dinner?');await shot('draft-'+width);
      await tab.locator('#message').fill('A long single line '.repeat(8));await shot('long-line-'+width);
      await tab.locator('#message').fill('Please check the north gate.\nReview the battery history.\nCompare it with the other sensors.\nKeep the existing reminders.\nTell me what needs attention.');
      await shot('multiline-'+width);
    }
    return{shots,realProvider:false};
  }finally{await context.close();}
}
