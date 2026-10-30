// W3 BEFORE only. Injected into capture-design's owned context, never run standalone.
async ({tab,panel,fixture,reset,capture,paths,geometry,workChecks,browserErrors,
  getWork,getReads,getSubmissions,getRoutineGets,releaseRoutines,nextRoutineRequest}) => {
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
      activeElement:await tab.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute("role")}))});
  };
  const shot=async(name,target=heading(),{whole=true}={})=>{
    ensure(await target.count()===1,`Ambiguous trigger screenshot anchor ${name}`);
    await target.scrollIntoViewIfNeeded();
    const anchor=await bounds(target);
    if(whole)ensure(anchor.fullyVisible,`Trigger ${name} anchor clipped: ${JSON.stringify(anchor)}`);
    await capture(`trigger-${name}`,width,width>1000?1000:844,theme);
    geometry.at(-1).triggerAnchor={...anchor,wholeRequired:whole};
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
  const openCreate=async()=>{
    await section.getByRole("button",{name:"New event trigger",exact:true}).click();
    await form().getByLabel("Trigger ID",{exact:true}).waitFor();
  };
  const fill=async()=>{
    const next=fixture.workFixture.newTrigger;
    await form().getByLabel("Trigger ID",{exact:true}).fill(next.id);
    await form().getByLabel("Description",{exact:true}).fill(next.description);
    await form().getByLabel("Event names, separated by commas",{exact:true}).fill(next.events.join(", "));
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
    await form().getByRole("button",{name:"Create disabled trigger",exact:true}).click();
    await secret().getByRole("heading",{name:"Save this signing secret now",exact:true}).waitFor();
    assertWrite(start,"POST","/triggers",fixture.workFixture.newTrigger);
    ensure(await secret().getByLabel("Signing secret",{exact:true}).getAttribute("type")==="password","Secret not hidden by default");
    await landing("created-secret",secret());
  };
  const reveal=async()=>{
    await secret().getByRole("button",{name:"Show secret",exact:true}).click();
    const input=secret().getByLabel("Signing secret",{exact:true});
    ensure(await input.getAttribute("type")==="text"&&await input.inputValue()===fixture.workFixture.syntheticSecret,"Synthetic secret reveal mismatch");
  };
  const uncertain=async()=>{
    await setup({mode:"trigger-create-uncertain"});await openCreate();await fill();
    const start=getSubmissions().length;
    await form().getByRole("button",{name:"Create disabled trigger",exact:true}).click();
    await panel.getByRole("alert").waitFor();
    assertWrite(start,"POST","/triggers",fixture.workFixture.newTrigger);
    ensure(!await secret().count(),"Failed create exposed a secret");
    await landing("uncertain-alert",panel.getByRole("alert"));
    await shot("create-uncertain",form().getByLabel("Trigger ID",{exact:true}));
    await panel.getByRole("button",{name:"Refresh status",exact:true}).click();
    await row(fixture.workFixture.newTrigger.id).waitFor();
    await form().getByRole("button",{name:"Create disabled trigger",exact:true}).waitFor({state:"visible"});
    await tab.waitForFunction(()=>[...document.querySelectorAll('.settings-dialog .automation-panel button')]
      .some(button=>button.textContent.trim()==="Refresh status"&&!button.disabled));
    ensure(getSubmissions().length===start+1&&!await secret().count(),"Uncertain create resent or recovered a secret without evidence");
    await shot("create-uncertain-refreshed",form().getByLabel("Trigger ID",{exact:true}));
  };

  // Risk-first canaries. Each subsequent reset uses fresh synthetic transport state.
  await setup({width:1440});await create();await shot("secret-desktop",secret().getByRole("heading"));
  await uncertain();
  await setup({mode:"trigger-external-change"});
  await row("freezer-alerts").getByRole("button",{name:"Edit trigger",exact:true}).click();
  ensure(getReads()===1,"Stale scenario received an extra overview read");
  await panel.getByRole("button",{name:"Refresh status",exact:true}).click();
  await row("freezer-alerts").getByRole("heading",{name:fixture.workFixture.externalTriggerEdit.description,exact:true}).waitFor();
  ensure(getReads()===2,"External edit must occur on overview read2");
  let start=getSubmissions().length;
  await form().getByRole("button",{name:"Save trigger",exact:true}).click();
  await panel.getByRole("alert").waitFor();
  const original=fixture.work.triggers.items.find(x=>x.id==="freezer-alerts");
  assertWrite(start,"PUT","/triggers/freezer-alerts",{description:original.description,events:original.events,routineId:original.routineId,revision:original.revision});
  await landing("stale-alert",panel.getByRole("alert"));
  workChecks.push({check:"stale-global-disabled",count:await panel.locator("button:disabled").count()});
  await shot("edit-stale-refused",form().getByLabel("Trigger ID",{exact:true}));
  await shot("edit-stale-alert",panel.getByRole("alert"));
  await setup();start=getSubmissions().length;
  const gate=fixture.work.triggers.items.find(x=>x.id==="gate-left-open");
  await row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}).click();
  await row(gate.id).getByRole("button",{name:"Disable trigger",exact:true}).waitFor();
  assertWrite(start,"PATCH","/triggers/gate-left-open",{enabled:true,revision:gate.revision});
  const notice=panel.getByRole("status").filter({hasText:"Saved in Hermes."});
  await landing("toggled-notice",notice);
  await shot("toggled",row(gate.id).getByRole("heading"));
  await row(gate.id).getByRole("button",{name:"Delete trigger...",exact:true}).click();
  await shot("delete-confirm",row(gate.id).locator(".automation-confirm"));
  const revision=getWork().triggers.items.find(x=>x.id===gate.id).revision;start=getSubmissions().length;
  await row(gate.id).getByRole("button",{name:"Delete trigger",exact:true}).click();
  await row(gate.id).waitFor({state:"detached"});assertWrite(start,"DELETE","/triggers/gate-left-open",{revision});
  await landing("deleted-notice",notice);

  for(const [name,options] of [["list-desktop",{width:1440}],["list-dark",{width:1440,theme:"dark"}],["list-phone",{}],["list-narrow",{width:320}],["list-large",{large:true}]]) {
    await setup(options);await shot(name);
  }
  await setup({mode:"readonly"});
  ensure(await section.getByRole("button").evaluateAll(nodes=>nodes.every(n=>n.disabled)),"Readonly trigger control enabled");
  start=getSubmissions().length;await shot("readonly");ensure(getSubmissions().length===start,"Readonly state wrote data");
  await setup({mode:"trigger-platform-off"});
  ensure(await row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}).isDisabled(),"Platform-off enable was not disabled");
  await shot("platform-off",row(gate.id).getByRole("button",{name:"Enable trigger",exact:true}));
  await setup({mode:"sections-unsupported"});await shot("unsupported");
  await setup({mode:"no-routines"});await shot("first-use");
  await setup({mode:"routines-error"});await shot("routines-error",section.getByRole("alert"));
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
  await setup();await row("freezer-alerts").getByRole("button",{name:"Edit trigger",exact:true}).click();
  await landing("edit-form",form());await shot("edit-phone",form().getByLabel("Trigger ID",{exact:true}));
  for(const [name,options,show] of [["secret-phone",{},true],["secret-dark",{theme:"dark"},false],["secret-large",{large:true},true],["secret-narrow",{width:320},true]]) {
    await setup(options);await create();if(show)await reveal();
    await shot(name,secret().getByLabel("Signing secret",{exact:true}));
    geometry.at(-1).wholeSecret=await bounds(secret());
  }
  await setup();await create();await secret().getByRole("button",{name:"I've saved it",exact:true}).click();
  ensure(!await secret().count(),"Acknowledged secret remained mounted");
  ensure(!getWork().triggers.items.find(x=>x.id===fixture.workFixture.newTrigger.id).enabled,"New trigger not disabled");
  await landing("created-notice",notice);await shot("created",row(fixture.workFixture.newTrigger.id).getByRole("heading"));
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
  ensure(paths.length===28&&new Set(paths).size===28,"Expected exactly28 unique trigger baseline images");
  return {title:"Work W3 triggers BEFORE",paths,geometry,workSubmissions:getSubmissions(),workChecks,browserErrors,workCase:"triggers"};
}
