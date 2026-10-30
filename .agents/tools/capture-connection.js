// Playwright CLI function for loopback sign-in, connection and update fixtures.
async (page, { origin, outputDir }) => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname)) throw new Error('Use the loopback fixture preview');
  const context=await page.context().browser().newContext({serviceWorkers:'block',reducedMotion:'reduce',colorScheme:'light'});
  const tab=await context.newPage(); const paths=[]; let mode='healthy';let recoveryPhase='failed';
  await tab.route('**/api/bootstrap*',async route=>{
    if(mode==='signin'||mode==='setup') return route.fulfill({status:401,json:{error:'Sign in to continue.'}});
    const response=await route.fetch(); const boot=await response.json();
    if(mode==='disconnected') boot.connection={...boot.connection,connected:false,code:'unreachable',detail:'Explicit preview fixture. The configured Hermes host is unavailable.'};
    await route.fulfill({json:boot});
  });
  await tab.route('**/api/auth/config',route=>route.fulfill({json:{localDevAuth:mode!=='setup',nativeAuthVersion:1}}));
  await tab.route('**/api/hermes/upgrade',async route=>{
    const response=await route.fetch();const status=await response.json();const failed=recoveryPhase==='failed';
    await route.fulfill({json:{...status,phase:recoveryPhase,operation:'install',canCheck:false,canInstall:false,canRetry:failed,canCancel:failed,canRestartService:failed,
      message:failed?'The update could not restart Hermes. Your conversations are saved. Restart Hermes to check and restore the connection.':'Waiting for a safe stopping point, then checking the connection.'}});
  });
  await tab.route('**/api/hermes/upgrade/control',async route=>{recoveryPhase='recovering';await route.continue();});
  const shot=async name=>{
    await tab.mouse.move(0,0);
    await tab.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    const path=outputDir+'/'+name+'.png';await tab.screenshot({path,animations:'disabled'});paths.push(path);
  };
  try {
    for(const width of [1440,390]) {
      recoveryPhase='failed';
      await tab.setViewportSize({width,height:width===1440?1000:844});
      mode='signin'; await tab.goto(origin); await tab.getByRole('heading',{name:'Your assistants are waiting.',exact:true}).waitFor();
      await shot('signin-'+width);
      mode='setup'; await tab.reload(); await tab.getByRole('heading',{name:"Let's get your household ready.",exact:true}).waitFor();
      await shot('signin-setup-'+width);
      mode='disconnected';await tab.goto(origin+'/?view=conversation&bot=ranch');
      const connection=tab.getByRole('region',{name:'Hermes connection',exact:true});await connection.waitFor();
      const approvals=tab.locator('.approval-card .actions button');await approvals.first().waitFor();
      if(await approvals.count()!==2||await approvals.evaluateAll(nodes=>nodes.some(node=>!node.disabled))) throw new Error('Disconnected decisions must stay disabled');
      await shot('connection-lost-'+width);
      mode='healthy';await tab.goto(origin+'/?view=conversation&bot=ranch');await tab.locator('article[data-message-id]').first().waitFor();
      if(width===390) await tab.getByRole('button',{name:'Back to assistants',exact:true}).click();
      await tab.getByRole('button',{name:'Settings',exact:true}).click();
      await tab.getByRole('button',{name:/^Hermes and updates/}).click();
      const panel=tab.locator('dialog.hermes-upgrade-panel');
      await panel.getByRole('button',{name:'Restart Hermes',exact:true}).waitFor();await shot('update-failed-'+width);
      await panel.getByRole('button',{name:'Restart Hermes',exact:true}).click();
      if(!await panel.locator('.upgrade-confirmation').evaluate(node=>node===document.activeElement)) throw new Error('Confirmation must receive focus');
      await shot('update-restart-confirm-'+width);
      await panel.getByRole('button',{name:'Not now',exact:true}).click();
      if(!await panel.getByRole('button',{name:'Restart Hermes',exact:true}).evaluate(node=>node===document.activeElement)) throw new Error('Cancel must restore Restart focus');
      await panel.getByRole('button',{name:'Restart Hermes',exact:true}).click();
      // A second administrator can recover this same operation. Polling must
      // dismiss the old prompt, and a later failure must not bring it back.
      recoveryPhase='recovering';
      await panel.getByRole('button',{name:'Restoring…',exact:true}).waitFor();
      if(await panel.locator('.upgrade-confirmation').count()) throw new Error('Phase change must retire confirmation');
      recoveryPhase='failed';
      await panel.getByRole('button',{name:'Restart Hermes',exact:true}).waitFor();
      if(await panel.locator('.upgrade-confirmation').count()) throw new Error('Old confirmation must not return');
      await panel.getByRole('button',{name:'Restart Hermes',exact:true}).click();
      await panel.getByRole('button',{name:'Yes, restart Hermes',exact:true}).click();
      await panel.getByText('Waiting for a safe stopping point, then checking the connection.',{exact:true}).waitFor();
      await panel.getByRole('button',{name:'Restoring…',exact:true}).waitFor();
      await shot('update-recovering-'+width);
      await panel.getByRole('button',{name:'Close Hermes updates',exact:true}).click();

    }
    return {paths};
  } catch(error){await tab.screenshot({path:outputDir+'/capture-failure.png'}).catch(()=>{});throw error;}
  finally {await context.close();}
}
