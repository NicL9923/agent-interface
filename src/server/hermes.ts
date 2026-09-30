import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActivityState, Avatar, Bot, BotInput, Capabilities, Conversation, FileRef, Message, Routine, Runtime, RuntimeDiscovery, Skill, Submission, SubmissionReceipt, Tool } from '../shared/types.js';

// The only Hermes wire boundary. Dynamic records are upstream's versioned JSON-RPC payloads.
type Wire = Record<string, any>;
type RegisteredFile = {path:string;name:string;mime:string;botId:string;kind:'upload'|'artifact';version:1};
const revision = 'b9cb268deffc97946ec11645aa622a7353dd0591';
const keys = ['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'] as const;
export interface HermesOptions { url?: string; token?: string }

export function createHermesRuntime(options: HermesOptions = {}): Runtime {
  let socket: WebSocket | undefined;
  let connecting: Promise<void> | undefined;
  let serial = 0;
  let closed = false;
  let extension = false;
  let epoch: string | undefined;
  let requiredSkills=new Set<string>();
  const pending = new Map<number, { resolve(value: Wire): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const live = new Map<string, string>();
  const owners = new Map<string, string>();
  const transient = new Map<string, {text:string;state:ActivityState;requests:Wire[];tools:Message[]}>();
  let capabilityCache: Capabilities | undefined;
  const unavailable = () => new Error('Hermes is disconnected. Configure the existing supervised Hermes URL and server-side token.');
  const supported = (value:boolean, reason?:string) => ({supported:value,...(!value ? {reason:reason ?? 'The connected Hermes backend does not expose this capability.'}: {})});

  async function connect(): Promise<void> {
    if(closed) throw unavailable();
    if(connecting) return connecting;
    if(socket?.readyState===WebSocket.OPEN) return;
    if(!options.url || !options.token) throw unavailable();
    connecting = (async () => { await new Promise<void>((resolve,reject) => {
      const url=new URL('/api/ws',options.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('token',options.token!);
      const ws=new WebSocket(url);socket=ws;
      const deadline=setTimeout(()=>{ws.close();reject(new Error('Hermes connection timed out.'));},10000);
      ws.addEventListener('open',()=>{clearTimeout(deadline);resolve();});
      ws.addEventListener('error',()=>{clearTimeout(deadline);reject(new Error('Hermes connection failed. Check its supervised process and credentials.'));});
      ws.addEventListener('close',()=>{
        clearTimeout(deadline);socket=undefined;live.clear();capabilityCache=undefined;extension=false;
        for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Hermes disconnected during the request. Its outcome may be uncertain.'));}pending.clear();
        for(const state of transient.values())state.state='disconnected';
      });
      ws.addEventListener('message',({data})=>{
        for(const line of String(data).split('\n').filter(Boolean)){
          let frame:Wire;try{frame=JSON.parse(line);}catch{continue;}
          if(typeof frame.id==='number' && !frame.method){const item=pending.get(frame.id);if(item){clearTimeout(item.timer);pending.delete(frame.id);frame.error?item.reject(new Error(`Hermes ${frame.error.code}: ${frame.error.message}`)):item.resolve(frame.result ?? {});}continue;}
          const params=frame.params??{};const sid=params.session_id;
          if(sid){const state=transient.get(sid)??{text:'',state:'idle',requests:[],tools:[]};transient.set(sid,state);
            if(frame.method==='event'){
              const payload=params.payload??{};
              if(params.type==='message.start'){state.text='';state.tools=[];state.state='thinking';}
              if(params.type==='message.delta'){state.text+=payload.delta??payload.text??'';state.state='thinking';}
              if(params.type==='tool.start'){state.state='working';state.tools.push({id:`live-tool-${params.seq??serial}`,role:'tool',text:payload.description??payload.preview??payload.name??'Tool running',toolName:payload.name??payload.tool_name});}
              if(params.type==='message.complete'){state.text='';state.state=payload.status==='error'?'failed':payload.status==='interrupted'?'interrupted':'done';state.tools=[];}
              if(params.type==='error')state.state='failed';
              if(params.type==='request.cancel')state.requests=state.requests.filter(x=>x.id!==payload.id);
            }else if(frame.id && frame.method){
              if(frame.method==='approval'){state.requests=state.requests.filter(x=>x.id!==frame.id);state.requests.push(frame);state.state='waiting';}
              else if(['clarify','sudo','secret','vault.code','vault.unlock_prompt','connection'].includes(frame.method)){state.requests.push(frame);state.state='blocked';}
              else ws.send(JSON.stringify({jsonrpc:'2.0',id:frame.id,error:{code:-32601,message:'This client does not implement this official-client bridge.'}}));
            }
          }
        }
      });
    });
    await rawRpc('client.capabilities',{server_requests:true});
    try{const capabilities=await rawRpc('agent-interface.capabilities');extension=capabilities.revision===revision && capabilities.durable_admission===true && capabilities.durable_events===true && capabilities.canonical_open===true;epoch=capabilities.executor_epoch;requiredSkills=new Set(capabilities.essential_skills??[]);}catch{extension=false;}
    capabilityCache=undefined;
    })();
    try{await connecting;}finally{connecting=undefined;}
  }

  async function rpc(method:string,params:Wire={}):Promise<Wire>{
    await connect();return rawRpc(method,params);
  }
  async function rawRpc(method:string,params:Wire={}):Promise<Wire>{
    const id=++serial;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Hermes ${method} timed out. Do not replay an uncertain submission.`));},45000);pending.set(id,{resolve,reject,timer});socket!.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});
  }
  async function http(path:string,init:RequestInit={}):Promise<Response>{
    if(!options.url||!options.token)throw unavailable();
    const response=await fetch(new URL(path,options.url),{...init,headers:{'X-Hermes-Session-Token':options.token,...init.headers},signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw new Error(`Hermes HTTP ${response.status}: request failed.`);return response;
  }
  async function open(botId:string):Promise<Wire>{
    await connect();
    if(extension){const value=await rpc('agent-interface.open',{profile:botId});live.set(botId,value.session_id);owners.set(value.session_id,botId);const state=transient.get(value.session_id);if(state){state.requests=Array.isArray(value.open_requests)?value.open_requests:[];if(state.state==='disconnected'){state.state=value.app_interruption?'interrupted':value.info?.running?'thinking':'idle';state.text='';state.tools=[];}else if(!state.requests.length&&['waiting','blocked'].includes(state.state)){state.state=value.info?.running?'thinking':'idle';}}return value;}
    throw new Error('The verified durable Hermes add-on is required before opening a conversation.');
  }
  function bot(row:Wire,detail?:Wire):Bot{
    const meta=row.ui_meta?.agent_interface??{};
    return {id:row.name,name:meta.name||row.display_name||row.ui_meta?.['hermes-bots']?.title||row.name,description:row.description,instructions:detail?.soul,model:row.model??detail?.model?.default??'Inherited',provider:row.provider??detail?.model?.provider,shared:meta.shared??true,avatar:meta.avatar,enabledTools:detail?.toolsets?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledSkills:detail?.skills?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledMcpServers:detail?.mcp_servers?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),sessionId:row.canonical_session?.resolved_id,activity:transient.get(live.get(row.name)??'')?.state??'idle'};
  }
  function signFile(value:RegisteredFile):FileRef{
    if(!options.token)throw unavailable();const body=Buffer.from(JSON.stringify(value)).toString('base64url');const signature=createHmac('sha256',options.token).update(body).digest('base64url');
    const id=`${body}.${signature}`;return {id,name:value.name,mime:value.mime,url:`/api/files/${encodeURIComponent(id)}`};
  }
  function fileValue(id:string):RegisteredFile{
    if(!options.token)throw unavailable();const [body,signature,...extra]=id.split('.');if(!body||!signature||extra.length)throw new Error('Invalid file identifier.');
    const expected=createHmac('sha256',options.token).update(body).digest();const actual=Buffer.from(signature,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Invalid file identifier.');const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.version!==1||!['upload','artifact'].includes(value.kind)||typeof value.path!=='string'||!value.path.startsWith('/')||value.path.includes('\0')||value.path.split('/').includes('..')||typeof value.botId!=='string'||typeof value.name!=='string'||typeof value.mime!=='string')throw new Error('Unregistered file identifier.');return value;
  }
  function receipt(value:Wire):SubmissionReceipt{return {requestId:value.requestId,status:value.status,runId:value.runId,...(value.userRowId!=null?{messageId:String(value.userRowId)}:{}),message:value.message};}
  function artifacts(botId:string,row:Wire):FileRef[]{
    // Only the revision-bound executor can attest output provenance and path policy.
    // Never turn message text or a tool's unverified JSON path into a download capability.
    const descriptors=row.role==='user'?row.app_attachments:row.app_artifacts;
    if(!Array.isArray(descriptors))return [];
    const seen=new Set<string>();
    return descriptors.flatMap((file:Wire)=>{if(typeof file.path!=='string'||!file.path.startsWith('/')||file.path.includes('\0')||file.path.split('/').includes('..')||seen.has(file.path))return [];seen.add(file.path);const name=typeof file.name==='string'?file.name:file.path.split('/').pop()??'file';const extension=name.split('.').pop()?.toLowerCase();const mime=typeof file.mime==='string'?file.mime:({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown'} as Record<string,string>)[extension??'']??'application/octet-stream';return [signFile({path:file.path,name,mime,botId,kind:row.role==='user'?'upload':'artifact',version:1})];});
  }
  async function submit(input:Submission,steer=false):Promise<SubmissionReceipt>{
    let attachments: RegisteredFile[];
    try {
      attachments = input.attachments.map(file => fileValue(file.id));
      if (attachments.some(file => file.botId !== input.botId))
        throw new Error('Attachment belongs to a different Hermes bot.');
    } catch (error) {
      // Validation has not contacted native admission. The caller can edit this draft.
      return { requestId: input.requestId, status: 'rejected', message:
        `${error instanceof Error ? error.message : 'Invalid attachment.'} Remove it and attach the file again. Your draft is saved.` };
    }
    await connect();if(!extension)throw new Error('Durable Hermes admission add-on is required before sending.');const state=await open(input.botId);
    if((steer||state.info?.running)&&attachments.some(x=>x.mime.startsWith('image/')))return {requestId:input.requestId,status:'rejected',message:'Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.'};
    const references=attachments.filter(x=>!x.mime.startsWith('image/')).map(x=>`@file:${JSON.stringify(x.path)}`).join('\n');
    try{return receipt(await rpc('agent-interface.submit',{profile:input.botId,session_id:state.session_id,request_id:input.requestId,sender_id:input.senderId,text:input.text+(references?'\n'+references:''),attachments,steer,reviewed_interruption:input.reviewedInterruption===true}));}catch(error){return {requestId:input.requestId,status:'uncertain',message:error instanceof Error?error.message:'Hermes response lost. Review before retrying.'};}
  }
  async function routineMutation(input: Omit<Routine, 'id'>, id?: string): Promise<Routine> {
    const profile = `?profile=${encodeURIComponent(input.botId)}`;
    const body = {
      name: `[bot:${input.botId}] ${input.name}`, prompt: input.prompt,
      schedule: input.schedule, deliver: `bot-chat:${input.botId}`, context_from: ['self'],
    };
    const path = `/api/cron/jobs${id ? `/${encodeURIComponent(id)}` : ''}`;
    let job = await (await http(path + profile, {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { updates: body } : { ...body, paused: !input.enabled }),
    })).json() as Wire;
    if (job.error || job.success === false) throw new Error(job.error ?? 'Hermes refused the routine.');
    job = job.job ?? job;
    const jobId = job.id ?? job.job_id ?? id;
    if (!jobId) throw new Error('Hermes did not return a routine ID.');
    const isEnabled = (value: Wire) => value.enabled !== false && value.state !== 'paused';
    if (isEnabled(job) !== input.enabled) {
      // Hermes pause/resume maintains enabled, state, timestamps and next-run time together.
      job = await (await http(`/api/cron/jobs/${encodeURIComponent(jobId)}/${input.enabled ? 'resume' : 'pause'}${profile}`, { method: 'POST' })).json() as Wire;
    }
    if (isEnabled(job) !== input.enabled) throw new Error('Hermes did not apply the routine state. Reload before retrying.');
    return { ...input, id: jobId, enabled: isEnabled(job) };
  }
  return {
    async status(){try{await connect();return {connected:true,version:extension?revision:'Native Hermes gateway; durable add-on absent',detail:extension?`Executor ${epoch}`:'Install the verified local add-on for durable admission and discovery.'};}catch{return {connected:false,detail:'Hermes is not configured or its supervised gateway is unavailable.'};}},
    async capabilities(){if(capabilityCache)return capabilityCache;let connected=false;try{await connect();connected=true;}catch{}
      const result=Object.fromEntries(keys.map(key=>[key,supported(connected&&extension,connected?'This Hermes revision has not passed the configured compatibility contract.':'Hermes is disconnected.')])) as Capabilities;
      result.idempotency=supported(connected&&extension,'The verified durable admission add-on is required.');result.chat=result.idempotency;result.steering=result.idempotency;result.durableEvents=supported(connected&&extension,'The durable lifecycle journal add-on is required.');
      let image=false;if(connected)try{image=(await rpc('image.generate',{probe:true})).available===true;}catch{}
      result.imageGeneration=result.portraitGeneration=supported(connected&&extension&&image,'A verified Hermes add-on and a usable image-generation provider are required.');capabilityCache=connected?result:undefined;return result;},
    async listBots(){try{await connect();const roster=await rpc('profiles.list',{include_sessions:true});return await Promise.all(roster.profiles.map(async(row:Wire)=>bot(row,await rpc('profiles.describe',{name:row.name}))));}catch{return []; }},
    async saveBot(input:BotInput,id?:string){await connect();const name=id??input.name.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'');if(!name)throw new Error('Bot name needs letters or numbers.');
      let created=false;try{if(!id){await rpc('profiles.create',{name,description:input.description,soul:input.instructions,mirror_credentials:true,no_alias:true});created=true;}
      const rosterBefore=await rpc('profiles.list',{include_sessions:false});const previous=rosterBefore.profiles.find((x:Wire)=>x.name===name);
      const config:Wire={name,soul:input.instructions,description:input.description??'',ui_meta:{'hermes-bots':{...previous?.ui_meta?.['hermes-bots'],title:input.name},agent_interface:{...previous?.ui_meta?.agent_interface,name:input.name,shared:input.shared}},ui_meta_expected_revisions:{'hermes-bots':previous?.ui_meta_revisions?.['hermes-bots']??0,agent_interface:previous?.ui_meta_revisions?.agent_interface??0}};
      if(input.model && input.model!=='Inherited'){config.model=input.model;config.provider=input.provider??(await rpc('profiles.describe',{name})).model.provider;if(input.confirmModel)config.confirm_expensive_model=true;}if(input.enabledMcpServers)config.enabled_mcp_servers=input.enabledMcpServers;
      if(input.enabledSkills){const all=await rpc('profiles.describe',{name});config.disabled_skills=all.skills.filter((x:Wire)=>!input.enabledSkills!.includes(x.name)).map((x:Wire)=>x.name);}
      const result=await rpc('profiles.configure',config);if(result.confirm_required)throw Object.assign(new Error(result.confirm_message??'Hermes requires confirmation for this model.'),{statusCode:409,code:'MODEL_CONFIRMATION_REQUIRED',confirmRequired:true});if(!result.ok)throw new Error('Hermes applied only some profile changes: '+Object.entries(result.applied??{}).filter(([_,value])=>value===false).map(([key])=>key).join(', '));if(input.enabledTools)await this.setTools(name,input.enabledTools);
      const roster=await rpc('profiles.list',{include_sessions:true});return bot(roster.profiles.find((x:Wire)=>x.name===name),await rpc('profiles.describe',{name}));}catch(error){if(created){try{await http(`/api/profiles/${encodeURIComponent(name)}`,{method:'DELETE'});live.delete(name);}catch{throw Object.assign(new Error('Hermes created the bot but configuration failed and automatic cleanup was refused. Review bot '+name+'.'),{createdBotId:name,cause:error});}}throw error;}},
    async deleteBot(id){await http(`/api/profiles/${encodeURIComponent(id)}`,{method:'DELETE'});live.delete(id);},
    async stop(botId){const state=await open(botId);await rpc('session.interrupt',{session_id:state.session_id,profile:botId});},
    async generatePortrait(botId,prompt){await open(botId);const result=await rpc('image.generate',{prompt,aspect_ratio:'square',max_bytes:2_000_000});if(!result.success||!result.image_data)throw new Error(result.error??'Hermes image generation did not deliver image bytes.');const [,mime,base64]=/^data:([^;]+);base64,(.*)$/.exec(result.image_data)??[];if(!mime||!base64)throw new Error('Hermes returned an invalid generated image.');return this.upload(botId,{name:'generated-portrait.png',mime,data:Buffer.from(base64,'base64')});},
    async setAvatar(botId,avatar:Avatar){
      const roster=await rpc('profiles.list',{include_sessions:false});const row=roster.profiles.find((x:Wire)=>x.name===botId);if(!row)throw new Error('Unknown Hermes bot.');
      let portraitData:string|undefined;
      if(avatar.mode==='portrait'){
        if(!avatar.src.startsWith('/api/files/')||/[?#]/.test(avatar.src))throw new Error('Choose an image uploaded or generated through this app.');
        const id=decodeURIComponent(avatar.src.slice('/api/files/'.length));const file=fileValue(id);if(file.botId!==botId)throw new Error('Portrait belongs to a different Hermes bot.');if(!['image/png','image/jpeg','image/webp'].includes(file.mime))throw new Error('Hermes portraits support PNG, JPEG, and WebP.');
        const image=await this.download(id);if(image.data.length>2_000_000)throw new Error('Hermes portraits must be 2 MB or smaller.');
        portraitData=`data:${image.mime};base64,${image.data.toString('base64')}`;
      }
      const meta=row.ui_meta?.agent_interface??{};const result=await rpc('profiles.configure',{name:botId,ui_meta:{agent_interface:{...meta,avatar}},ui_meta_expected_revisions:{agent_interface:row.ui_meta_revisions?.agent_interface??0}});if(!result.ok||result.applied?.ui_meta===false||Object.keys(result.applied?.ui_meta_conflicts??{}).length)throw new Error('The Hermes avatar changed on another client. Reload before saving.');
      // Native assets do not support CAS. Never overwrite one after a rejected metadata revision.
      if(portraitData){try{const stored=await rpc('profiles.set_asset',{name:botId,asset:'avatar',data:portraitData});if(!stored.ok)throw new Error('Asset save refused.');}catch{throw new Error('The app portrait metadata was saved, but Hermes could not save its native portrait asset. Retry to finish saving.');}}
    },
    async conversation(botId):Promise<Conversation>{await connect();const value=await open(botId);const sid=value.session_id;const history=value.messages??(await rpc('session.history',{session_id:sid,profile:botId})).messages;
      const rows:Message[]=history.filter((x:Wire)=>x.display_kind!=='hidden').map((row:Wire,index:number)=>{const text=row.app_tool_result?JSON.stringify(row.app_tool_result,null,2):typeof row.app_display_text==='string'?row.app_display_text:row.text??(typeof row.content==='string'?row.content:row.context??'');const reasoning=typeof row.reasoning==='string'&&row.reasoning?row.reasoning:typeof row.reasoning_content==='string'?row.reasoning_content:undefined;return {id:String(row.app_request_id??row.row_id??`${sid}-${index}`),role:['user','assistant','tool'].includes(row.role)?row.role:'system',text,createdAt:row.timestamp?new Date(row.timestamp*1000).toISOString():undefined,reasoning,toolName:row.name,files:artifacts(botId,row)};});
      const state=transient.get(sid);const inflight=value.inflight??{};const text=state?.text||inflight.assistant;
      if(text)rows.push({id:`${sid}-inflight`,role:'assistant',text});
      const requests=Array.isArray(value.open_requests)?value.open_requests:[];
      const approvals=requests.filter((x:Wire)=>x.method==='approval').map((x:Wire)=>({id:String(x.id),title:'Action approval',detail:x.params?.description??x.params?.command??'Hermes requests approval.',status:'pending' as const}));
      const attention=requests.filter((x:Wire)=>x.method!=='approval').map((x:Wire)=>({id:String(x.id),kind:x.method==='clarify'?'clarify' as const:'official' as const,title:x.method==='clarify'?'Hermes needs your answer':'Continue in the official Hermes client',detail:x.method==='clarify'?'Answer the questions to continue this task.':`Hermes is waiting for ${x.method}. Use the official client to complete credential or service setup.`,questions:x.method==='clarify'?(x.params?.questions??[]).map((q:Wire)=>({id:q.qid,prompt:q.question??'',options:q.choices})):undefined}));
      const activity:ActivityState=value.app_interruption?'interrupted':approvals.length?'waiting':value.info?.running?(state?.state==='working'?'working':'thinking'):inflight.error?'failed':inflight.interrupted?'interrupted':value.app_run_id?'thinking':['done','failed','interrupted'].includes(value.app_task_state)?value.app_task_state:state?.state??'idle';
      return {botId,sessionId:value.canonical_stored_session_id??value.stored_session_id??value.info?.stored_session_id??sid,messages:rows,activity:{state:value.app_interruption?'interrupted':attention.length?'blocked':activity,runId:value.app_run_id??value.app_interruption?.runId??undefined},approvals,attention,files:rows.flatMap(x=>x.files??[])};},
    submit(input){return submit(input);},steer(input){return submit(input,true);},
    async lookupSubmission(requestId){await connect();if(!extension)return null;const result=await rpc('agent-interface.receipt',{request_id:requestId});return result.receipt?receipt(result.receipt):null;},
    async approve(botId,approvalId,decision,_senderId){const state=await open(botId);const requests=state.open_requests??[];if(!requests.some((x:Wire)=>String(x.id)===approvalId&&x.method==='approval'))throw new Error('That approval is stale or already resolved.');const result=await rpc('request.answer',{id:approvalId,result:{choice:decision==='approved'?'once':'deny'}});if(result.status==='expired'||result.resolved===false)throw new Error('That approval expired before it was answered.');},
    async answerRequest(botId,requestId,answers){const state=await open(botId);if(!(state.open_requests??[]).some((x:Wire)=>String(x.id)===requestId&&x.method==='clarify'))throw new Error('That question is stale or already resolved.');const result=await rpc('request.answer',{id:requestId,profile:botId,result:{answers}});if(result.status==='expired')throw new Error('That question expired before it was answered.');},
    async upload(botId,input){const state=await open(botId);const result=await rpc('file.attach',{session_id:state.session_id,profile:botId,name:input.name,data_url:`data:${input.mime};base64,${input.data.toString('base64')}`});const path=result.path;if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.split('/').includes('..'))throw new Error('Hermes did not return a staged file path.');return {...signFile({path,name:input.name,mime:input.mime,botId,kind:'upload',version:1}),size:input.data.length};},
    async download(id){const file=fileValue(id);const response=await http(`/api/files/download?path=${encodeURIComponent(file.path)}`);return {data:Buffer.from(await response.arrayBuffer()),name:file.name,mime:file.mime};},
    async tools(botId):Promise<Tool[]>{const result=await rpc('profiles.describe',{name:botId});return result.toolsets.map((x:Wire)=>({id:x.name,name:x.label||x.name,description:x.description,enabled:x.enabled}));},
    async setTools(botId,ids){const state=await open(botId);const catalog=await rpc('profiles.describe',{name:botId});const known=new Set(catalog.toolsets.map((x:Wire)=>x.name));if(ids.some(x=>!known.has(x)))throw new Error('Unknown Hermes toolset selected.');const disabling=catalog.toolsets.filter((x:Wire)=>x.enabled&&!ids.includes(x.name)).map((x:Wire)=>x.name);const enabling=catalog.toolsets.filter((x:Wire)=>!x.enabled&&ids.includes(x.name)).map((x:Wire)=>x.name);for(const [action,names] of [['disable',disabling],['enable',enabling]] as const){if(names.length){const result=await rpc('tools.configure',{session_id:state.session_id,action,names});if(result.unknown?.length||result.missing_servers?.length)throw new Error('Hermes could not apply all tool selections.');}}},
    async skills(botId):Promise<Skill[]>{const result=await rpc('profiles.describe',{name:botId});return result.skills.map((x:Wire)=>({id:x.name,name:x.name,description:requiredSkills.has(x.name)?'Required by Hermes':'Hermes profile skill',enabled:x.enabled,required:requiredSkills.has(x.name)}));},
    async setSkills(botId,ids){const all=await rpc('profiles.describe',{name:botId});const result=await rpc('profiles.configure',{name:botId,disabled_skills:all.skills.filter((x:Wire)=>!ids.includes(x.name)).map((x:Wire)=>x.name)});if(!result.ok)throw new Error('Hermes refused the skill selection.');},
    async routines(): Promise<Routine[]> {
      const roster = await rpc('profiles.list', {include_sessions:false});
      const all: Routine[] = [];
      for (const row of roster.profiles) {
        // Dashboard listing reads native jobs directly. The tool-facing list also
        // probes machine-wide gateway processes, which is unsuitable for polling.
        const jobs = await (await http(`/api/cron/jobs?profile=${encodeURIComponent(row.name)}`)).json() as Wire[];
        for (const job of jobs) {
          const prefix = `[bot:${row.name}] `;
          all.push({id:job.id ?? job.job_id,botId:row.name,
            name:job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name,
            prompt:job.prompt ?? '',schedule:job.schedule_display,
            enabled:job.enabled !== false && job.state !== 'paused'});
        }
      }
      return all;
    },
    saveRoutine: routineMutation,
    async deleteRoutine(id){await http(`/api/cron/jobs/${encodeURIComponent(id)}`,{method:'DELETE'});},
    async discoverEvents(cursor):Promise<RuntimeDiscovery>{await connect();if(!extension)throw new Error('Durable discovery requires the verified Hermes add-on.');return await rpc('agent-interface.discover',{cursor}) as RuntimeDiscovery;},
    async close(){closed=true;socket?.close();},
  };
}
