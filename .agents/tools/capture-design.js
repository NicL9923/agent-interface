// Playwright CLI run-code function. Screenshots and a geometry report for a design gate.
async (page, { outputDir = ".private/design-review", prefix = "current", screen = "today", stage = "after", fixture } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const boot = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (boot.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  if (!["today", "home", "conversation", "questions", "approvals", "recovery", "details", "settings", "avatar", "models", "memory"].includes(screen)) throw Error(`Unsupported screen: ${screen}`);
  const context = await page.context().browser().newContext({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  if (["models", "memory"].includes(screen)) await context.addInitScript(screen => { window.name=`wildbots-design-${screen}-capture`; }, screen);
  const tab = await context.newPage();
  const browserErrors = [];
  if (["models", "memory"].includes(screen)) tab.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  tab.on("pageerror", error => browserErrors.push(error.message));
  const pointer = ["questions", "approvals"].includes(screen) ? await context.newCDPSession(tab) : undefined;
  const fontSession = ["details", "conversation"].includes(screen) ? await context.newCDPSession(tab) : undefined;
  if (fontSession) { await fontSession.send("DOM.enable"); await fontSession.send("CSS.enable"); }
  const paths = [], geometry = [];
  let state = "loaded";
  let checked = false;
  let releaseLoading;
  let questionConversation = structuredClone(fixture?.conversation);
  let approvalConversation = structuredClone(fixture?.conversation);
  const approvalSubmissions = [];
  let approvalFailed = false;
  let recoveryConversation = structuredClone(fixture?.conversation);
  let recoveryDraft = { text: "", attachments: [] };
  let recoveryMode = "accepted";
  const recoverySubmissions = [];
  let recoveryReceipt;
  const questionSubmissions = [];
  let questionFailed = false;
  let settingsBots = structuredClone(fixture?.bots || []);
  let settingsSaveFailed = false;
  let settingsLoadFailed = false;
  const modelWarning = fixture?.modelWarning || "This model may cost more than your current model. Confirm the choice before saving.";
  const settingsSubmissions = [];
  const avatarSubmissions = [], portraitPrompts = [];
  let modelFavorites = structuredClone(fixture?.preferences?.modelFavorites || []);
  let inference = structuredClone(fixture?.inference || {});
  let catalogs = {tools: structuredClone(fixture?.tools || []), skills: structuredClone(fixture?.skills || [])};
  const modelFailures = new Set(), modelSubmissions = [];
  let memory = structuredClone(fixture?.memory);
  const memoryFailures = new Set(), memorySubmissions = [], memoryChecks = [];
  let releaseMemoryLoad, releaseMemoryWrite, memoryWriteReady, memoryWriteStarted;
  const memoryDigest = parts => tab.evaluate(async parts => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,"0")).join("");
  }, parts);
  const memoryDocument = async (target, texts) => {
    const saved = memory.documents.find(document => document.target === target);
    saved.entries = await Promise.all(texts.map(async text => ({id:await memoryDigest([memory.profile,target,text]),text})));
    saved.revision = await memoryDigest([memory.profile,target,texts]);
    saved.charCount = [...texts.join(fixture.memoryFixture.delimiter)].length;
  };
  if (screen === "memory") await context.route("**/api/bots/*/memory**", async route => {
    const request=route.request(), method=request.method(), url=new URL(request.url());
    if (!/^\/api\/bots\/ranch\/memory(?:\/(memory|user))?$/.test(url.pathname)) throw Error("Unexpected Memory route");
    if (method === "GET") {
      if (state === "memory-loading") await new Promise(resolve => { releaseMemoryLoad=resolve; });
      if (state === "memory-load-error" && !memoryFailures.has("read")) {
        memoryFailures.add("read"); return route.fulfill({status:409,json:{error:fixture.memoryMessages.loadError}});
      }
      if (state === "memory-reload-error" && memoryFailures.has("write") && !memoryFailures.has("reload")) {
        memoryFailures.add("reload"); return route.fulfill({status:409,json:{error:fixture.memoryMessages.loadError}});
      }
      return route.fulfill({json:memory});
    }
    if (!["PATCH","DELETE"].includes(method)) throw Error("Unexpected Memory write method");
    const target=url.pathname.split("/").at(-1), document=memory.documents.find(row=>row.target===target);
    const body=request.postDataJSON(); memorySubmissions.push({method,target,body});
    const reject=(status,error)=>route.fulfill({status,json:{error}});
    if (!document || !/^[a-f0-9]{64}$/.test(body.revision)) throw Error("Memory write must use a real target and revision");
    if (body.revision!==document.revision) return reject(409,fixture.memoryMessages.conflict);
    if (!document.enabled) return reject(409,fixture.memoryMessages.disabled);
    if (["memory-conflict","memory-paused","memory-reload-error"].includes(state) && !memoryFailures.has("write")) {
      memoryFailures.add("write");
      if (state === "memory-conflict") await memoryDocument(target,[...document.entries.map(entry=>entry.text),fixture.memoryFixture.externalEntry]);
      return reject(409,fixture.memoryMessages[state === "memory-conflict" ? "conflict" : "paused"]);
    }
    let texts;
    if (method === "DELETE") {
      if (Object.keys(body).sort().join()!=="entryId,revision" || !document.entries.some(entry=>entry.id===body.entryId)) throw Error("Forget must name one current entry");
      texts=document.entries.filter(entry=>entry.id!==body.entryId).map(entry=>entry.text);
    } else {
      if (Object.keys(body).sort().join()!=="entries,revision" || !Array.isArray(body.entries) || body.entries.length>100) throw Error("Invalid Memory replacement payload");
      if (body.entries.some(entry=>Object.keys(entry).some(key=>!["id","text"].includes(key)) || typeof entry.text!=="string" || !entry.text.trim() || (entry.id && !document.entries.some(saved=>saved.id===entry.id)))) throw Error("Memory entries must retain their current IDs");
      texts=body.entries.map(entry=>entry.text.trim());
      if (new Set(texts).size!==texts.length) return reject(400,"Memory entries must be unique.");
      if ([...texts.join(fixture.memoryFixture.delimiter)].length>document.charLimit) return reject(400,fixture.memoryMessages.tooLong);
    }
    if (state === "memory-busy") await new Promise(resolve => { releaseMemoryWrite=resolve; memoryWriteReady?.(); });
    await memoryDocument(target,texts);
    memory.refresh={revision:fixture.memoryFixture.refreshRevision,state:"next_turn",busy:false,message:fixture.memoryMessages.nextTurn};
    return route.fulfill({json:memory});
  });
  let avatarSaveFailed = false;
  for (const [path, encoded] of Object.entries(fixture?.images || {})) {
    await context.route(`**${path}`, route => route.fulfill({ contentType: "image/png", body: Buffer.from(encoded, "base64") }));
  }
  await context.route("**/api/bots/*/conversation*", async route => {
    if (!["conversation", "questions", "approvals", "recovery", "details", "settings", "avatar", "models", "memory"].includes(screen) || !fixture?.conversation) return route.continue();
    if (screen === "details") {
      const conversation = structuredClone(fixture.conversation);
      conversation.earlierFiles = state === "earlier-error" ? 1 : 0;
      if (state === "files-empty") {
        conversation.files = [];
        conversation.messages = conversation.messages.map(message => ({...message, files:[]}));
      }
      if (state === "failed-profile") conversation.activity = {state:"failed", detail:"The gate service did not answer."};
      if (state === "blocked-profile") conversation.activity = {state:"blocked", detail:"Waiting for your decision."};
      return route.fulfill({json:conversation});
    }
    return route.fulfill({ json: screen === "questions" ? questionConversation : screen === "approvals" ? approvalConversation : screen === "recovery" ? { ...recoveryConversation, draft: recoveryDraft } : fixture.conversation });
  });
  if (screen === "questions") await context.route("**/api/bots/*/requests/fixture-question", async route => {
    questionSubmissions.push(route.request().postDataJSON());
    if (fixture.answerError && !questionFailed) {
      questionFailed = true;
      return route.fulfill({ status: 503, json: { error: fixture.answerError } });
    }
    questionConversation = structuredClone(fixture.afterAnswer);
    return route.fulfill({ json: { ok: true } });
  });
  if (screen === "approvals") await context.route("**/api/bots/*/approvals/fixture-approval", async route => {
    const submission = route.request().postDataJSON();
    approvalSubmissions.push(submission);
    await new Promise(resolve => setTimeout(resolve, 300));
    if (fixture.decisionError && !approvalFailed) {
      approvalFailed = true;
      return route.fulfill({ status: 503, json: { error: fixture.decisionError } });
    }
    approvalConversation = structuredClone(submission.decision === "approved" ? fixture.afterApproved : fixture.afterDenied);
    return route.fulfill({ json: { ok: true } });
  });
  if (screen === "recovery") {
    await context.route("**/api/bots/*/draft", route => {
      if (route.request().method() === "PUT") recoveryDraft = route.request().postDataJSON();
      return route.fulfill({ json: recoveryDraft });
    });
    await context.route("**/api/bots/*/messages", async route => {
      const body = route.request().postDataJSON(); recoverySubmissions.push(body);
      if (!body.retryOf || "draftBaseRevision" in body) throw Error("A retry must name its turn and leave the draft alone.");
      recoveryReceipt = { requestId: body.requestId, status: recoveryMode === "refused" ? "rejected" : recoveryMode === "checking" ? "uncertain" : "accepted",
        ...(recoveryMode === "refused" ? { message: fixture.refusalReason } : {}) };
      if (recoveryMode === "accepted") recoveryConversation = structuredClone(fixture.afterRetry);
      else recoveryConversation.retry = { ...recoveryReceipt, retryOf: body.retryOf };
      return route.fulfill({ json: recoveryReceipt });
    });
    await context.route("**/api/submissions/*", route => route.fulfill({ json: recoveryReceipt || { requestId: "fixture", status: "uncertain" } }));
  }
  if (screen === "details") {
    await context.route("**/api/files/*", route => {
      const path = new URL(route.request().url()).pathname;
      if (fixture.images?.[path]) return route.fulfill({contentType:"image/png",body:Buffer.from(fixture.images[path],"base64")});
      const response = fixture.fileResponses?.[path];
      return response ? route.fulfill({status:response.status || 200,contentType:response.mime,body:response.body}) : route.continue();
    });
    await context.route("**/api/bots/*/files*", route => state === "earlier-error" ? route.fulfill({status:503,json:{error:"Earlier files unavailable."}}) : route.fulfill({json:{messages:[]}}));
  }
  if (["settings", "avatar", "models", "memory"].includes(screen)) {
    await context.route("**/api/bots/*", route => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      const bot = settingsBots.find(item => item.id === id);
      if (route.request().method() === "GET") {
        if (state === "load-error" && !settingsLoadFailed) {
          settingsLoadFailed = true;
          return route.fulfill({status:503, json:{error:fixture.loadError}});
        }
        return route.fulfill({json:bot});
      }
      const body = route.request().postDataJSON();
      settingsSubmissions.push({method:route.request().method(), id, body});
      if (["model-confirm", "composer-confirm"].includes(state) && !body.confirmModel) return route.fulfill({status:409,json:{error:modelWarning,confirmRequired:true}});
      if (screen === "models" && state === "model-save-error" && !settingsSaveFailed) { settingsSaveFailed=true; return route.fulfill({status:503,json:{}}); }
      if (state === "save-error" && !settingsSaveFailed) {
        settingsSaveFailed = true;
        return route.fulfill({status:503, json:{error:fixture.saveError}});
      }
      Object.assign(bot, body);
      return route.fulfill({json:bot});
    });
    await context.route("**/api/bots", route => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      settingsSubmissions.push({method:"POST",body});
      const bot = {...body,id:"created-1",activity:"idle"}; settingsBots.push(bot);
      return route.fulfill({json:bot});
    });
    await context.route("**/api/bots/*/avatar", route => {
      const body = route.request().postDataJSON();
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      const failed = state === "save-error" && !avatarSaveFailed;
      avatarSubmissions.push({id,body,failed});
      if (failed) { avatarSaveFailed=true; return route.fulfill({status:503,json:{error:fixture.avatarSaveError}}); }
      Object.assign(settingsBots.find(bot => bot.id === id), {avatar:body});
      return route.fulfill({json:body});
    });
  }
  if (screen === "avatar") await context.route("**/api/bots/*/portrait", async route => {
    portraitPrompts.push(route.request().postDataJSON().prompt);
    await new Promise(resolve => setTimeout(resolve,1500));
    return route.fulfill({json:{id:"fixture-generated-portrait",name:"ranch-portrait.png",mime:"image/png",url:"/api/files/fixture-generated-portrait"}});
  });
  if (screen === "models") {
    const failOnce = key => !modelFailures.has(key) && (modelFailures.add(key), true);
    await context.route("**/api/models*", route => {
      if (state === "models-error" && failOnce(state)) return route.fulfill({status:503,json:{error:fixture.catalogError}});
      const catalog = structuredClone(fixture.catalog);
      if (state === "catalog-empty") catalog.providers = [];
      return route.fulfill({json:catalog});
    });
    await context.route("**/api/preferences/models", route => {
      const body = route.request().postDataJSON();
      const failed = state === "favorite-error" && failOnce(state);
      modelSubmissions.push({kind:"favorites",body,failed});
      if (failed) return route.fulfill({status:503,json:{error:fixture.favoriteError}});
      modelFavorites = body.modelFavorites;
      return route.fulfill({json:{modelFavorites}});
    });
    await context.route("**/api/bots/*/inference", route => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON(), failed = state === "inference-error" && body.reasoning === "ultra" && failOnce(state);
        modelSubmissions.push({kind:"inference",body,failed});
        if (failed) return route.fulfill({status:503,json:{error:fixture.inferenceError}});
        Object.assign(inference,body);
      }
      return route.fulfill({json:inference});
    });
    for (const kind of ["tools", "skills"]) await context.route(`**/api/bots/*/${kind}`, route => {
      if (route.request().method() === "GET") {
        if (state === "capabilities-load-error" && failOnce(`load-${kind}`)) return route.fulfill({status:503,json:{error:fixture.capabilityLoadError}});
        return route.fulfill({json:state === "capabilities-empty" ? [] : catalogs[kind]});
      }
      const body = route.request().postDataJSON(), failed = state === "capabilities-save-error" && failOnce(`save-${kind}`);
      modelSubmissions.push({kind,body,failed});
      if (failed) return route.fulfill({status:503,json:{error:(kind==="skills"?fixture.skillSaveError:fixture.capabilitySaveError)}});
      const ids = new Set(body.ids), known = new Set(catalogs[kind].map(item => item.id));
      if (body.ids.some(id => !known.has(id)) ) throw Error("Unknown catalog choice.");
      catalogs[kind] = catalogs[kind].map(item => ({...item,enabled:ids.has(item.id)}));
      return route.fulfill({json:{ok:true}});
    });
  }
  await context.route("**/api/today", async route => {
    if (!fixture?.overview || screen !== "today") return route.continue();
    const value = structuredClone(fixture.overview);
    if (state === "loading") await new Promise(resolve => { releaseLoading = resolve; });
    if (state === "error" && checked) return route.fulfill({ status: 503, json: { error: "The connection was interrupted." } });
    if (state === "all-clear") { value.items = []; value.events = []; value.upcoming = []; }
    if (state === "partial") {
      const item = value.items.find(item => item.botId === "guide") || value.items[0];
      item.activity = { state: "disconnected" };
      item.error = "Could not read this Hermes conversation. Open it to reconnect.";
      item.approvals = []; item.attention = [];
      value.unavailableBots = [item.botId];
    }
    if (state === "paged") value.hasMore = true;
    checked = true;
    return route.fulfill({ json: value });
  });
  await context.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    const value = await response.json();
    if (fixture) value.bots = state === "empty" ? [] : fixture.bots;
    if (["settings", "avatar", "models", "memory"].includes(screen)) {
      value.bots = settingsBots.map(({instructions, enabledMcpServers, ...roster}) => roster);
      if (state === "unsupported") value.capabilities.botConfiguration = {supported:false,reason:fixture.unsupportedReason};
    }
    if (screen === "avatar" && state === "portrait-unavailable") {
      value.capabilities.uploads={supported:false,reason:fixture.uploadsReason};
      value.capabilities.portraitGeneration={supported:false,reason:fixture.generationReason};
    }
    if (screen === "recovery" && state === "unsupported-retry") value.capabilities.idempotency = { supported: false, reason: "This Hermes connection cannot look up requests." };
    if (screen === "approvals" && state === "unsupported") value.capabilities.approvals = { supported: false, reason: fixture.unsupportedReason };
    if (fixture?.preferences) value.preferences = { ...value.preferences, ...fixture.preferences };
    if (screen === "models") {
      value.preferences.modelFavorites = modelFavorites;
      if (state === "capabilities-unavailable") for (const kind of ["tools", "skills"]) value.capabilities[kind] = {supported:false, reason:fixture.capabilityUnsupportedReason};
    }
    if (screen === "avatar" && state === "composer-regression") value.preferences.presentation = "advanced";
    if (screen === "home" && state === "three-pins") value.preferences.favorites = ["ranch", "garden", "kitchen"];
    if (screen === "home" && state === "no-pins") value.preferences.favorites = [];
    return route.fulfill({ response, json: value });
  });
  const capture = async (name, width, height, theme = "light") => {
    await tab.setViewportSize({ width, height });
    if (pointer) await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
    await tab.emulateMedia({ colorScheme: theme });
    // Await the React media-query update, fonts and at least two painted frames.
    await tab.evaluate(async ({ theme, width, height }) => {
      document.documentElement.dataset.theme = theme;
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (innerWidth !== width || innerHeight !== height) throw Error("Viewport did not settle.");
    }, { theme, width, height });
    if (!/menu|focus/.test(name)) {
      await tab.mouse.move(width - 1, height - 1);
      await tab.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    }
    const path = `${outputDir}/${prefix}-${screen}-${name}.png`;
    if (screen === "home" && name.startsWith("desktop") && !name.includes("menu")) {
      await tab.locator(".bot-rail").screenshot({ path, animations: "disabled" });
    } else { await tab.screenshot({ path, animations: "disabled" }); }
    paths.push(path);
    geometry.push({ name, width, height, ...await tab.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      column: document.querySelector(".today-content")?.getBoundingClientRect().width,
      attention: [...document.querySelectorAll(".today-attention-list .today-row")].map(row => {
        const { top, bottom } = row.getBoundingClientRect();
        return { top, bottom, label: row.textContent };
      }),
    })) });
    if (screen === "details") geometry.at(-1).details = await tab.evaluate(() => {
      const selected = document.querySelector(".artifact-item.selected");
      const metadata = selected?.querySelector("small");
      const preview = document.querySelector(".artifact-text-preview pre");
      const status = document.querySelector(".bot-details-facts .bot-activity");
      const icon = document.querySelector(".bot-details-actions .artifacts-button-icon .icon");
      const badge = document.querySelector(".bot-details-actions .artifacts-count");
      const bounds = element => element && ({x:element.getBoundingClientRect().x, y:element.getBoundingClientRect().y, width:element.getBoundingClientRect().width, height:element.getBoundingClientRect().height});
      return {
        metadata: metadata && {color:getComputedStyle(metadata).color, background:getComputedStyle(selected).backgroundColor},
        previewFont: preview && getComputedStyle(preview).fontFamily,
        status: status && {label:status.textContent, classes:status.className, color:getComputedStyle(status).color},
        icon:bounds(icon), badge:bounds(badge),
        list:bounds(document.querySelector(".artifacts-list")),
        rows:[...document.querySelectorAll(".artifact-item")].slice(0, 2).map(bounds),
      };
    });
    if (fontSession) {
      const {root} = await fontSession.send("DOM.getDocument");
      const selector = screen === "details" ? ".artifact-text-preview pre" : ".message-markdown pre code";
      const {nodeId} = await fontSession.send("DOM.querySelector", {nodeId:root.nodeId, selector});
      if (nodeId) geometry.at(-1).renderedCodeFonts = (await fontSession.send("CSS.getPlatformFontsForNode", {nodeId})).fonts;
    }
  };
  try {
    if (screen === "memory") {
      const dialog=tab.locator(".settings-dialog"), panel=dialog.locator(".memory-panel");
      const doc=target=>panel.locator(`[data-memory-target="${target}"]`);
      const save=target=>doc(target).getByRole("button",{name:"Save memories",exact:true});
      const reload=()=>panel.getByRole("button",{name:/^(Reload profile memory|Try loading again)$/});
      const reloadMemory=async (capturePrompt=false)=>{
        const response=tab.waitForResponse(response=>response.request().method()==="GET" && new URL(response.url()).pathname==="/api/bots/ranch/memory");
        await reload().click();
        if(stage==="after") {
          const prompt=tab.getByRole("alertdialog",{name:"Reload profile memory?"});
          await prompt.waitFor();
          if(capturePrompt) await shot("reload-confirmation");
          await prompt.getByRole("button",{name:"Reload and discard edits",exact:true}).click();
        }
        await response;
      };
      const reset=async ({width=390,theme="light",large=false,mode="loaded"}={})=>{
        releaseMemoryLoad?.(); releaseMemoryLoad=undefined; releaseMemoryWrite?.(); releaseMemoryWrite=undefined;
        state=`memory-${mode}`; memory=structuredClone(fixture.memoryStates?.[mode] || fixture.memory);
        memoryFailures.clear(); settingsBots=structuredClone(fixture.bots);
        await tab.setViewportSize({width,height:width>1000?1000:844});
        await tab.emulateMedia({colorScheme:theme});
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await tab.evaluate(({large,theme})=>{document.documentElement.style.fontSize=large?"200%":"";document.documentElement.dataset.theme=theme;},{large,theme});
        await tab.locator('.chat-header [title="Details, pin, artifacts and settings"]').click();
        await tab.locator(".bot-details").getByRole("button",{name:"Settings",exact:true}).click();
        await dialog.waitFor();
        const overflow=dialog.locator(".settings-tabs-overflow");
        if(await overflow.count()) await overflow.locator("summary").click();
        await dialog.getByRole("button",{name:"memory",exact:true}).click();
        await panel.waitFor();
        if(!["loading","load-error"].includes(mode)) await doc("memory").waitFor();
      };
      const shot=async (name,width=390,theme="light")=>{
        await capture(name,width,width>1000?1000:844,theme);
        geometry.at(-1).memory=await panel.evaluate(el=>{
          const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
          return {panel:rect(el),documents:[...el.querySelectorAll('[data-memory-target]')].map(section=>({target:section.dataset.memoryTarget,...rect(section),
            fields:[...section.querySelectorAll('textarea')].map(field=>({disabled:field.disabled,readOnly:field.readOnly,value:field.value,...rect(field)}))})),
            errors:[...el.querySelectorAll('[role="alert"]')].map(node=>({text:node.textContent,...rect(node)})),
            statuses:[...el.querySelectorAll('[role="status"]')].map(node=>node.textContent)};
        });
      };
      const failure=()=>panel.getByRole("alert").filter({hasText:memoryFailures.has("write") && ["memory-paused","memory-reload-error"].includes(state) ? fixture.memoryMessages.paused : fixture.memoryMessages.conflict});
      const visibleError=async (name,focused=false)=>{
        const bounds=()=>tab.evaluate(()=>{
          const error=document.querySelector('[data-memory-target="memory"] [role="alert"]'),view=document.querySelector('.settings-content');
          const rect=el=>{const r=el?.getBoundingClientRect();return r&&{top:r.top,bottom:r.bottom,height:r.height};};
          return {error:rect(error),view:rect(view),scrollTop:view?.scrollTop,focusedError:document.activeElement===error,
            active:document.activeElement?.outerHTML.slice(0,180),scrollMarginTop:error&&getComputedStyle(error).scrollMarginTop};
        });
        try {
          await tab.waitForFunction(focused=>{
            const error=document.querySelector('[data-memory-target="memory"] [role="alert"]'),view=document.querySelector('.settings-content');
            const box=error?.getBoundingClientRect(),area=view?.getBoundingClientRect();
            return box&&area&&box.top>=area.top&&box.bottom<=area.bottom&&(!focused||document.activeElement===error);
          },focused,{timeout:5000});
        } catch(cause) {
          await tab.screenshot({path:`${outputDir}/${prefix}-${screen}-${name}.failed.png`}).catch(()=>{});
          throw Error(`${name}: error is not fully visible: ${JSON.stringify(await bounds())}`,{cause});
        }
        memoryChecks.push({name,...await bounds()});
      };
      const fillFirst=async target=>doc(target).locator("textarea").first().fill(fixture.memoryFixture.editEntry);
      for(const [name,width,theme,large] of [
        ["desktop",1440,"light",false],["phone",390,"light",false],["narrow",320,"light",false],
        ["tablet",768,"light",false],["dark",390,"dark",false],["large-text",390,"light",true],
      ]) {
        await reset({width,theme,large}); await shot(name,width,theme);
        if(name==="desktop") {
          const savedNoticeVisible=await panel.getByText(fixture.memory.refresh.message,{exact:true}).isVisible();
          memoryChecks.push({name:"initial-refresh",savedNoticeVisible});
          if(stage==="after" && savedNoticeVisible) throw Error("Initial Memory read announces an unsolicited save.");
        }
        if(stage==="after" && ["phone","narrow","dark","large-text"].includes(name)) {
          const long=doc("memory").locator("textarea").nth(2);
          await long.scrollIntoViewIfNeeded(); await shot(`${name}-long-entry`,width,theme);
          const sizing=await long.evaluate(el=>({height:el.clientHeight,content:el.scrollHeight}));
          if(sizing.content>sizing.height+1 && !await doc("memory").getByText("Scroll within this entry to read more.",{exact:true}).count()) throw Error("Long memory is clipped without a scroll cue.");
          memoryChecks.push({name:`${name}-long-entry`,sizing});
          if(name==="large-text") {
            await save("memory").scrollIntoViewIfNeeded(); await shot("large-text-actions",width,theme);
          }
        }
      }
      await reset({mode:"loading"});
      await panel.getByText("Loading profile memory...",{exact:true}).waitFor(); await shot("loading");
      if(!releaseMemoryLoad) throw Error("Memory loading response was not held.");
      state="memory-loaded"; releaseMemoryLoad(); releaseMemoryLoad=undefined;
      await doc("memory").waitFor();
      await reset({mode:"load-error"});
      await panel.getByText(fixture.memoryMessages.loadError,{exact:true}).waitFor(); await shot("load-error");
      await panel.getByRole("button",{name:"Try loading again",exact:true}).click();
      await doc("memory").waitFor(); await shot("retried");
      for(const width of [1440,320]) {
        await reset({width}); await fillFirst("memory");
        await doc("memory").getByRole("button",{name:"Add memory",exact:true}).click();
        if(stage==="after") await tab.waitForFunction(()=>document.querySelector('[data-memory-target="memory"] textarea:last-of-type') && [...document.querySelectorAll('[data-memory-target="memory"] textarea')].at(-1)===document.activeElement);
        await doc("memory").locator("textarea").last().fill(fixture.memoryFixture.newEntry);
        await shot(`dirty-${width}`,width);
      }
      await reset();
      const otherRevision=memory.documents[1].revision;
      const otherDraft=`${memory.documents[1].entries[0].text} Keep this draft.`;
      await doc("user").locator("textarea").first().fill(otherDraft);
      await fillFirst("memory");
      await doc("memory").getByRole("button",{name:"Add memory",exact:true}).click();
      await doc("memory").locator("textarea").last().fill(fixture.memoryFixture.newEntry);
      const savedRevision=memory.documents[0].revision;
      if(stage==="after") {
        await dialog.getByRole("button",{name:"Close assistant settings",exact:true}).click();
        await dialog.getByText("Discard your unsaved changes?",{exact:true}).waitFor(); await shot("close-confirmation");
        await dialog.getByRole("button",{name:"Keep editing",exact:true}).click();
        await dialog.getByRole("button",{name:"details",exact:true}).click();
        const leave=tab.getByRole("alertdialog",{name:"Leave memory without saving?"}); await leave.waitFor(); await shot("leave-confirmation");
        await leave.getByRole("button",{name:"Keep editing",exact:true}).click();
        if(await doc("user").locator("textarea").first().inputValue()!==otherDraft) throw Error("Keep editing lost the other draft.");
        state="memory-busy"; memoryWriteStarted=new Promise(resolve=>{memoryWriteReady=resolve;});
      }
      await save("memory").click();
      if(stage==="after") {
        await memoryWriteStarted;
        await panel.getByText("Saving memories in Hermes...",{exact:true}).waitFor();
        await tab.waitForFunction(()=>document.querySelector('.memory-panel > button')?.disabled && document.querySelector('[aria-label="Close assistant settings"]')?.disabled,undefined,{timeout:5000});
        if(!releaseMemoryWrite) throw Error("Memory write interception was not held.");
        await shot("saving"); state="memory-loaded"; releaseMemoryWrite(); releaseMemoryWrite=undefined;
      }
      await panel.getByText(fixture.memoryMessages.nextTurn,{exact:true}).waitFor();
      if(memory.documents[0].revision===savedRevision || !memory.documents[0].entries.some(entry=>entry.text===fixture.memoryFixture.newEntry)) throw Error("Memory save did not persist.");
      if(await doc("user").locator("textarea").first().inputValue()!==otherDraft || memory.documents[1].revision!==otherRevision) throw Error("Saving one document lost the other draft.");
      memoryChecks.push({name:"independent-drafts",preserved:true,otherRevision});
      await shot("saved");
      await reset();
      const beforeDelete=memory.documents[1].entries[0];
      await doc("user").getByRole("button",{name:"Forget...",exact:true}).first().click();
      await shot("forget-confirmation");
      const deleteCount=memorySubmissions.filter(row=>row.method==="DELETE").length;
      await doc("user").getByRole("button",{name:"Keep it",exact:true}).click();
      if(memorySubmissions.filter(row=>row.method==="DELETE").length!==deleteCount) throw Error("Keep submitted a deletion.");
      await doc("user").getByRole("button",{name:"Forget...",exact:true}).first().click();
      await doc("user").getByRole("button",{name:"Forget entry",exact:true}).click();
      await tab.waitForFunction(text=>![...document.querySelectorAll('[data-memory-target="user"] textarea')].some(field=>field.value===text),beforeDelete.text);
      if(memory.documents[1].entries.some(entry=>entry.id===beforeDelete.id)) throw Error("Forgotten entry remains in transport state.");
      memoryChecks.push({name:"forget",keptWithoutWrite:true,deletedEntryId:beforeDelete.id});
      for(const width of [1440,320]) {
        await reset({width,mode:"conflict"}); await fillFirst("memory"); await save("memory").click(); await failure().waitFor();
        await shot(`conflict-${width}`,width);
        const field=doc("memory").locator("textarea").first();
        const selection=await field.evaluate(el=>{el.focus();if(!el.disabled)el.setSelectionRange(0,el.value.length);return {disabled:el.disabled,readOnly:el.readOnly,focused:document.activeElement===el,selectionStart:el.selectionStart,selectionEnd:el.selectionEnd};});
        memoryChecks.push({name:`conflict-${width}`,selection});
        if(stage==="after") {
          if(selection.disabled || !selection.readOnly || !selection.focused || selection.selectionEnd<=selection.selectionStart) throw Error("Conflicted draft cannot be selected.");
          await shot(`conflict-draft-focus-${width}`,width);
        }
        await reloadMemory();
        await doc("memory").locator("textarea").last().waitFor();
        await tab.waitForFunction(text=>[...document.querySelectorAll('[data-memory-target="memory"] textarea')].some(field=>field.value===text),fixture.memoryFixture.externalEntry);
      }
      await reset({mode:"paused"}); await fillFirst("memory"); await save("memory").click(); await failure().waitFor();
      await reloadMemory(stage==="after");
      await tab.waitForFunction(()=>!document.querySelector('.memory-panel')?.textContent.includes('Loading profile memory...'));
      memoryChecks.push({name:"same-revision-reload",fieldDisabled:await doc("memory").locator("textarea").first().isDisabled(),fieldReadOnly:await doc("memory").locator("textarea").first().evaluate(el=>el.readOnly),draft:await doc("memory").locator("textarea").first().inputValue()});
      await shot("same-revision-reload");
      await reset({mode:"paused"}); await fillFirst("memory"); await save("memory").click(); await failure().waitFor();
      await doc("memory").getByRole("button",{name:"Discard edits",exact:true}).click();
      memoryChecks.push({name:"conflict-discard",fieldDisabled:await doc("memory").locator("textarea").first().isDisabled()});
      if(stage==="after") {
        await visibleError("discard-lock-reason");
      }
      await shot("conflict-discard");
      for(const mode of ["disabled","empty","too-long"]) {
        await reset({mode});
        if(mode==="too-long") {
          const field=doc("memory").locator("textarea").first();
          await field.fill(`${await field.inputValue()}${fixture.memoryFixture.limitEditSuffix}`);
          if(stage==="after") {
            if(!await save("memory").isDisabled()) throw Error("An over-limit document can be saved.");
            const limit=doc("memory").locator(".memory-limit"); await limit.waitFor(); await limit.scrollIntoViewIfNeeded();
          } else { await save("memory").click(); await panel.getByText(fixture.memoryMessages.tooLong,{exact:true}).waitFor(); }
        }
        if(stage==="after" && mode==="disabled") await doc("user").locator("h3").scrollIntoViewIfNeeded();
        await shot(mode);
      }
      if(stage==="after") {
        for(const [name,theme,large] of [["dark-conflict","dark",false],["large-text-conflict","light",true]]) {
          await reset({theme,large,mode:"conflict"}); await fillFirst("memory"); await save("memory").click(); await failure().waitFor();
          await visibleError(name,true);
          await shot(name,390,theme);
        }
        await reset({mode:"reload-error"}); await fillFirst("memory"); await save("memory").click(); await failure().waitFor();
        await reloadMemory(); await panel.getByText(fixture.memoryMessages.loadError,{exact:true}).waitFor();
        if(await doc("memory").locator("textarea").first().inputValue()!==fixture.memoryFixture.editEntry) throw Error("Failed reload lost the draft.");
        await shot("reload-failed"); await reloadMemory();
        await tab.waitForFunction(text=>document.querySelector('[data-memory-target="memory"] textarea')?.value===text,fixture.memory.documents[0].entries[0].text);
        await shot("reload-recovered");
      }
      if(browserErrors.length || geometry.some(row=>row.overflow)) throw Error(`Memory capture failed: ${JSON.stringify({browserErrors,overflow:geometry.filter(row=>row.overflow)})}`);
      return {paths,geometry,memorySubmissions,memoryChecks,browserErrors};
    }
    if (screen === "models") {
      const dialog = tab.locator(".settings-dialog");
      const modelChecks = [];
      const reset = async ({width=390,theme="light",large=false,savedUnavailable=false,denseTools=false}={}) => {
        settingsSaveFailed=false; settingsBots=structuredClone(fixture.bots); modelFavorites=structuredClone(fixture.preferences.modelFavorites || []);
        if(savedUnavailable) Object.assign(settingsBots[0],{provider:"field",model:"field-planner"});
        inference=structuredClone(fixture.inference); catalogs={tools:structuredClone(fixture.tools),skills:structuredClone(fixture.skills)};
        if(denseTools) catalogs.tools=structuredClone(fixture.longTools);
        modelFailures.clear();
        await tab.setViewportSize({width,height:width>1000?1000:844});
        await tab.emulateMedia({colorScheme:theme});
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await tab.evaluate(({large,theme}) => {document.documentElement.style.fontSize=large?"200%":"";document.documentElement.dataset.theme=theme;},{large,theme});
      };
      const settings = async kind => {
        await tab.locator('.chat-header [title="Details, pin, artifacts and settings"]').click();
        await tab.locator(".bot-details").getByRole("button",{name:"Settings",exact:true}).click();
        await dialog.waitFor();
        if (kind !== "models") {
          const overflow=dialog.locator(".settings-tabs-overflow");
          if (await overflow.count()) await overflow.locator("summary").click();
          await dialog.getByRole("button",{name:kind,exact:true}).click();
        } else {
          await dialog.locator(".model-picker > summary").click();
          await dialog.getByRole("searchbox",{name:"Search models"}).waitFor();
        }
      };
      const composer = async () => {
        await tab.getByRole("button",{name:/^Model: /}).click();
        await tab.getByRole("dialog",{name:"Choose a model"}).waitFor();
      };
      const shot = async (name,width=390,theme="light") => {
        await capture(name,width,width>1000?1000:844,theme);
        geometry.at(-1).models=await tab.evaluate(()=>{
          const pane=document.querySelector(".model-popover");
          const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
          return {popup:pane&&rect(pane),popupOverflowX:pane&&pane.scrollWidth>pane.clientWidth,
            targets:pane?[...pane.querySelectorAll('.model-choice,.model-favorite,.model-refresh,.model-search input,[role="radio"],.icon-button')].map(el=>({label:el.getAttribute("aria-label")||el.textContent,...rect(el)})).filter(r=>r.width>0):[],
            confirmation:[...document.querySelectorAll('[role="alertdialog"][open] button')].map(el=>({label:el.textContent,...rect(el)}))};
        });
        if(stage==="after" && geometry.at(-1).models.popupOverflowX) throw Error("Model popup overflows horizontally.");
        if(stage==="after" && geometry.at(-1).models.targets.some(target=>target.width<43.9||target.height<43.9)) throw Error("A model control is smaller than 44 pixels.");
      };
      for (const [name,width,theme,large] of [
        ["desktop",1440,"light",false],["phone",390,"light",false],["dark",390,"dark",false],["large-text",390,"light",true],
      ]) {
        state="loaded";
        for (const kind of ["models","tools","skills"]) {
          await reset({width,theme,large}); await settings(kind);
          await (kind==="models" ? dialog.getByRole("button",{name:"daily-planner",exact:true}).first() : dialog.locator(".capability-item").first()).waitFor();
          await shot(`${kind}-${name}`,width,theme);
          if (kind === "skills") {
            const required=dialog.getByRole("checkbox").first();
            if (!await required.isChecked() || await required.isEnabled()) throw Error("Required skill must remain checked and disabled.");
          }
        }
        await reset({width,theme,large}); await composer();
        await tab.locator(".inference-controls").getByRole("radiogroup",{name:"Reasoning",exact:true}).waitFor();
        await shot(`composer-${name}`,width,theme);
        if(large && stage==="after") { await tab.getByRole("radio",{name:"Ultrafast",exact:true}).scrollIntoViewIfNeeded(); await shot("composer-settings-large-text",width,theme); }
      }
      for (const width of [320,768]) { state="loaded"; await reset({width}); await composer(); await shot(`composer-width-${width}`,width); }
      state="loaded"; await reset(); await settings("models");
      await dialog.locator(".model-provider").filter({hasText:"Household provider"}).getByRole("button",{name:"daily-planner",exact:true}).click();
      const aliasSelectedRows=await dialog.locator('.model-choice[aria-pressed="true"]').count();
      modelChecks.push({aliasSelectedRows});
      if(stage==="after" && aliasSelectedRows!==2) throw Error("Alias favorite lost its selected state.");
      const search=dialog.getByRole("searchbox",{name:"Search models"});
      await search.fill("field"); await shot("model-search");
      await search.fill("no such model"); await dialog.getByText("No models match your search.",{exact:true}).waitFor(); await shot("model-no-results");
      await search.fill("field");
      const offline=dialog.locator(".model-choice").filter({hasText:"field-planner"});
      if(await offline.isEnabled()) throw Error("Unavailable model can be selected.");
      await offline.scrollIntoViewIfNeeded(); await shot("model-unavailable");
      await search.fill("");
      state="favorite-error"; const star=dialog.getByRole("button",{name:"Add quick-reply to favorites",exact:true});
      await star.click(); await dialog.getByText(fixture.favoriteError,{exact:true}).waitFor(); await shot("favorite-error");
      if(await star.getAttribute("aria-label")!=="Add quick-reply to favorites") throw Error("Failed favorite write changed selection.");
      await star.click(); await dialog.getByRole("button",{name:"Remove quick-reply from favorites",exact:true}).first().waitFor();
      await dialog.locator(".model-picker-content").evaluate(el=>{el.scrollTop=0;}); await shot("favorite-saved");
      for(const mode of ["models-error","catalog-empty"]) {
        state=mode; await reset(); await composer();
        await tab.getByText(mode==="models-error"?fixture.catalogError:"No connected models were reported. Connect a provider in Hermes, then retry.",{exact:true}).waitFor();
        await shot(mode);
        if(mode==="models-error") {
          await tab.getByRole("button",{name:"Retry loading models",exact:true}).click();
          await tab.getByRole("button",{name:"daily-planner",exact:true}).first().waitFor(); await shot("models-retried");
        }
      }
      state="inference-error"; await reset(); await composer();
      await tab.getByRole("radio",{name:"Ultra",exact:true}).click();
      await tab.getByText(fixture.inferenceError,{exact:true}).waitFor(); await shot("inference-error");
      if(inference.reasoning!==fixture.inference.reasoning) throw Error("Failed inference write changed saved value.");
      await tab.getByRole("radio",{name:"Fast",exact:true}).click();
      await tab.waitForFunction(()=>[...document.querySelectorAll('.inference-controls [role="radio"]')].some(el=>el.textContent==="Fast"&&el.getAttribute("aria-checked")==="true"));
      if(inference.speed!=="fast") throw Error("Inference retry was not saved.");
      await shot("inference-saved");
      state="composer-confirm"; await tab.getByRole("button",{name:"quick-reply",exact:true}).first().click();
      await tab.getByRole("button",{name:stage==="before"?"Confirm this model":"Use this model",exact:true}).waitFor(); await shot("composer-confirm");
      const writesBeforeCancel=settingsSubmissions.length;
      await tab.getByRole("button",{name:"Cancel",exact:true}).click();
      if(settingsSubmissions.length!==writesBeforeCancel || settingsBots[0].model!==fixture.bots[0].model) throw Error("Cancel wrote a model.");
      await tab.getByRole("button",{name:"quick-reply",exact:true}).first().click();
      await tab.getByRole("button",{name:stage==="before"?"Confirm this model":"Use this model",exact:true}).click();
      await tab.getByRole("dialog",{name:"Choose a model"}).waitFor({state:"hidden"});
      if(settingsBots[0].model!=="quick-reply") throw Error("Confirmed model did not persist.");
      modelChecks.push({confirmedModel:settingsBots[0].model,provider:settingsBots[0].provider});
      if(stage==="after") { state="loaded"; await reset({savedUnavailable:true}); await composer(); await tab.getByRole("searchbox",{name:"Search models"}).fill("field"); await shot("current-unavailable"); }
      if(stage==="after") {
        for(const width of [1440,390]) {
          state="inference-error"; await reset({width}); await composer();
          await tab.getByRole("radio",{name:"Ultra",exact:true}).click();
          await tab.waitForFunction(message=>[...document.querySelectorAll('.model-popover [role="alert"]')].some(el=>{const p=el.closest('.model-popover').getBoundingClientRect(),r=el.getBoundingClientRect(),h=el.closest('.model-popover').querySelector('header').getBoundingClientRect();return el.textContent.includes(message)&&r.top>=h.bottom&&r.bottom<=p.bottom&&document.activeElement===el;}),fixture.inferenceError);
          await shot(`inference-error-visible-${width}`,width);
          state="model-save-error"; await reset({width}); await composer();
          await tab.getByRole("button",{name:"quick-reply",exact:true}).first().click();
          await tab.waitForFunction(message=>[...document.querySelectorAll('.model-popover [role="alert"]')].some(el=>{const p=el.closest('.model-popover').getBoundingClientRect(),r=el.getBoundingClientRect(),h=el.closest('.model-popover').querySelector('header').getBoundingClientRect();return el.textContent.includes(message)&&r.top>=h.bottom&&r.bottom<=p.bottom&&document.activeElement===el;}),fixture.modelSaveError);
          await shot(`model-error-visible-${width}`,width);
          state="loaded"; await reset({width,denseTools:true}); await settings("tools");
          await dialog.locator('.capability-item').nth(11).waitFor();
          if(await dialog.locator('.capability-item').count()!==12) throw Error("Dense catalog fixture did not load twelve tools.");
          await dialog.locator('.settings-content').evaluate(el=>{el.scrollTop=el.scrollHeight;});
          await shot(`tools-long-bottom-${width}`,width);
        }
      }
      for(const mode of ["capabilities-load-error","capabilities-save-error","capabilities-empty","capabilities-unavailable"]) {
        state=mode; await reset(); const kind=mode==="capabilities-save-error"||mode==="capabilities-empty"?"skills":"tools"; await settings(kind);
        if(mode==="capabilities-load-error") {
          await dialog.getByText(fixture.capabilityLoadError,{exact:true}).waitFor(); await shot(mode);
          if(await dialog.getByRole("button",{name:"Save tools",exact:true}).isEnabled()) throw Error("Unloaded catalog can be saved.");
          await dialog.getByRole("button",{name:"Retry loading tools",exact:true}).click();
          await dialog.locator(".capability-item").first().waitFor(); await shot("capabilities-retried");
        } else if(mode==="capabilities-save-error") {
          await dialog.getByRole("checkbox").last().check();
          await dialog.getByRole("button",{name:"Save skills",exact:true}).click();
          await dialog.getByText(fixture.skillSaveError,{exact:true}).waitFor(); await shot(mode);
          if(!await dialog.getByRole("checkbox").last().isChecked()) throw Error("Failure lost catalog draft.");
          await dialog.getByRole("button",{name:"Save skills",exact:true}).click();
          await tab.waitForFunction(()=>[...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="Saved"));
          await shot("capabilities-saved");
          if(!catalogs.skills.find(item=>item.id==="packing-list")?.enabled) throw Error("Catalog retry did not persist.");
          const skillWrites=modelSubmissions.filter(item=>item.kind==="skills");
          const requiredSkillIncluded=skillWrites.every(item=>item.body.ids.includes("weekly-plan"));
          modelChecks.push({requiredSkillIncluded});
          if(stage==="after" && !requiredSkillIncluded) throw Error("Required skill was omitted from save.");
        } else {
          await dialog.getByText(mode==="capabilities-empty"?"No skills were reported by Hermes.":fixture.capabilityUnsupportedReason,{exact:true}).waitFor();
          await shot(mode);
        }
      }
      if(browserErrors.length) throw Error(`Browser errors: ${browserErrors.join("; ")}`);
      return {paths,geometry,modelSubmissions,settingsSubmissions,modelChecks,browserErrors};
    }
    if (screen === "avatar") {
      const keyboardChecks=[];
      const dialog=tab.locator(".settings-dialog");
      const content=dialog.locator(".settings-content");
      const top=()=>content.evaluate(el=>{el.scrollTop=0;});
      const bottom=()=>content.evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const save=()=>dialog.getByRole("button",{name:"Save avatar",exact:true});
      const previewState=async state=>{
        const select=dialog.locator(".avatar-stage select");
        if(await select.count()) await select.selectOption(state);
        else await dialog.getByRole("button",{name:({idle:"Ready",thinking:"Thinking",working:"Working",waiting:"Waiting",blocked:"Needs your help",done:"Done"})[state],exact:true}).click();
      };
      const choose=async name=>dialog.getByRole("radio",{name,exact:true}).locator("..").click();
      const tune=async()=>{const slider=dialog.locator('input[type="range"]').first();await slider.focus();await slider.press("Home");for(let i=0;i<12;i++)await slider.press("ArrowRight");};
      const open=async ({reset=true,width=390,theme="light",large=false}={})=>{
        if(reset) settingsBots=structuredClone(fixture.bots);
        await tab.setViewportSize({width,height:width===1440?1000:844});
        await tab.emulateMedia({colorScheme:theme});
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await tab.evaluate(({large,theme})=>{document.documentElement.style.fontSize=large?"200%":"";document.documentElement.dataset.theme=theme;},{large,theme});
        await tab.locator('.chat-header [title="Details, pin, artifacts and settings"]').click();
        await tab.locator(".bot-details").getByRole("button",{name:"Settings",exact:true}).click();
        await dialog.getByRole("button",{name:"avatar",exact:true}).click();
        await dialog.locator(".avatar-stage").waitFor();
      };
      const checkAccessoryKeyboard=async compact=>{
        await dialog.getByRole("radio",{name:"Oval",exact:true}).focus();
        await tab.keyboard.press("Tab");
        await tab.keyboard.press("ArrowRight");
        await tab.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const result=await dialog.evaluate((root,compact)=>{
          const content=root.querySelector(".settings-content").getBoundingClientRect();
          const header=root.querySelector(":scope > header").getBoundingClientRect();
          const stage=root.querySelector(".avatar-stage").getBoundingClientRect();
          const footer=root.querySelector(compact?".avatar-save-actions":".settings-save-actions").getBoundingClientRect();
          const input=document.activeElement;
          const group=input.closest("fieldset")?.querySelector("legend")?.textContent;
          const tile=input.closest("label")?.querySelector(".choice-art")?.getBoundingClientRect();
          const visibleTop=Math.max(content.top,compact?stage.bottom:content.top);
          const visibleBottom=Math.min(content.bottom,footer.top);
          return {compact,group,focused:input?.type,headerVisible:header.top>=root.getBoundingClientRect().top-1,
            visibleTop,visibleBottom,tile:tile&&{top:tile.top,bottom:tile.bottom},
            tileVisible:!!tile&&tile.top>=visibleTop-1&&tile.bottom<=visibleBottom+1};
        },compact);
        keyboardChecks.push(result);
        if(result.group!=="Accessory"||!result.tileVisible||!result.headerVisible) throw Error(`Keyboard focus is obscured: ${JSON.stringify(result)}`);
      };
      const shot=async(name,width=390,theme="light")=>{
        await capture(name,width,width===1440?1000:844,theme);
        geometry.at(-1).avatar=await dialog.evaluate(root=>{
          const bounds=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
          return {scrollTop:root.querySelector('.settings-content').scrollTop, outerScrollTop:root.scrollTop,
            controls:[...root.querySelectorAll('.swatch,.choice,.avatar-stage-states button')].map(el=>({label:el.textContent||el.title||el.querySelector('input')?.getAttribute('aria-label'),...bounds(el)})),
            preview:bounds(root.querySelector('.avatar-stage')),
            footer:bounds(root.querySelector('.avatar-save-actions')),
            promptLimit:(()=>{const el=root.querySelector('.portrait-prompt-limit');return el&&{text:el.textContent,color:getComputedStyle(el).color,fontSize:getComputedStyle(el).fontSize,...bounds(el)};})(),
            portrait:[...root.querySelectorAll('img.avatar-portrait')].map(el=>({src:el.getAttribute('src'),loaded:el.complete&&el.naturalWidth>0}))};
        });
      };
      for(const v of [{name:"geo-desktop",width:1440},{name:"geo-desktop-dark",width:1440,theme:"dark"},{name:"geo-phone"},{name:"geo-large",large:true}]){
        await open(v);await shot(v.name,v.width,v.theme);
      }
      await open({width:1440});
      const first=dialog.getByRole("radio",{name:"Blob",exact:true});
      await first.focus();await tab.keyboard.press("ArrowRight");
      await shot("tile-keyboard-focus",1440);
      if(stage === "after") { await checkAccessoryKeyboard(true); await shot("accessory-keyboard-focus",1440); }
      await open();
      await choose("Mascot");
      await choose("Pumpkin");
      await top();await previewState("blocked");
      await shot("mascot-seasonal-phone");
      if(stage === "after") await previewState("idle");
      await choose("Cowboy hat");
      await shot("choices-phone");
      const range=dialog.locator('input[type="range"]').first();
      await tune();await bottom();await shot("tune-bottom-phone");
      const draft=await dialog.getByRole("radio",{name:"Pumpkin",exact:true}).isChecked();
      if(!draft)throw Error("Seasonal draft was lost while tuning.");
      // Persist through a deliberate failure, retry, and a fresh bootstrap.
      if(stage === "after") await previewState("working");
      state="save-error";await save().click();await dialog.getByText(fixture.avatarSaveError,{exact:true}).waitFor();
      await shot("save-error-phone");
      const failedBody=structuredClone(avatarSubmissions.at(-1).body);
      await save().click();await dialog.getByText("Avatar saved",{exact:true}).waitFor();
      if(JSON.stringify(avatarSubmissions.at(-1).body)!==JSON.stringify(failedBody))throw Error("Retry changed the draft.");
      await open({reset:false});
      if(!await dialog.getByRole("radio",{name:"Pumpkin",exact:true}).isChecked())throw Error("Saved avatar reverted on reopen.");
      const select=dialog.locator(".avatar-stage select");
      const previewIdle=await select.count()?await select.inputValue()==="idle":await dialog.getByRole("button",{name:"Ready",exact:true}).getAttribute("aria-pressed")==="true";
      if(!previewIdle)throw Error("Preview state was persisted.");
      await top();await shot("saved-reopen-phone");
      await open({large:true});await tune();await bottom();await shot("tune-bottom-large");
      await open();await choose("Portrait");await bottom();await shot("portrait-empty-phone");
      if(await save().isEnabled())throw Error("Empty portrait can be saved.");
      const input=dialog.locator('input[type="file"]');
      const uploadFinished=tab.waitForResponse(r=>r.url().endsWith("/uploads")&&r.request().method()==="POST");
      await input.setInputFiles({name:"ranch-portrait.png",mimeType:"image/png",buffer:Buffer.from(fixture.uploadPortrait,"base64")});
      if(stage === "after") await dialog.getByText("Uploading portrait…",{exact:true}).waitFor();
      await shot("portrait-busy-phone");
      const uploaded=await (await uploadFinished).json();
      await dialog.getByText(stage === "before" ? "Portrait uploaded. Save avatar to apply it." : "Portrait ready to save.",{exact:true}).waitFor();
      await top();await dialog.locator("img.avatar-portrait").evaluate(el=>el.decode());
      await shot("portrait-uploaded-phone-dark",390,"dark");
      await bottom();await save().click();await dialog.getByText("Avatar saved",{exact:true}).waitFor();
      if(settingsBots[0].avatar.src!==`/api/files/${uploaded.id}`||settingsBots[0].avatar.origin!=="uploaded")throw Error("Upload was not persisted.");
      for(const width of [1440,390]){
        await open({width});await choose("Portrait");
        await dialog.getByPlaceholder("Describe the portrait you want…",{exact:true}).fill(fixture.portraitPrompt);
        await dialog.getByRole("button",{name:"Generate portrait",exact:true}).click();
        await dialog.getByText(stage === "before" ? "Portrait generated. Save avatar to apply it." : "Portrait ready to save.",{exact:true}).waitFor();
        await top();await dialog.locator("img.avatar-portrait").evaluate(el=>el.decode());
        await shot(width===1440?"portrait-generated-desktop":"portrait-generated-phone",width);
      }
      if(stage === "after") {
        await open();await choose("Portrait");
        const prompt=dialog.getByPlaceholder("Describe the portrait you want…",{exact:true});
        await prompt.fill("x".repeat(1900));await bottom();await shot("portrait-limit-near-phone");
        await prompt.fill("x".repeat(2001));await bottom();await shot("portrait-limit-over-phone");
        if(await dialog.getByRole("button",{name:"Generate portrait",exact:true}).isEnabled())throw Error("An over-limit prompt can be generated.");
        await open({large:true});await choose("Portrait");
        await dialog.getByPlaceholder("Describe the portrait you want…",{exact:true}).fill(fixture.portraitPrompt);
        await dialog.getByRole("button",{name:"Generate portrait",exact:true}).click();
        await dialog.getByText("Portrait ready to save.",{exact:true}).waitFor();
        await bottom();await shot("portrait-status-large");
        if(geometry.at(-1).avatar.preview.height>160)throw Error("The large-text pinned preview exceeds160px.");
      }
      state="portrait-unavailable";await open();await choose("Portrait");await bottom();
      await shot("portrait-unavailable-phone");
      if(stage === "after") {
        state="creation-regression";settingsBots=structuredClone(fixture.bots);
        await tab.setViewportSize({width:1440,height:1000});await tab.goto(origin.origin);
        await tab.getByRole("button",{name:"New assistant",exact:true}).click();
        await dialog.getByRole("heading",{name:"Name and look",exact:true}).waitFor();
        await checkAccessoryKeyboard(false);await shot("creation-keyboard-focus",1440);
        await choose("Portrait");await top();await shot("creation-portrait-phone");
      }
      state="composer-regression";await open({width:1440});
      await dialog.getByRole("button",{name:"Close assistant settings",exact:true}).click();
      await tab.getByRole("button",{name:/^Model:/}).click();
      await tab.locator(".model-popover").waitFor();
      await capture("composer-after-avatar-css",1440,1000);
      const modelSegments=await tab.locator(".model-popover .segmented").evaluateAll(rows=>rows.map(row=>({padding:getComputedStyle(row).padding,wrap:getComputedStyle(row).flexWrap})));
      if(avatarSubmissions.some(({body})=>"state" in body))throw Error("Preview state leaked into a saved avatar.");

      return {paths,geometry,avatarSubmissions,portraitPrompts,uploaded,modelSegments,keyboardChecks,readback:{drawn:failedBody,upload:`/api/files/${uploaded.id}`},browserErrors};
    }
    if (screen === "settings") {
      await tab.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
        if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
      }));
      const dialog = tab.locator(".settings-dialog");
      const bottom = () => dialog.locator(".settings-content").evaluate(el => { el.scrollTop=el.scrollHeight; });
      const openNew = async () => {
        settingsBots=structuredClone(fixture.bots);
        await tab.goto(origin.origin);
        await tab.getByRole("button", {name:"New assistant",exact:true}).click();
        await dialog.getByRole("heading", {name:"Name and look",exact:true}).waitFor();
      };
      const openEdit = async () => {
        settingsBots=structuredClone(fixture.bots);
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await tab.locator('.chat-header [title="Details, pin, artifacts and settings"]').click();
        await tab.locator(".bot-details").getByRole("button",{name:"Settings",exact:true}).click();
        await dialog.waitFor();
      };
      const closeDirty = async () => {
        if (await dialog.locator('[role="alertdialog"][open]').count()) await tab.keyboard.press("Escape");
        await dialog.getByRole("button",{name:"Close assistant settings",exact:true}).click();
        if (await dialog.getByRole("button",{name:"Discard changes",exact:true}).count()) await dialog.getByRole("button",{name:"Discard changes",exact:true}).click();
        await dialog.waitFor({state:"hidden"});
      };
      await tab.goto(origin.origin);
      for (const [name,width,height,theme] of [
        ["desktop",1440,1000,"light"],["desktop-dark",1440,1000,"dark"],["phone",390,844,"light"],
        ["phone-dark",390,844,"dark"],["narrow",320,720,"light"],["tablet",768,1024,"light"],["large-text",390,844,"light"],
      ]) {
        state="loaded";
        await tab.setViewportSize({width,height}); await tab.emulateMedia({colorScheme:theme});
        await tab.evaluate(large => sessionStorage.setItem("design-large-text", String(large)),name==="large-text");
        await openNew(); await capture("create-look-"+name,width,height,theme);
        await dialog.getByLabel("Name",{exact:true}).fill(fixture.createdName); await bottom(); await capture("create-look-bottom-"+name,width,height,theme);
        await dialog.getByRole("button",{name:"Next: role and model",exact:true}).click();
        await dialog.getByRole("heading",{name:"Role and model",exact:true}).waitFor();
        await capture("create-role-"+name,width,height,theme); await bottom(); await capture("create-role-bottom-"+name,width,height,theme);
        await dialog.getByRole("button",{name:"Back",exact:true}).click();
        if (await dialog.getByLabel("Name",{exact:true}).inputValue()!==fixture.createdName) throw Error("Back lost the assistant name.");
        await closeDirty(); await openEdit(); await dialog.getByLabel("Name",{exact:true}).waitFor();
        await capture("edit-"+name,width,height,theme); await bottom(); await capture("edit-bottom-"+name,width,height,theme);
      }
      await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      await tab.setViewportSize({width:390,height:844}); await tab.emulateMedia({colorScheme:"light"});
      await openNew(); await dialog.getByRole("button",{name:"Next: role and model",exact:true}).click();
      await dialog.getByText("Give your assistant a name.",{exact:true}).waitFor(); await capture("create-name-required",390,844);
      await dialog.getByLabel("Name",{exact:true}).fill(fixture.bots[0].name);
      await dialog.getByRole("button",{name:"Next: role and model",exact:true}).click();
      await dialog.getByText("An assistant with this name already exists. Choose another name.",{exact:true}).waitFor(); await capture("create-name-taken",390,844);
      await closeDirty(); await openEdit(); await dialog.getByLabel("Name",{exact:true}).waitFor();
      await dialog.getByLabel("Description",{exact:true}).fill("Keep this edited description.");
      await dialog.getByRole("button",{name:"Close assistant settings",exact:true}).click();
      await dialog.getByRole("button",{name:"Keep editing",exact:true}).waitFor(); await capture("edit-discard",390,844);
      await dialog.getByRole("button",{name:"Keep editing",exact:true}).click();
      state="save-error";settingsSaveFailed=false;
      await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
      await dialog.getByText(fixture.saveError,{exact:true}).waitFor(); await capture("edit-save-error",390,844);
      if (await dialog.getByLabel("Description",{exact:true}).inputValue()!=="Keep this edited description.") throw Error("A failed save lost the edited description.");
      await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
      await dialog.getByText("Changes saved for both household members.",{exact:true}).waitFor(); await capture("edit-saved",390,844);
      state="loaded";await closeDirty();await openEdit(); await dialog.getByLabel("Name",{exact:true}).waitFor();
      await dialog.getByRole("checkbox",{name:"Shared with your household",exact:true}).uncheck();
      await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
      await dialog.getByRole("button",{name:"Make it personal",exact:true}).waitFor(); await capture("edit-personal-confirmation",390,844);
      await dialog.getByRole("button",{name:"Keep editing",exact:true}).click(); await closeDirty();
      await openEdit();await dialog.getByLabel("Name",{exact:true}).waitFor();
      await dialog.getByRole("button",{name:"Delete assistant",exact:true}).click(); await capture("edit-delete-confirmation",390,844);
      await closeDirty(); state="load-error";settingsLoadFailed=false;await openEdit();
      await dialog.getByRole("button",{name:"Retry settings",exact:true}).waitFor(); await capture("edit-load-error",390,844);
      await dialog.getByRole("button",{name:"Retry settings",exact:true}).click();await dialog.getByLabel("Name",{exact:true}).waitFor();
      await closeDirty();state="unsupported";await openEdit();await dialog.getByText(fixture.unsupportedReason,{exact:true}).waitFor();await capture("edit-unsupported",390,844);
      await closeDirty();state="loaded";await openNew();await dialog.getByLabel("Name",{exact:true}).fill(fixture.createdName);
      await dialog.getByRole("button",{name:"Next: role and model",exact:true}).click();await dialog.getByRole("button",{name:"Create assistant",exact:true}).click();await dialog.waitFor({state:"hidden"});
      const confirmations = [];
      const keyboardFocus = [];
      for (const [name,width,height,theme,large] of [["desktop",1440,1000,"light",false],["phone",390,844,"light",false],["phone-dark",390,844,"dark",false],["large-text",390,844,"light",true]]) {
        await tab.setViewportSize({width,height});await tab.emulateMedia({colorScheme:theme});
        await tab.evaluate(value => sessionStorage.setItem("design-large-text",String(value)),large);
        for (const kind of ["personal","delete","model"]) {
          state="loaded";await openEdit();await dialog.getByLabel("Name",{exact:true}).waitFor();
          if (stage!=="before" && kind==="personal") {
            await dialog.getByLabel("Name",{exact:true}).focus();
            for (let index=0;index<8;index++) {
              await tab.keyboard.press("Tab");
              const check=await tab.evaluate(() => {
                const focused=document.activeElement, bounds=focused.getBoundingClientRect();
                const footer=document.querySelector(".settings-save-actions").getBoundingClientRect();
                return {label:focused.getAttribute("aria-label") || focused.textContent?.trim() || focused.getAttribute("placeholder") || focused.tagName,
                  obscured:!focused.closest(".settings-save-actions") && bounds.top<footer.bottom && bounds.bottom>footer.top};
              });
              if (check.obscured) throw Error(`Sticky actions obscure keyboard focus: ${check.label}`);
              keyboardFocus.push({name,...check});
            }
          }
          if (kind==="personal") {
            await dialog.getByRole("checkbox",{name:"Shared with your household",exact:true}).uncheck();
            await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
            await dialog.getByRole("button",{name:"Make it personal",exact:true}).waitFor();
          } else if (kind==="delete") {
            await dialog.getByRole("button",{name:"Delete assistant",exact:true}).click();
            await dialog.getByRole("button",{name:"Keep assistant",exact:true}).waitFor();
          } else {
            state="model-confirm";await dialog.getByLabel("Description",{exact:true}).fill("Preserve this description while reviewing the model.");
            await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
            await dialog.getByRole("button",{name:"Confirm this model",exact:true}).waitFor();
          }
          const prompt = dialog.getByRole("alertdialog");
          if (stage!=="before") {
            await prompt.waitFor();
            const safe = prompt.getByRole("button",{name:kind==="delete"?"Keep assistant":"Keep editing",exact:true});
            if (!await safe.evaluate(element=>element===document.activeElement)) throw Error("The confirmation's safe action did not receive focus.");
            await tab.keyboard.press("Tab");await tab.keyboard.press("Shift+Tab");
          }
          await capture(`edit-${kind}-confirmation-${name}-focus`,width,height,theme);
          confirmations.push({kind,name,modal:await prompt.count(),...await tab.evaluate(()=>({focused:document.activeElement?.textContent?.trim(),confirmationBounds:document.querySelector('[role="alertdialog"]')?.getBoundingClientRect().toJSON()}))});
          if (stage!=="before") {
            const writes=settingsSubmissions.length;await tab.keyboard.press("Escape");await prompt.waitFor({state:"hidden"});
            if (!await dialog.isVisible() || await dialog.getByText("Discard your unsaved changes?",{exact:true}).count()) throw Error("Confirmation Escape reached the unsaved editor guard.");
            if (settingsSubmissions.length!==writes) throw Error("Cancelling a confirmation submitted a write.");
          } else await dialog.getByRole("button",{name:kind==="delete"?"Keep assistant":"Keep editing",exact:true}).click();
          await closeDirty();
        }
      }
      return {paths,geometry,settingsSubmissions,confirmations,keyboardFocus,backPreservesName:true,failedSavePreservesDraft:true,loadRetry:true};
    }
    if (screen === "details") {
      await tab.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
        if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
      }));
      const profile = tab.locator(".bot-details"), artifacts = tab.locator(".artifacts-dialog");
      const openProfile = async () => {
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await tab.locator('.chat-header [title="Details, pin, artifacts and settings"]').click(); await profile.waitFor();
      };
      const openFiles = async () => { await profile.getByRole("button",{name:/^Artifacts/}).click(); await artifacts.waitFor(); };
      for (const [name,width,height,theme] of [
        ["desktop",1440,1000,"light"],["desktop-dark",1440,1000,"dark"],
        ["phone",390,844,"light"],["phone-dark",390,844,"dark"],["narrow",320,720,"light"],["tablet",768,1024,"light"],
      ]) {
        await tab.setViewportSize({width,height}); await tab.emulateMedia({colorScheme:theme}); await openProfile();
        await capture("profile-"+name,width,height,theme); await openFiles(); await artifacts.locator(".artifact-text-preview pre").waitFor();
        await capture("artifacts-"+name,width,height,theme);
      }
      if (stage !== "before") {
        state="failed-profile"; await openProfile(); await profile.locator(".bot-activity.state-failed").waitFor(); await capture("profile-failed",390,844);
        state="blocked-profile"; await openProfile(); await profile.locator(".bot-activity.state-blocked").waitFor(); await capture("profile-blocked",390,844);
        state="loaded";
      }
      await tab.setViewportSize({width:390,height:844}); await tab.evaluate(() => sessionStorage.setItem("design-large-text","true"));
      await openProfile(); await capture("profile-large-text",390,844);
      await profile.locator(".sheet-body").evaluate(el=>{el.scrollTop=el.scrollHeight;}); await capture("profile-large-text-bottom",390,844);
      await openFiles(); await capture("artifacts-large-text",390,844);
      await artifacts.locator(".artifact-detail").evaluate(el=>{el.scrollTop=el.scrollHeight;}); await capture("artifacts-large-text-bottom",390,844);
      await tab.evaluate(()=>sessionStorage.removeItem("design-large-text")); await openProfile();
      const pin = profile.getByRole("button",{name:"Pin",exact:true}); await pin.click(); await profile.getByRole("button",{name:"Unpin",exact:true}).waitFor();
      await profile.getByRole("switch").check(); if (!await profile.getByRole("switch").isChecked()) throw Error("Following did not turn on.");
      await capture("profile-pinned-following",390,844); await openFiles();
      const search = artifacts.getByRole("searchbox",{name:"Search files"}); await search.fill("no-matching-file");
      await artifacts.getByText("No matching files",{exact:true}).waitFor(); await capture("artifacts-no-results",390,844);
      await artifacts.getByRole("button",{name:"Clear filters",exact:true}).click();
      for (const [id,name] of [["design-photo","image"],["design-survey","document"],["design-external","external"],["design-unsupported","unsupported"],["design-unavailable","failed-preview"]]) {
        const filename=fixture.conversation.files.find(file=>file.id===id).name;
        await artifacts.locator(".artifact-item").filter({hasText:filename}).click();
        if (id==="design-photo") await artifacts.locator(".artifact-preview img").waitFor();
        if (id==="design-unavailable") await artifacts.getByRole("button",{name:"Retry preview",exact:true}).waitFor();
        await capture("artifacts-"+name,390,844);
      }
      await artifacts.getByRole("button",{name:"Retry preview",exact:true}).click(); await artifacts.getByRole("button",{name:"Retry preview",exact:true}).waitFor();
      state="files-empty"; await openProfile(); await openFiles(); await artifacts.getByText("No artifacts yet",{exact:true}).waitFor(); await capture("artifacts-empty",390,844);
      state="earlier-error"; await openProfile(); await openFiles();
      await artifacts.getByText("Files from earlier in the conversation could not be loaded. Close and reopen this list to try again.",{exact:true}).waitFor();
      await capture("artifacts-earlier-error",390,844);
      return {paths,geometry,pinAndFollow:true,clearFilters:true,previewRetry:true};
    }
    if (screen === "recovery") {
      await tab.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
        if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
      }));
      const retry = tab.getByRole("button", { name: "Retry", exact: true });
      const open = async () => { await tab.goto(`${origin.origin}/?bot=ranch`); await tab.locator("#message").waitFor(); };
      for (const [name, width, height, theme] of [
        ["failed-desktop",1440,1000,"light"], ["failed-desktop-dark",1440,1000,"dark"],
        ["failed-phone",390,844,"light"], ["failed-phone-dark",390,844,"dark"],
        ["failed-narrow",320,720,"light"], ["failed-tablet",768,1024,"light"],
      ]) { await tab.setViewportSize({width,height}); await open(); await retry.waitFor();
        if (stage !== "before") {
          await tab.locator(".recovery-detail").filter({hasText:fixture.conversation.activity.detail}).waitFor();
          if (await retry.evaluate(el => el.getBoundingClientRect().height) < 44) throw Error("Retry target is smaller than 44px.");
        }
        await capture(name,width,height,theme); }
      await tab.evaluate(() => sessionStorage.setItem("design-large-text", "true")); await open(); await retry.waitFor();
      await capture("failed-large-text",390,844); await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      const composer = tab.locator("#message");
      for (const mode of ["accepted", "refused", "checking", "unsupported"]) {
        state = mode === "unsupported" ? "unsupported-retry" : "loaded";
        recoveryMode = mode === "unsupported" ? "checking" : mode; recoveryConversation = structuredClone(fixture.conversation); recoveryDraft = {text:"",attachments:[]};
        await open(); await retry.waitFor();
        const saved = tab.waitForResponse(response => response.url().endsWith("/draft") && response.request().method() === "PUT");
        await composer.fill("Keep this draft"); await saved;
        if (mode === "accepted") {
          await retry.focus(); await tab.keyboard.press("Shift+Tab"); await tab.keyboard.press("Tab");
          if (!await retry.evaluate(el => el.matches(":focus-visible"))) throw Error("Retry keyboard focus missing.");
          await capture("retry-focus",390,844);
        }
        await retry.click();
        if (mode === "refused") {
          await tab.getByText(`Hermes didn't take the retry. ${fixture.refusalReason}`, {exact:true}).waitFor();
          await capture("retry-refused",390,844);
          await tab.getByRole("button", {name:"Put my message in the message box",exact:true}).click();
          if (await composer.inputValue() !== "Keep this draft\n\nIs the north gate closed?") throw Error("Put back lost the existing draft.");
          await capture("retry-put-back",390,844);
        } else if (mode === "checking" || mode === "unsupported") {
          await (stage === "before" ? tab.getByText("Checking whether the retry arrived…", {exact:true}) : tab.locator(".recovery-guidance").filter({hasText:mode === "unsupported" ? "Hermes hasn't confirmed the retry yet." : "Checking whether the retry arrived…"})).waitFor(); await capture(mode === "unsupported" ? "retry-unsupported" : "retry-checking",390,844);
          if (mode === "unsupported") {
            if (await retry.isEnabled()) throw Error("Unsupported retry must not resend.");
            continue;
          }
          await retry.click();
          const last = recoverySubmissions.slice(-2);
          if (last[0].requestId !== last[1].requestId || last[1].reviewedUncertain !== true) throw Error("Unconfirmed retry must keep its request ID.");
        } else {
          // The private snapshot cannot emit SSE. Reload to inspect the accepted server snapshot.
          await tab.waitForFunction(() => ![...document.querySelectorAll("button")].some(el => el.textContent === "Retrying…"));
          await tab.reload(); await tab.getByText(fixture.answer, {exact:true}).waitFor();
          if (await composer.inputValue() !== "Keep this draft") throw Error("Retry changed the saved draft.");
          await capture("retry-accepted",390,844);
        }
      }
      state = "loaded"; recoveryConversation = structuredClone(fixture.interrupted); recoveryDraft = {text:"",attachments:[]}; await open();
      const review = tab.getByRole("checkbox", {name:stage === "before" ? "I reviewed the interrupted task and its last actions before continuing." : "I've reviewed the task's last actions.",exact:true});
      await review.waitFor(); await composer.fill("Continue with the east gate.");
      if (await tab.getByRole("button", {name:"Send message",exact:true}).isEnabled()) throw Error("Interruption review must gate Send.");
      await capture("interrupted-phone",390,844); await capture("interrupted-desktop",1440,1000); await capture("interrupted-dark",390,844,"dark");
      await tab.evaluate(() => sessionStorage.setItem("design-large-text", "true")); await open(); await review.waitFor();
      await capture("interrupted-large-text",390,844);
      await tab.locator(".transcript").evaluate(el => { el.scrollTop = 0; }); await capture("interrupted-large-text-top",390,844); await tab.evaluate(() => sessionStorage.removeItem("design-large-text")); await open(); await review.waitFor();
      await review.check(); if (!await tab.getByRole("button",{name:"Send message",exact:true}).isEnabled()) throw Error("Reviewed task must allow continuation.");
      await capture("interrupted-reviewed",390,844);
      return {paths,geometry,recoverySubmissions,draftPreserved:true,reviewGate:true};
    }
    if (screen === "approvals") {
      await tab.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
        });
      });
      await tab.goto(`${origin.origin}/?bot=ranch`);
      const card = tab.locator('[data-attention-kind="approval"]');
      await card.waitFor();
      const expiryFontSize = await card.locator("small").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      if (stage !== "before" && expiryFontSize < 14) throw Error("Approval expiry text is too small.");
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await tab.setViewportSize({ width, height });
        await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
        await tab.emulateMedia({ colorScheme: theme });
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await card.waitFor(); await capture(name, width, height, theme);
      }
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.evaluate(() => sessionStorage.setItem("design-large-text", "true"));
      await tab.reload(); await card.waitFor();
      await capture("large-text", 390, 844);
      await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-bottom", 390, 844);
      await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      state = "unsupported";
      await tab.goto(`${origin.origin}/?bot=ranch`); await card.waitFor();
      if (await card.getByRole("button", { name: "Approve", exact: true }).isEnabled()) throw Error("Unsupported decisions must be disabled.");
      if (stage !== "before") await card.getByText(fixture.unsupportedReason, { exact: true }).waitFor();
      await capture("unsupported", 390, 844);
      state = "loaded";
      const confirmations = [];
      for (const choice of ["approved", "denied"]) {
        approvalConversation = structuredClone(fixture.conversation); approvalFailed = false;
        await tab.goto(`${origin.origin}/?bot=ranch`); await card.waitFor();
        const action = card.getByRole("button", { name: choice === "approved" ? "Approve" : "Decline", exact: true });
        if (choice === "approved") {
          await action.focus(); await tab.keyboard.press("Shift+Tab"); await tab.keyboard.press("Tab");
          if (!await action.evaluate(el => el.matches(":focus-visible"))) throw Error("Approval needs keyboard focus.");
          await capture("keyboard-focus", 390, 844);
        }
        await action.click();
        await tab.getByText(fixture.decisionError, { exact: true }).waitFor();
        await capture(choice + "-error", 390, 844);
        await action.click();
        await card.getByRole("button", { name: choice === "approved" ? "Approved" : "Declined", exact: true }).waitFor();
        if (stage !== "before" && await tab.getByText(fixture.decisionError, { exact: true }).count()) throw Error("Accepted decision kept its old error.");
        if (stage !== "before") {
          const status = card.getByRole("status");
          const expected = choice === "approved" ? "Approval sent." : "Decline sent.";
          await status.getByText(expected, { exact: true }).waitFor();
          const style = await status.evaluate(el => ({ fontSize: parseFloat(getComputedStyle(el).fontSize), opacity: getComputedStyle(el).opacity, color: getComputedStyle(el).color }));
          if (style.fontSize < 14 || style.opacity !== "1") throw Error("The confirmation needs readable, undimmed text.");
          confirmations.push({ choice, text: expected, ...style });
        }
        await capture(choice + "-sent", 390, 844);
        await tab.reload(); await card.waitFor({ state: "hidden" });
        await capture(choice, 390, 844);
      }
      if (approvalSubmissions.length !== 4 || approvalSubmissions.some((item, i) => item.decision !== (i < 2 ? "approved" : "denied"))) throw Error("Decision retry payload changed.");
      return { paths, geometry, approvalSubmissions, submittedAfterReload: true, expiryFontSize, confirmations };
    }
    if (screen === "questions") {
      await tab.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
        });
      });
      await tab.goto(`${origin.origin}/?bot=ranch`);
      const card = tab.locator(".attention-card");
      const openings = [];
      const open = async (name, width, height, theme = "light", large = false) => {
        await tab.setViewportSize({ width, height });
        await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
        await tab.emulateMedia({ colorScheme: theme });
        await tab.evaluate(large => sessionStorage.setItem("design-large-text", String(large)), large);
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await card.waitFor();
        await capture(name, width, height, theme);
        const firstChoiceVisible = await card.locator(".option-card").first().evaluate(el => {
          const choice = el.getBoundingClientRect(), viewport = document.querySelector(".transcript").getBoundingClientRect();
          const header = document.querySelector(".chat-header").getBoundingClientRect();
          return choice.top >= Math.max(viewport.top, header.bottom) - 1 && choice.bottom <= viewport.bottom + 1;
        });
        const jumpVisible = await tab.locator(".jump-latest").count() > 0;
        openings.push({ name, firstChoiceVisible, jumpVisible });
        if (stage !== "before" && (jumpVisible || (!large && !firstChoiceVisible))) throw Error(`Question opening failed at ${name}.`);
      };
      await open("initial-phone", 390, 844);
      const initialChoiceVisible = openings[0].firstChoiceVisible;
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await open(name, width, height, theme);
        await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
        await capture(name + "-bottom", width, height, theme);
      }
      await open("large-text", 390, 844, "light", true);
      await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-bottom", 390, 844);
      await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await card.waitFor();
      const route = card.locator("fieldset").first();
      await route.getByText("Write my own answer", { exact: true }).click();
      await route.getByRole("textbox").fill("A shaded loop under two miles, with a place to rest.");
      await card.getByText("A picnic packing list", { exact: true }).click();
      await card.getByText("An offline route map", { exact: true }).click();
      await card.getByRole("textbox", { name: "Anything else I should know?", exact: true }).fill("One child tires easily. Plan a slow morning.");
      const submit = card.getByRole("button", { name: "Send answers", exact: true });
      if (!await submit.isEnabled()) throw Error("Complete answers did not enable Send.");
      await capture("answers", 390, 844);
      await route.getByRole("textbox").focus();
      await capture("own-answer-focus", 390, 844);
      await submit.click();
      await tab.getByText(fixture.answerError, { exact: true }).waitFor();
      if (await route.getByRole("textbox").inputValue() !== "A shaded loop under two miles, with a place to rest.") throw Error("A failed submission lost the answer.");
      await capture("submit-error", 390, 844);
      const errorFontSize = await tab.locator(".notice.error").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      if (stage !== "before" && errorFontSize < 14) throw Error("The error recovery text is too small.");
      await capture("submit-error-narrow", 320, 720);
      await tab.setViewportSize({ width: 390, height: 844 });
      const accepted = tab.waitForResponse(response => response.url().endsWith("/requests/fixture-question") && response.status() === 200);
      await submit.click();
      await accepted;
      if (stage !== "before") {
        const settled = card.getByRole("button", { name: "Answers sent", exact: true });
        await settled.waitFor();
        if (await settled.isEnabled() || await tab.getByText(fixture.answerError, { exact: true }).count()) throw Error("An accepted answer kept a stale error or allowed duplicate submission.");
      }
      await capture("answers-sent", 390, 844);
      // The synthetic server cannot push an event for this context's private fixture snapshot.
      await tab.reload();
      await card.waitFor({ state: "hidden", timeout: 15000 });
      await capture("submitted", 390, 844);
      if (questionSubmissions.length !== 2 || JSON.stringify(questionSubmissions[0]) !== JSON.stringify(questionSubmissions[1])) throw Error("Retry changed the question answers.");
      return { paths, geometry, questionSubmissions, answersPreserved: true, submittedAfterReload: true, initialChoiceVisible, openings, errorFontSize,
        touchMedia: await tab.evaluate(() => matchMedia("(pointer: coarse)").matches) };
    }
    if (screen === "conversation") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await tab.locator(".message-markdown").last().waitFor();
      const metadataContrast = [];
      const checkMetadata = async name => {
        const ratio = await tab.locator(".message-user .message-attribution").first().evaluate(el => {
          const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
              .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return channels.reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
          };
          const values = [getComputedStyle(el).color, getComputedStyle(el.closest(".message-user")).backgroundColor].map(luminance).sort((a, b) => a - b);
          return (values[1] + 0.05) / (values[0] + 0.05);
        });
        if (stage !== "before" && ratio < 4.5) throw Error(`Message metadata contrast ${ratio.toFixed(2)}:1 in ${name}`);
        metadataContrast.push({ name, ratio });
      };
      const edge = async end => tab.locator(".transcript").evaluate((el, end) => { el.scrollTop = end ? el.scrollHeight : 0; }, end);
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await tab.setViewportSize({ width, height });
        await edge(false); await capture(name, width, height, theme);
        await checkMetadata(name);
        await edge(true); await capture(name + "-latest", width, height, theme);
      }
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.locator(".composer textarea").fill("Make the picnic vegetarian. Keep the walk under two miles.");
      await capture("draft", 390, 844);
      if (!await tab.getByRole("button", { name: "Send message", exact: true }).isEnabled()) throw Error("A draft did not enable Send.");
      await tab.locator(".composer textarea").focus();
      await capture("composer-focus", 390, 844);
      await tab.locator(".composer textarea").fill("");
      await edge(true);
      await tab.getByRole("button", { name: "Copy code", exact: true }).click();
      await tab.getByText("Code copied.", { exact: true }).waitFor();
      const copied = await tab.evaluate(() => navigator.clipboard.readText());
      if (!copied.includes("for gate in north east barn")) throw Error("Copy code lost content.");
      await capture("copied-code", 390, 844);
      await tab.getByRole("button", { name: "Copy code", exact: true }).focus();
      await tab.keyboard.press("Shift+Tab");
      await tab.keyboard.press("Tab");
      if (!await tab.getByRole("button", { name: "Copy code", exact: true }).evaluate(el => el.matches(":focus-visible"))) throw Error("Copy code did not show keyboard focus.");
      await capture("code-focus", 390, 844);
      await tab.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await edge(false); await capture("large-text", 390, 844);
      await edge(true); await capture("large-text-latest", 390, 844);
      return { paths, geometry, metadataContrast, codeCopied: true, draftEnabledSend: true, codeKeyboardFocus: true };
    }
    if (screen === "home") {
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await tab.locator(".pinned-bot").first().waitFor();
      await capture("desktop", 1440, 1000);
      await capture("desktop-dark", 1440, 1000, "dark");
      await tab.locator(".pinned-bot").first().focus();
      await tab.keyboard.press("Shift+F10");
      await tab.getByRole("menu", { name: "Ranch hand", exact: true }).waitFor();
      await capture("desktop-menu", 1440, 1000);
      await tab.getByRole("menuitem", { name: "Move to section" }).hover();
      await tab.getByRole("menu", { name: "Home section", exact: true }).waitFor();
      await capture("desktop-submenu", 1440, 1000);
      await tab.keyboard.press("Escape");
      await tab.keyboard.press("Escape");
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.goto(origin.origin);
      await tab.locator(".bot-rail.open").waitFor();
      await capture("phone", 390, 844);
      await capture("phone-dark", 390, 844, "dark");
      for (const variant of ["three-pins", "no-pins"]) {
        state = variant;
        await tab.goto(origin.origin);
        await tab.locator(".bot-rail.open").waitFor();
        await tab.getByRole("button", { name: "Settings", exact: true }).waitFor();
        await capture(variant, 390, 844);
      }
      state = "loaded";
      await tab.goto(origin.origin);
      await tab.locator(".pinned-bot").first().waitFor();
      await capture("narrow", 320, 720);
      await tab.locator(".pinned-bot").first().click({ button: "right" });
      await tab.getByRole("menu", { name: "Ranch hand", exact: true }).waitFor();
      await capture("phone-menu", 390, 844);
      await tab.keyboard.press("Escape");
      await tab.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await capture("large-text", 390, 844);
      await tab.locator(".home-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-scrolled", 390, 844);
      await tab.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
      state = "empty";
      await tab.goto(origin.origin);
      await tab.locator(".bot-rail").getByRole("button", { name: "Create an assistant", exact: true }).waitFor();
      await capture("empty", 390, 844);
      return { paths, geometry };
    }
    await tab.goto(`${origin.origin}/?view=today`);
    await tab.getByRole("heading", { name: /Needs your attention|Since you were away/ }).first().waitFor();
    await capture("desktop", 1440, 1000);
    await capture("desktop-dark", 1440, 1000, "dark");
    await capture("phone", 390, 844);
    await capture("phone-dark", 390, 844, "dark");
    await capture("narrow", 320, 720);
    await capture("tablet", 768, 1024);
    if (fixture) {
      for (const variant of ["all-clear", "partial", "paged"]) {
        state = variant;
        await tab.reload();
        await tab.getByRole("button", { name: /Mark.*caught up/ }).waitFor();
        await capture(variant, 390, 844);
        if (variant === "partial" && await tab.locator(".today-attention-list").count()) {
          await tab.locator(".today-attention-list .today-row").filter({ hasText: "Disconnected" }).click();
          await tab.waitForURL(url => url.searchParams.get("bot") === "guide" && !url.searchParams.has("view"));
          await tab.goto(`${origin.origin}/?view=today`);
          await tab.getByRole("heading", { name: /Needs your attention/ }).waitFor();
        }
      }
      state = "error";
      await tab.getByRole("button", { name: "Refresh", exact: true }).click();
      await tab.getByRole("alert").waitFor();
      await capture("stale-error", 390, 844);
      state = "loading";
      await tab.reload({ waitUntil: "domcontentloaded" });
      await tab.getByText("Checking your assistants...", { exact: true }).waitFor();
      await capture("loading", 390, 844);
      releaseLoading();
      await tab.getByRole("heading", { name: /Needs your attention/ }).waitFor();
      if (!await tab.locator(".today-content").count()) return { paths, geometry };
      await tab.getByRole("button", { name: "Refresh", exact: true }).focus();
      await tab.keyboard.press("Tab");
      if (!await tab.locator(".today-attention-list .today-row").first().evaluate(el => el === document.activeElement)) {
        throw Error("Tab did not reach the first request.");
      }
      await capture("keyboard-focus", 1440, 1000);
      await tab.keyboard.press("Enter");
      await tab.waitForURL(url => url.searchParams.get("bot") === "ranch" && !url.searchParams.has("view"));
    }
    return { paths, geometry };
  } catch (error) {
    await tab.screenshot({path:`${outputDir}/${prefix}-${screen}-capture-error.png`,animations:"disabled"}).catch(() => {});
    throw new Error(`${error.message}\nBrowser errors: ${browserErrors.join("; ")}`);
  } finally { releaseMemoryLoad?.(); releaseMemoryWrite?.(); await context.unrouteAll({behavior:"ignoreErrors"}); await context.close(); }
}
