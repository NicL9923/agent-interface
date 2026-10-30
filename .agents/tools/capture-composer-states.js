// Exercise exceptional composer states using explicit media/provider fixtures, never real audio or clipboard data.
async (page, {origin, outputDir}) => {
  if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname)) throw Error('Use the fixture preview');
  const context=await page.context().browser().newContext({serviceWorkers:'block',reducedMotion:'reduce'});
  let advanced=false, failVoice=true, failUpload=true, sends=0;
  await context.addInitScript(()=>{
    localStorage.clear();
    window.__composerAudio=[];
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    window.MediaRecorder=class {
      static isTypeSupported(){return true;} mimeType='audio/webm';state='inactive';
      start(){this.state='recording';} stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['synthetic voice'],{type:'audio/webm'})});this.onstop?.();}
    };
    window.Audio=class {constructor(){window.__composerAudio.push(this);}play(){this.onplaying?.();return Promise.resolve();}pause(){}removeAttribute(){}};
  });
  const tab=await context.newPage();const paths=[];
  await tab.route('**/api/bootstrap*',async route=>{
    const response=await route.fetch();const boot=await response.json();
    boot.preferences.presentation=advanced?'advanced':'simple';boot.bots=boot.bots.map(b=>({...b,activity:'idle'}));await route.fulfill({json:boot});
  });
  await tab.route('**/api/bots/*/conversation*',async route=>{
    const response=await route.fetch();const value=await response.json();Object.assign(value,{approvals:[],attention:[],toolCalls:[],activity:{state:'idle'}});await route.fulfill({json:value});
  });
  await tab.route('**/api/bots/*/messages',async route=>{sends++;await route.fulfill({status:503,json:{error:'Messages are not sent by this capture'}});});
  await tab.route('**/api/bots/*/voice/transcribe',async route=>{
    if(failVoice){failVoice=false;return route.fulfill({status:503,json:{error:'Fixture transcription is temporarily unavailable.'}});}
    await route.fulfill({json:{text:'Recorded fixture: check the north gate.'}});
  });
  await tab.route('**/api/bots/*/voice/speak',route=>route.fulfill({json:{url:'/api/voice/audio/01234567-0123-4123-8123-012345678901',mime:'audio/wav'}}));
  await tab.route('**/api/voice/audio/*',route=>route.fulfill({contentType:'audio/wav',body:Buffer.from('synthetic audio fixture')}));
  await tab.route('**/api/bots/*/uploads',async route=>{
    if(failUpload){failUpload=false;return route.fulfill({status:503,json:{error:'Fixture upload is temporarily unavailable.'}});}
    const raw=route.request().postDataBuffer().toString();const name=/filename="([^"]+)"/.exec(raw)?.[1]??'pasted.txt';
    await route.fulfill({json:{id:'fixture-upload-'+Date.now(),name,mime:'text/plain',size:38}});
  });
  const shot=async name=>{
    await tab.mouse.move(0,0);await tab.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    const path=outputDir+'/'+name+'.png';await tab.screenshot({path,animations:'disabled'});paths.push(path);
    if(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Overflow in '+name);
  };
  try{
    for(const width of [1440,390]){
      failVoice=true;failUpload=true;advanced=false;await tab.setViewportSize({width,height:width===1440?1000:844});
      await tab.goto(origin+'/?view=conversation&bot=ranch');const input=tab.locator('#message');await input.fill('Keep my existing draft.');
      await tab.getByRole('button',{name:'Record voice',exact:true}).click();await tab.getByRole('button',{name:/^Stop recording/}).waitFor();await shot('recording-'+width);
      await tab.getByRole('button',{name:/^Stop recording/}).click();await tab.getByRole('button',{name:'Retry transcription',exact:true}).waitFor();await shot('transcription-error-'+width);
      await tab.getByRole('button',{name:'Retry transcription',exact:true}).click();await tab.getByText('Added to your draft. Review it before sending.',{exact:true}).waitFor();
      if(!(await input.inputValue()).startsWith('Keep my existing draft.'))throw Error('Transcription replaced draft');await shot('transcribed-'+width);
      await tab.getByRole('button',{name:'Listen to reply',exact:true}).click();await tab.getByRole('button',{name:'Stop speaking',exact:true}).waitFor();await shot('speaking-'+width);
      await tab.evaluate(()=>window.__composerAudio.at(-1).onended?.());await tab.getByRole('button',{name:'Play audio',exact:true}).waitFor();await shot('audio-ready-'+width);
      await tab.locator('input[type=file]').setInputFiles({name:'gate-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Check the north gate before dinner.')});
      await tab.getByRole('button',{name:/^Retry/}).waitFor();await shot('upload-error-'+width);
      await tab.getByRole('button',{name:/^Retry/}).click();await tab.getByRole('button',{name:'Remove gate-notes.txt',exact:true}).waitFor();await shot('upload-retried-'+width);
      await tab.getByRole('button',{name:'Remove gate-notes.txt',exact:true}).click();
      await input.evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','x'.repeat(35000));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
      await tab.getByText(/Your paste was long, so it is attached/).waitFor();await shot('large-paste-'+width);
      for(const button of await tab.getByRole('button',{name:/^Remove pasted/}).all())await button.click();
      await input.fill('short');const same=await input.elementHandle();await input.fill('A longer line that needs the wider stacked input while preserving its element and focus.');
      if(!await input.evaluate((el,expected)=>el===expected,same))throw Error('Input was recreated');
      if(!await input.evaluate(el=>el===document.activeElement))throw Error('Input lost focus');
      await input.fill('');const cdp=await context.newCDPSession(tab);await cdp.send('Input.imeSetComposition',{text:'にほんご',selectionStart:4,selectionEnd:4});
      await tab.keyboard.press('Enter');if(sends)throw Error('IME Enter sent a message');await shot('ime-'+width);
      await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await cdp.detach();
      advanced=true;await tab.goto(origin+'/?view=conversation&bot=ranch');await input.fill('');await shot('advanced-'+width);
      await context.setOffline(true);await tab.getByText("You're offline",{exact:true}).waitFor();await shot('offline-'+width);await context.setOffline(false);
      await context.addInitScript(()=>{});
    }
    return{paths,syntheticMedia:true,realMicrophone:false,messagesSent:sends};
  }catch(error){await tab.screenshot({path:outputDir+'/states-failure.png'}).catch(()=>{});throw error;}
  finally{await context.setOffline(false);await context.close();}
}
