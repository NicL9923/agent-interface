// Playwright CLI run-code function. Screenshots and a geometry report for a design gate.
async (page, { outputDir = ".private/design-review", prefix = "current", screen = "today", stage = "after", fixture } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const boot = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (boot.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  if (!["today", "home", "conversation", "questions", "approvals", "recovery", "details", "settings"].includes(screen)) throw Error(`Unsupported screen: ${screen}`);
  const context = await page.context().browser().newContext({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const tab = await context.newPage();
  const browserErrors = [];
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
  const modelWarning = "This model may cost more than your current model. Confirm the choice before saving.";
  const settingsSubmissions = [];
  for (const [path, encoded] of Object.entries(fixture?.images || {})) {
    await context.route(`**${path}`, route => route.fulfill({ contentType: "image/png", body: Buffer.from(encoded, "base64") }));
  }
  await context.route("**/api/bots/*/conversation*", async route => {
    if (!["conversation", "questions", "approvals", "recovery", "details", "settings"].includes(screen) || !fixture?.conversation) return route.continue();
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
  if (screen === "settings") {
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
      if (state === "model-confirm" && !body.confirmModel) return route.fulfill({status:409,json:{error:modelWarning,confirmRequired:true}});
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
      Object.assign(settingsBots.find(bot => bot.id === id), {avatar:body});
      return route.fulfill({json:body});
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
    if (screen === "settings") {
      value.bots = settingsBots.map(({instructions, enabledMcpServers, ...roster}) => roster);
      if (state === "unsupported") value.capabilities.botConfiguration = {supported:false,reason:fixture.unsupportedReason};
    }
    if (screen === "recovery" && state === "unsupported-retry") value.capabilities.idempotency = { supported: false, reason: "This Hermes connection cannot look up requests." };
    if (screen === "approvals" && state === "unsupported") value.capabilities.approvals = { supported: false, reason: fixture.unsupportedReason };
    if (fixture?.preferences) value.preferences = { ...value.preferences, ...fixture.preferences };
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
  } finally { await context.close(); }
}
