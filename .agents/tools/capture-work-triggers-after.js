// W3 AFTER only. Injected into capture-design's owned context, never run standalone.
async ({tab,panel,fixture,reset,capture,paths,geometry,workChecks,browserErrors,
  getWork,getReads,getSubmissions,getRoutineGets,releaseRoutines,nextRoutineRequest,externalTriggerEdit}) => {
  const section=panel.locator("section.automation-section").filter({has:tab.getByRole("heading",{name:"Event triggers",exact:true})});
  const heading=()=>section.getByRole("heading",{name:"Event triggers",exact:true});
  const form=()=>section.locator("form.automation-form");
  const secret=()=>section.locator(".automation-secret");
  const row=id=>{
    const data=getWork().triggers.items.find(item=>item.id===id) || fixture.work.triggers.items.find(item=>item.id===id) || fixture.workFixture.newTrigger;
    return section.locator("article.automation-item").filter({has:tab.getByRole("heading",{name:data.description||id,exact:true})});
  };
  let width=390,theme="light",large=false;
  const ensure=(value,message)=>{if(!value)throw Error(message);};
  ensure(await tab.evaluate(()=>navigator.clipboard?.syntheticWorkAudit===true),"Synthetic clipboard isolation missing");
  workChecks.push({check:"clipboard-scope",scope:"synthetic-per-page-memory",clipboardApiReplaced:true,hostClipboardMonitored:false,osPermissionBehaviorVerified:false});
  const bounds=async target=>target.evaluate(node=>{
    const r=node.getBoundingClientRect(),v=node.closest(".settings-content").getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width,
      viewTop:Math.max(0,v.top),viewBottom:Math.min(innerHeight,v.bottom),
      fullyVisible:r.top>=Math.max(0,v.top)&&r.bottom<=Math.min(innerHeight,v.bottom)&&r.left>=0&&r.right<=innerWidth};
  });
  const setup=async(options={})=>{
    releaseRoutines();width=options.width||390;theme=options.theme||"light";large=!!options.large;
    const routineStarted=options.mode==="routines-loading"?nextRoutineRequest():null;
    // reset can fail first; keep its pending request timeout from becoming an unhandled rejection.
    routineStarted?.catch(()=>{});
    await reset(options);
    if(routineStarted)await routineStarted;
    await heading().waitFor();
    if(options.mode==="routines-error")await section.getByRole("alert").waitFor();
    else if(options.mode!=="routines-loading"&&options.mode!=="sections-unsupported") {
      if(options.mode==="no-routines")await section.getByText("No event triggers yet.",{exact:true}).waitFor();
      else await section.getByText("Routine: Freezer alert check",{exact:true}).waitFor();
    }
  };
  const landing=async(name,target)=>{
    await target.waitFor({state:"attached",timeout:10000});
    const exists=await target.count();
    ensure(exists===1,`Expected one ${name} landing`);
    workChecks.push({check:"unscrolled-landing",name,...await bounds(target),
      scrollTop:await target.evaluate(node=>node.closest(".settings-content").scrollTop),
      activeElement:await tab.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute("role"),hasFocus:document.hasFocus()}))});
  };
  const checkDialogChrome=async(name)=>{
    const dialogState=await section.evaluate(node=>{
      const dialog=node.closest(".settings-dialog");
      if(!dialog)return {valid:false};
      const c=dialog.getBoundingClientRect();
      const container={top:c.top,bottom:c.bottom,left:c.left,right:c.right,width:c.width,height:c.height};
      const selectors=[":scope > header", "#assistant-settings-title", '[aria-label="Close assistant settings"]', 'nav.settings-tabs[aria-label="Settings sections"]'];
      const rects=selectors.map(selector=>{
        const element=dialog.querySelector(selector);
        if(!element)return null;
        const r=element.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};
      });
      const valid=dialog.scrollTop===0&&rects.every(r=>r&&r.width>0&&r.height>0&&r.top>=Math.max(0,container.top)&&r.bottom<=Math.min(innerHeight,container.bottom)&&r.left>=Math.max(0,container.left)&&r.right<=Math.min(innerWidth,container.right));
      return {valid,scrollTop:dialog.scrollTop,container,rects};
    });
    ensure(dialogState.valid,`Settings chrome clipped or scrolled at ${name}: ${JSON.stringify(dialogState)}`);
    workChecks.push({check:"dialog-chrome",name,...dialogState});
  };
  const shot=async(name,target=heading(),{whole=true,scroll=true}={})=>{
    ensure(await target.count()===1,`Ambiguous trigger screenshot anchor ${name}`);
    if(scroll)await target.scrollIntoViewIfNeeded();
    const anchor=await bounds(target);
    if(whole)ensure(anchor.fullyVisible,`Trigger ${name} anchor clipped: ${JSON.stringify(anchor)}`);
    await checkDialogChrome(`frame:${name}`);
    await capture(`trigger-${name}`,width,width>1000?1000:844,theme);
    geometry.at(-1).triggerAnchor={...anchor,wholeRequired:whole};
    geometry.at(-1).activeElement=await tab.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute("role"),hasFocus:document.hasFocus()}));
    // Record measured quality. Baseline defects are not harness failures.
    geometry.at(-1).triggers=await section.evaluate(node=>{
      const view=node.closest(".settings-content").getBoundingClientRect();
      const measure=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {
        tag:element.tagName,type:element.getAttribute("type"),label:element.tagName==="BUTTON"?element.textContent.trim():element.getAttribute("aria-label"),
        width:r.width,height:r.height,top:r.top,bottom:r.bottom,disabled:element.disabled===true,
        fontSize:s.fontSize,color:s.color,background:s.backgroundColor,fullyVisible:r.top>=view.top&&r.bottom<=view.bottom};};
      return {overflow:{document:document.documentElement.scrollWidth>innerWidth,section:node.scrollWidth>node.clientWidth,
        form:[...node.querySelectorAll("form")].some(x=>x.scrollWidth>x.clientWidth),secret:[...node.querySelectorAll(".automation-secret")].some(x=>x.scrollWidth>x.clientWidth)},
        targets:[...node.querySelectorAll("button,input,select")].map(measure),
        text:[...node.querySelectorAll(".muted,.capability-note,.automation-url")].map(measure),
        targetMinimum:innerWidth<=620?44:24};
    });
  };
  const shotGroup=async(name,first,last)=>{
    ensure(await first.count()===1&&await last.count()===1,`Ambiguous trigger group ${name}`);
    await first.evaluate(node=>{
      const scroller=node.closest(".settings-content");
      scroller.scrollTop+=node.getBoundingClientRect().top-Math.max(0,scroller.getBoundingClientRect().top)-12;
    });
    const a=await bounds(first),b=await bounds(last);
    const group={top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom),left:Math.min(a.left,b.left),right:Math.max(a.right,b.right),viewTop:a.viewTop,viewBottom:a.viewBottom};
    ensure(group.bottom-group.top<=group.viewBottom-group.viewTop,`Trigger ${name} group is taller than its viewport`);
    ensure(a.fullyVisible&&b.fullyVisible&&group.top>=group.viewTop&&group.bottom<=group.viewBottom,`Trigger ${name} group clipped: ${JSON.stringify(group)}`);
    await shot(name,first);
    geometry.at(-1).triggerGroup=group;
  };
  const openCreate=async()=>{
    await section.getByRole("button",{name:"New event trigger",exact:true}).click();
    await form().getByLabel("Trigger ID",{exact:true}).waitFor();
  };
  const fill=async()=>{
    const next=fixture.workFixture.newTrigger;
    await form().getByLabel("Trigger ID",{exact:true}).fill(next.id);
    await form().getByLabel("Description (optional)",{exact:true}).fill(next.description);
    await form().getByLabel("Event names",{exact:true}).fill(next.events.join(", "));
    const picker=form().getByRole("combobox",{name:/^Routine\b/});
    ensure(!await picker.locator('option[value="routine-garden"]').count(),"Other assistant's routine leaked into picker");
    await picker.selectOption(next.routineId);
  };
  const assertWrite=(start,method,path,body)=>{
    const writes=getSubmissions().slice(start);
    ensure(writes.length===1&&writes[0].method===method&&writes[0].path===path&&JSON.stringify(writes[0].body)===JSON.stringify(body),`Wrong trigger ${method} write contract`);
    workChecks.push({check:"write-contract",method,path,count:1});
  };
  const create=async()=>{
    await openCreate();await fill();const start=getSubmissions().length;
    await form().getByRole("button",{name:"Create trigger",exact:true}).click();
    await secret().getByRole("heading",{name:"Save this signing secret now",exact:true}).waitFor();
    assertWrite(start,"POST","/triggers",fixture.workFixture.newTrigger);
    ensure(!await secret().evaluate((node, token)=>node.innerHTML.includes(token), fixture.workFixture.syntheticSecret),"Hidden secret present in DOM");
    ensure(await secret().getByRole("button",{name:"I've saved it"}).isDisabled(),"Secret acknowledgment was not gated");
    await checkDialogChrome("secret-landing");
    await landing("created-secret",secret());
    ensure(await secret().getByRole("heading").evaluate(node=>document.activeElement===node),"Secret heading did not receive focus");
  };
  const reveal=async()=>{
    await secret().getByRole("button",{name:"Show secret",exact:true}).click();
    ensure(await secret().locator(".automation-secret-value").last().textContent()===fixture.workFixture.syntheticSecret,"Synthetic secret reveal mismatch");
  };
  // W4 coverage validator. The binder independently repeats these checks from raw rectangles.
  const validateSecretCoverage=(proof,expected)=>{
    const fail=message=>{throw Error(`200% secret coverage: ${message}`);};
    const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=0.5;
    const rect=box=>box&&["top","bottom","left","right","width","height"].every(k=>Number.isFinite(box[k]))&&box.width>0&&box.height>0&&close(box.bottom-box.top,box.height)&&close(box.right-box.left,box.width);
    const upper={heading:"Save this signing secret now",created:`${expected.id} was created and starts disabled.`,warning:"Hermes shows it once. Configure the sending service with this URL and secret. Leaving Work or reloading the page clears it from this screen.",urlLabel:"Webhook URL",url:expected.url,copyURL:"Copy URL"};
    const hidden={...upper,secretLabel:"Signing secret",hidden:"Hidden",show:"Show secret",copySecret:"Copy secret",gate:"Copy or show the secret first.",ack:"I've saved it",topBorder:"",bottomBorder:""};
    const shown={...upper,secretLabel:"Signing secret",value:expected.secret,hide:"Hide secret",copySecret:"Copy secret",ack:"I've saved it",topBorder:"",bottomBorder:""};
    const candidates=[...new Set([...Object.keys(hidden),...Object.keys(shown)])];
    if(!proof||proof.version!==1||!Array.isArray(proof.hidden)||proof.hidden.length<3||proof.hidden.length>4||!proof.revealed||!proof.landing)fail("missing states or bounded hidden frames");
    const first=proof.hidden[0],all=[...proof.hidden,proof.revealed];
    const normalize=(row,frame)=>({top:row.rect.top-frame.panel.top,left:row.rect.left-frame.panel.left,width:row.rect.width,height:row.rect.height});
    for(const frame of all){
      const texts=frame.state==="hidden"?hidden:frame.state==="revealed"?shown:null;
      if(!texts||!frame.samePanel||!frame.connected||frame.panelId!==first.panelId||!rect(frame.panel)||!rect(frame.view)||!Number.isFinite(frame.scrollTop)||frame.writes!==first.writes)fail("state, panel continuity, geometry or writes changed");
      if(!Number.isInteger(frame.writes)||frame.writes<0||!Number.isInteger(frame.reads)||frame.reads!==first.reads||!Number.isInteger(frame.routineReads)||frame.routineReads!==first.routineReads)fail("transport counts changed");
      if(!frame.counts||frame.counts.panel!==1||Object.keys(frame.counts).length!==candidates.length+1||candidates.some(key=>frame.counts[key]!==Number(key in texts)))fail("candidate counts or absences differ from state");
      if(frame.containsSecret!==(frame.state==="revealed"))fail("secret DOM presence differs from state");
      if(frame!==first&&!Number.isInteger(frame.requestedScrollTop))fail("non-integer scroll request");
      if(!Number.isFinite(frame.appliedScrollTop)||!Number.isFinite(frame.maxScrollTop)||frame.maxScrollTop<0||frame.appliedScrollTop<0||frame.appliedScrollTop>frame.maxScrollTop||!close(frame.appliedScrollTop,frame.scrollTop))fail("scroll request or clamp mismatch");
      if(frame===first){if(frame.requestedScrollTop!==null||frame.clamped!==false)fail("landing must not request a scroll");}
      else if(!close(frame.appliedScrollTop,Math.max(0,Math.min(frame.maxScrollTop,frame.requestedScrollTop)))||frame.clamped!==(Math.abs(frame.requestedScrollTop-frame.appliedScrollTop)>0.5))fail("scroll request or clamp mismatch");
      const after=frame.afterCapture;
      if(!after||["panelId","state","connected","samePanel","containsSecret","writes","reads","routineReads"].some(key=>after[key]!==frame[key])||!close(after.scrollTop,frame.appliedScrollTop)||!close(after.maxScrollTop,frame.maxScrollTop)||JSON.stringify(after.counts)!==JSON.stringify(frame.counts))fail("state or scroll changed during capture");
      for(const key of ["panel","view"])if(!rect(after[key])||Object.keys(frame[key]).some(part=>!close(after[key][part],frame[key][part])))fail("geometry changed during capture");
      if(!Array.isArray(frame.rows)||new Set(frame.rows.map(row=>row.key)).size!==frame.rows.length||frame.rows.length!==Object.keys(texts).length)fail("missing or duplicate semantic elements");
      for(const [key,text] of Object.entries(texts)){
        const row=frame.rows.find(item=>item.key===key);
        if(!row||row.text!==text||!rect(row.rect))fail(`missing or wrong text/rect for ${key}`);
        const other=after.rows?.find(item=>item.key===key);
        if(after.rows?.length!==frame.rows.length||!other||other.text!==row.text||other.disabled!==row.disabled||JSON.stringify(other.metrics)!==JSON.stringify(row.metrics)||Object.keys(row.rect).some(part=>!close(other.rect?.[part],row.rect[part])))fail("semantic element changed during capture");
        if(!["topBorder","bottomBorder"].includes(key)&&!row.metrics)fail("missing clipping metrics");
        if(row.metrics&&(!Object.values(row.metrics).every(value=>Number.isFinite(value)&&value>=0)||row.metrics.clientWidth>0&&row.metrics.scrollWidth>row.metrics.clientWidth+1||row.metrics.clientHeight>0&&row.metrics.scrollHeight>row.metrics.clientHeight+1))fail(`internal clipping for ${key}`);
        if(key==="ack"&&row.disabled!==(frame.state==="hidden"))fail("acknowledgement gate differs from state");
        if(["topBorder","bottomBorder"].includes(key)){
          const top=key==="topBorder"?frame.panel.top:frame.panel.bottom-1;
          if(!close(row.rect.top,top)||!close(row.rect.bottom,top+1)||!close(row.rect.left,frame.panel.left)||!close(row.rect.right,frame.panel.right)||!close(row.rect.height,1))fail(`invalid ${key}`);
        }
      }
      if(frame.rows.some(row=>row.key==="gate")!==(frame.state==="hidden"))fail("gate hint state mismatch");
    }
    if(proof.hidden.some(frame=>frame.state!=="hidden")||proof.revealed.state!=="revealed")fail("state order");
    if(!close(first.scrollTop,proof.landing.scrollTop)||!rect(proof.landing.panel)||["top","bottom","left","right"].some(k=>!close(first.panel[k],proof.landing.panel[k])))fail("initial landing moved before capture");
    let end=0;
    const visible=(row,frame)=>row.rect.top>=frame.view.top-0.5&&row.rect.bottom<=frame.view.bottom+0.5&&row.rect.left>=frame.view.left-0.5&&row.rect.right<=frame.view.right+0.5;
    for(const [index,frame] of proof.hidden.entries()){
      if(!close(frame.panel.height,first.panel.height)||!close(frame.panel.width,first.panel.width))fail("hidden panel changed size");
      if(Object.keys(frame.view).some(key=>!close(frame.view[key],first.view[key])))fail("hidden view changed");
      for(const row of frame.rows){
        const reference=first.rows.find(item=>item.key===row.key),a=normalize(row,frame),b=normalize(reference,first);
        if(Object.keys(a).some(k=>!close(a[k],b[k])))fail("hidden layout changed");
      }
      const start=Math.max(0,frame.view.top-frame.panel.top),finish=Math.min(frame.panel.height,frame.view.bottom-frame.panel.top);
      if(index===0&&start>0.5||index>0&&start>end-24+0.5||finish<=end+0.5)fail("hidden panel gap, insufficient overlap or no progress");
      end=finish;
    }
    if(end<first.panel.height-0.5)fail("hidden panel bottom not covered");
    for(const key of Object.keys(hidden))if(!proof.hidden.some(frame=>visible(frame.rows.find(row=>row.key===key),frame)))fail(`hidden ${key} is never fully visible`);
    for(const key of Object.keys(upper)){
      const row=proof.revealed.rows.find(item=>item.key===key),reference=first.rows.find(item=>item.key===key),a=normalize(row,proof.revealed),b=normalize(reference,first);
      if(Object.keys(a).some(k=>!close(a[k],b[k])))fail("revealed upper content changed");
    }
    for(const key of ["secretLabel","value","hide","copySecret","ack","bottomBorder"]){
      if(!visible(proof.revealed.rows.find(row=>row.key===key),proof.revealed))fail(`revealed ${key} is not fully visible`);
    }
    return true;
  };
  // W4 coverage validator end.
  // W4 revealed planner.
  const wholePixelScroll=(value,roundUp)=>roundUp?Math.ceil(value):Math.floor(value);
  const planRevealedSecret=frame=>{
    const label=frame.rows.find(row=>row.key==="secretLabel");
    if(!label||frame.panel.bottom-label.rect.top+12>frame.view.height)throw Error("Revealed secret controls exceed the viewport");
    return frame.scrollTop+label.rect.top-frame.view.top-12;
  };
  // W4 revealed planner end.
  const largeSecretCoverage=async()=>{
    const handle=await secret().elementHandle();
    ensure(handle,"Missing 200% secret panel");
    const panelId="secret-large-one-create",writes=getSubmissions().length,reads=getReads(),routineReads=getRoutineGets();
    const snapshot=async()=>{
      ensure(getSubmissions().length===writes,"200% secret coverage caused an extra write");
      ensure(getReads()===reads&&getRoutineGets()===routineReads,"200% secret coverage caused an extra read");
      const data=await handle.evaluate((node,config)=>{
        const box=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
        const scroller=node.closest(".settings-content"),panel=box(node),clip=box(scroller);
        const view={top:Math.max(0,clip.top),bottom:Math.min(innerHeight,clip.bottom),left:Math.max(0,clip.left),right:Math.min(innerWidth,clip.right)};
        view.width=view.right-view.left;view.height=view.bottom-view.top;
        const fields=node.querySelectorAll(".automation-secret-field"),paragraphs=[...node.children].filter(element=>element.tagName==="P");
        const buttons=parent=>[...parent.querySelectorAll("button")];
        const findButtons=(parent,text)=>parent?buttons(parent).filter(button=>button.textContent.trim()===text):[];
        const rows=[],counts={panel:document.querySelectorAll(".automation-secret").length};
        const add=(key,elements)=>{counts[key]=elements.length;const element=elements[0];if(element)rows.push({key,text:element.textContent.trim(),disabled:element.disabled===true,rect:box(element),metrics:{scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight}});};
        add("heading",[...node.querySelectorAll("h4")]);
        add("created",paragraphs.filter(p=>p.textContent.trim()===`${config.triggerId} was created and starts disabled.`));
        add("warning",paragraphs.filter(p=>p.textContent.trim()==="Hermes shows it once. Configure the sending service with this URL and secret. Leaving Work or reloading the page clears it from this screen."));
        add("urlLabel",[...fields[0]?.querySelectorAll("p")||[]]);add("url",[...fields[0]?.querySelectorAll("code")||[]]);add("copyURL",findButtons(fields[0],"Copy URL"));
        add("secretLabel",[...fields[1]?.querySelectorAll("p")||[]].filter(p=>p.textContent.trim()==="Signing secret"));
        add("hidden",[...fields[1]?.querySelectorAll("p")||[]].filter(p=>p.textContent.trim()==="Hidden"));
        add("show",findButtons(fields[1],"Show secret"));add("hide",findButtons(fields[1],"Hide secret"));
        add("gate",paragraphs.filter(p=>p.textContent.trim()==="Copy or show the secret first."));
        add("value",[...fields[1]?.querySelectorAll("code")||[]]);
        add("copySecret",findButtons(fields[1],"Copy secret"));add("ack",findButtons(node,"I've saved it"));
        const state=counts.hide>0?"revealed":"hidden";
        rows.push({key:"topBorder",text:"",rect:{...panel,bottom:panel.top+1,height:1}},{key:"bottomBorder",text:"",rect:{...panel,top:panel.bottom-1,height:1}});
        counts.topBorder=1;counts.bottomBorder=1;
        return {panelId:config.id,state,connected:node.isConnected,samePanel:node===document.querySelector(".automation-secret"),containsSecret:node.innerHTML.includes(config.secret),counts,panel,view,scrollTop:scroller.scrollTop,maxScrollTop:Math.max(0,scroller.scrollHeight-scroller.clientHeight),rows};
      },{id:panelId,triggerId:fixture.workFixture.newTrigger.id,secret:fixture.workFixture.syntheticSecret});
      return {...data,writes:getSubmissions().length,reads:getReads(),routineReads:getRoutineGets()};
    };
    const move=async(requestedScrollTop,roundUp=false)=>handle.evaluate((node,requested)=>{
      const scroller=node.closest(".settings-content");scroller.scrollTop=requested;
      const appliedScrollTop=scroller.scrollTop,maxScrollTop=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
      return {requestedScrollTop:requested,appliedScrollTop,maxScrollTop,clamped:Math.abs(requested-appliedScrollTop)>0.5};
    },wholePixelScroll(requestedScrollTop,roundUp));
    const captureSecretFrame=async(name,position)=>{
      const before={...await snapshot(),...position,frame:`trigger-${name}`};
      ensure(Math.abs(before.scrollTop-position.appliedScrollTop)<=0.5,"Secret position moved before capture");
      await shot(name,secret(),{whole:false,scroll:false});
      geometry.at(-1).secretCoverageFrame=before;
      return {...before,afterCapture:await snapshot()};
    };
    const initial=await snapshot(),landed=workChecks.findLast(check=>check.check==="unscrolled-landing"&&check.name==="created-secret");
    ensure(landed,"Missing unscrolled 200% secret landing");
    const proof={version:1,landing:{scrollTop:landed.scrollTop,panel:Object.fromEntries(["top","bottom","left","right","width","height"].map(key=>[key,landed[key]]))},hidden:[],revealed:null};
    const names=["secret-large-top","secret-large-middle","secret-large-bottom","secret-large-extra"];
    const covered=new Set();let previousEnd=0;
    const visible=(row,frame)=>row.rect.top>=frame.view.top-0.5&&row.rect.bottom<=frame.view.bottom+0.5&&row.rect.left>=frame.view.left-0.5&&row.rect.right<=frame.view.right+0.5;
    // The first frame preserves the product landing. No scroll request is made.
    let position={requestedScrollTop:null,appliedScrollTop:initial.scrollTop,maxScrollTop:initial.maxScrollTop,clamped:false};
    for(let index=0;index<4;index++){
      if(index){
        const missing=initial.rows.filter(row=>!covered.has(row.key)).sort((a,b)=>a.rect.top-b.rect.top)[0];
        const target=Math.min(previousEnd-24,missing?missing.rect.top-initial.panel.top-12:previousEnd-24);
        const scrollTop=initial.scrollTop+initial.panel.top-initial.view.top+target;
        position=await move(scrollTop);
      }
      const frame=await captureSecretFrame(names[index],position);proof.hidden.push(frame);
      for(const row of frame.rows)if(visible(row,frame))covered.add(row.key);
      previousEnd=Math.min(frame.panel.height,frame.view.bottom-frame.panel.top);
      if(previousEnd>=initial.panel.height-0.5&&covered.size===initial.rows.length)break;
    }
    ensure(proof.hidden.length>=3,"Unexpected 200% hidden panel fits fewer than three planned views");
    await reveal();
    const revealed=await snapshot();
    position=await move(planRevealedSecret(revealed),true);
    const placed=await snapshot();
    ensure(["secretLabel","value","hide","copySecret","ack","bottomBorder"].every(key=>{const row=placed.rows.find(item=>item.key===key);return row&&visible(row,placed);}),"Revealed secret group does not fit at its explicit scroll position");
    proof.revealed=await captureSecretFrame("secret-large",position);
    geometry.at(-1).wholeSecret=await bounds(secret());
    const expected={id:fixture.workFixture.newTrigger.id,url:getWork().triggers.items.find(item=>item.id===fixture.workFixture.newTrigger.id).url,secret:fixture.workFixture.syntheticSecret};
    validateSecretCoverage(proof,expected);
    workChecks.push({check:"secret-large-coverage",proof});
    return proof.hidden.length;
  };
  const uncertain=async()=>{
    await setup({mode:"trigger-create-uncertain"});await openCreate();await fill();
    const start=getSubmissions().length;
    await form().getByRole("button",{name:"Create trigger",exact:true}).click();
    await panel.getByRole("alert").waitFor();
    assertWrite(start,"POST","/triggers",fixture.workFixture.newTrigger);
    ensure(!await secret().count(),"Failed create exposed a secret");
    await landing("uncertain-alert",panel.getByRole("alert"));
    await landing("uncertain-feedback",form().locator(".automation-trigger-feedback"));
    ensure(await form().locator(".automation-trigger-feedback").evaluate(node=>document.activeElement===node),"Uncertain feedback not focused");
    await shotGroup("create-uncertain",form().locator(".automation-trigger-feedback"),form().locator(".actions"));
    await panel.getByRole("button",{name:"Refresh status",exact:true}).click();
    await row(fixture.workFixture.newTrigger.id).waitFor();
    await form().getByRole("button",{name:"Close",exact:true}).waitFor({state:"visible"});
    ensure(await form().getByRole("button",{name:"Create trigger",exact:true}).count()===0,"Uncertain create can be sent twice");
    await tab.waitForFunction(()=>[...document.querySelectorAll('.settings-dialog .automation-panel button')]
      .some(button=>button.textContent.trim()==="Refresh status"&&!button.disabled));
    ensure(getSubmissions().length===start+1&&!await secret().count(),"Uncertain create resent or recovered a secret without evidence");
    await shotGroup("create-uncertain-refreshed",form().locator(".automation-trigger-feedback"),form().locator(".actions"));
  };

  // Risk-first canaries. Each subsequent reset uses fresh synthetic transport state.
  await setup({width:1440});await create();await shot("secret-desktop",secret().getByRole("heading"));
  await uncertain();
  await setup();
  await row("freezer-alerts").getByRole("button",{name:"Edit trigger",exact:true}).click();
  const original=fixture.work.triggers.items.find(x=>x.id==="freezer-alerts");
  ensure(typeof externalTriggerEdit==="function","Missing AFTER external-edit transport helper");
  await externalTriggerEdit();
  let start=getSubmissions().length;
  await form().getByRole("button",{name:"Save trigger",exact:true}).click();
  await form().locator(".automation-trigger-feedback").waitFor();
  assertWrite(start,"PUT","/triggers/freezer-alerts",{description:original.description,events:original.events,routineId:original.routineId,revision:original.revision});
  await landing("stale-refusal",form().locator(".automation-trigger-feedback"));
  ensure(await form().locator(".automation-trigger-feedback").evaluate(node=>document.activeElement===node),"Refusal feedback not focused");
  ensure(!await form().getByRole("button",{name:"Cancel"}).isDisabled(),"Refusal disabled Cancel");
  ensure(!await panel.getByRole("button",{name:"Resume goal",exact:true}).isDisabled(),"Trigger refusal locked goal");
  await shot("edit-stale-refused",form().locator(".automation-trigger-feedback"));
  await shot("edit-stale-alert",panel.getByRole("heading",{name:"Goals, tasks & triggers"}));
  await setup();start=getSubmissions().length;
  const gate=fixture.work.triggers.items.find(x=>x.id==="gate-left-open");
  await row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}).click();
  await row(gate.id).getByRole("button",{name:"Disable trigger",exact:true}).waitFor();
  assertWrite(start,"PATCH","/triggers/gate-left-open",{enabled:true,revision:gate.revision});
  const notice=row(gate.id).locator(".automation-trigger-feedback");
  await landing("toggled-notice",notice);
  await shot("toggled",row(gate.id).getByRole("heading"));
  await row(gate.id).getByRole("button",{name:"Delete trigger…",exact:true}).click();
  await shot("delete-confirm",row(gate.id).locator(".automation-confirm"));
  const revision=getWork().triggers.items.find(x=>x.id===gate.id).revision;start=getSubmissions().length;
  await row(gate.id).getByRole("button",{name:"Delete trigger",exact:true}).click();
  await row(gate.id).waitFor({state:"detached"});assertWrite(start,"DELETE","/triggers/gate-left-open",{revision});
  await landing("deleted-notice",section.locator(".automation-trigger-removed"));
  await shot("deleted",section.locator(".automation-trigger-removed"));

  for(const [name,options] of [["list-desktop",{width:1440}],["list-dark",{width:1440,theme:"dark"}],["list-phone",{}],["list-narrow",{width:320}],["list-large",{large:true}]]) {
    await setup(options);await shot(name);
  }
  await setup({large:true});
  await shotGroup("list-large-row",row("freezer-alerts").locator(".automation-trigger-status"),row("freezer-alerts").locator(".automation-url"));
  await shotGroup("list-large-row-actions",row("freezer-alerts").locator(".automation-url"),row("freezer-alerts").locator(".actions").last());
  await setup({mode:"readonly"});
  ensure(await section.getByRole("button").count()===0,"Readonly trigger controls visible");
  start=getSubmissions().length;await shot("readonly");ensure(getSubmissions().length===start,"Readonly state wrote data");
  await setup();
  ensure(await row("barn-door-sensor").getByRole("button",{name:"Enable trigger",exact:true}).isDisabled(),"Orphan enable was not disabled");
  await shot("list-orphan",row("barn-door-sensor").getByText(/Its routine is no longer available/));
  await setup({mode:"trigger-platform-off"});
  ensure(await row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}).isDisabled(),"Platform-off enable was not disabled");
  await shot("platform-off",row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}));
  await setup({mode:"sections-unsupported"});await shot("unsupported");
  await setup({mode:"no-routines"});await shot("first-use");
  await setup({mode:"routines-error"});await shot("routines-error",section.getByRole("button",{name:"Retry routines"}));
  const beforeRoutines=getRoutineGets();await setup({mode:"routines-loading"});
  ensure(getRoutineGets()===beforeRoutines+1,"Expected one held routines GET");
  await shot("routines-loading");releaseRoutines();
  await section.getByText("Routine: Freezer alert check",{exact:true}).waitFor();
  ensure(getRoutineGets()===beforeRoutines+1,"Held routines load duplicated its GET");
  workChecks.push({check:"routines-loading-hold",count:1});
  for(const [name,options,filled] of [["create-desktop",{width:1440},false],["create-phone",{},true],["create-narrow",{width:320},true],["create-large",{large:true},true]]) {
    await setup(options);await openCreate();if(filled)await fill();
    await shot(name,form().getByLabel("Trigger ID",{exact:true}));
    geometry.at(-1).wholeForm=await bounds(form());
  }
  await setup({large:true});await openCreate();await fill();
  await shotGroup("create-large-routine",form().getByRole("combobox",{name:/^Routine\b/}).locator("xpath=ancestor::label[1]"),form().getByText("The selected routine must also be enabled to run.",{exact:false}));
  await shotGroup("create-large-events",form().getByLabel("Description (optional)",{exact:true}).locator("xpath=ancestor::div[contains(@class,'automation-trigger-field')][1]"),form().getByLabel("Event names",{exact:true}).locator("xpath=ancestor::div[contains(@class,'automation-trigger-field')][1]"));
  await shotGroup("create-large-actions",form().getByText("Finish or cancel this new trigger before editing another.",{exact:true}),form().locator(".actions"));
  await setup();await openCreate();await fill();await shot("create-phone-actions",form().getByRole("button",{name:"Create trigger"}));
  await setup();await row("freezer-alerts").getByRole("button",{name:"Edit trigger",exact:true}).click();
  await landing("edit-form",form());await shot("edit-phone",form().getByLabel("Description (optional)",{exact:true}));
  let hiddenLargeFrames=0;
  for(const [name,options,show] of [["secret-phone",{},true],["secret-dark",{theme:"dark"},false],["secret-large",{large:true},true],["secret-narrow",{width:320},true]]) {
    await setup(options);await create();
    if(large){hiddenLargeFrames=await largeSecretCoverage();continue;}
    if(show)await reveal();
    await shot(name,show ? secret().locator(".automation-secret-value").last() : secret().getByRole("heading"));
    geometry.at(-1).wholeSecret=await bounds(secret());
  }
  await setup({theme:"dark"});await create();
  await shotGroup("secret-dark-actions",secret().getByText("Signing secret",{exact:true}),secret().getByRole("button",{name:"I've saved it",exact:true}));
  await setup();await create();await secret().getByRole("button",{name:"Copy secret",exact:true}).click();
  ensure(await tab.evaluate(()=>navigator.clipboard.readText())===fixture.workFixture.syntheticSecret,"Clipboard value mismatch");
  await shot("secret-copied",secret().getByRole("button",{name:"Copy secret"}));
  await secret().getByRole("button",{name:"I've saved it",exact:true}).click();
  ensure(!await secret().count(),"Acknowledged secret remained mounted");
  ensure(!getWork().triggers.items.find(x=>x.id===fixture.workFixture.newTrigger.id).enabled,"New trigger not disabled");
  await landing("created-notice",row(fixture.workFixture.newTrigger.id).locator(".automation-trigger-feedback"));await shot("created",row(fixture.workFixture.newTrigger.id).getByRole("heading"));
  // Leaving Work is recorded honestly: it clears the current secret without another write.
  await setup();await create();start=getSubmissions().length;
  const dialog=tab.locator(".settings-dialog");
  await dialog.getByRole("button",{name:"details",exact:true}).click();
  const overflow=dialog.locator(".settings-tabs-overflow");
  if(await overflow.count()&&await overflow.getAttribute("open")===null)await overflow.locator("summary").click();
  await dialog.getByRole("button",{name:"work",exact:true}).click();
  await heading().waitFor();ensure(!await secret().count()&&getSubmissions().length===start,"Secret persisted or leaving wrote data");
  const storage=await tab.evaluate(token=>{
    const check=store=>({entries:store.length,containsSecret:Object.values(store).some(value=>String(value).includes(token))});
    return {local:check(localStorage),session:check(sessionStorage)};
  },fixture.workFixture.syntheticSecret);
  ensure(!storage.local.containsSecret&&!storage.session.containsSecret,"Secret stored in browser storage");
  workChecks.push({check:"leave-secret",storage,writes:0});
  ensure(!getSubmissions().some(x=>x.method==="PATCH"&&x.path==="/triggers/barn-door-sensor"),"Orphan trigger was toggled");
  ensure(hiddenLargeFrames>=3&&hiddenLargeFrames<=4&&paths.length===38+hiddenLargeFrames&&new Set(paths).size===paths.length,"Expected 41 or 42 unique trigger AFTER images with complete hidden secret coverage");
  return {title:"Work W3 triggers AFTER",stage:"after",paths,geometry,workSubmissions:getSubmissions(),workChecks,browserErrors,workCase:"triggers"};
}
