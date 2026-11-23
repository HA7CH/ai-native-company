// Narrow stdio MCP adapter to cc-connect's existing delivery API. No credentials or agent loop.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { isWithin, readJSON } from './common.js';
import type { Runtime } from './codex-runner.js';
export function deliveryTarget(runtime: Runtime, cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  const home = fs.realpathSync(cwd), member = runtime.members.find(m => m.home === home);
  if (env.FEISHU_VERIFIED_CHAT_MODE !== 'p2p') throw Error('Delivery requires a gateway-verified private chat');
  if (!member?.delivery || member.project !== env.CC_PROJECT || !/^feishu:[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$/.test(env.CC_SESSION_KEY ?? '')) throw Error('Delivery is not bound to this member session');
  if (env.CC_SESSION_KEY!.split(':')[2] !== member.openId) throw Error('Delivery recipient does not match the member');
  if (!input) return { project: member.project!, session: env.CC_SESSION_KEY! };
  const file = fs.realpathSync(path.resolve(home, input)), relative = path.relative(home,file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(p => p.startsWith('.'))) throw Error('Attachment must be a visible file inside this bot workspace');
  const permission = Object.entries(member.filesystem).filter(([p])=>path.isAbsolute(p) && isWithin(p,file)).sort(([a],[b])=>b.length-a.length)[0]?.[1];
  if (permission!=='read' && permission!=='write') throw Error('Attachment is excluded by this member filesystem policy');
  const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw Error('Attachment must be a regular file no larger than 50 MiB');
  return { project: member.project!, session: env.CC_SESSION_KEY!, file };
}
export function deliveryServer(state: string) {
  const runtime = readJSON<Runtime>(path.join(state,'runtime.json'));
  const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
  const tools = [
    {name:'delivery_status',description:'检查本机器人是否绑定当前本人飞书会话；不发送消息。',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'send_attachment',description:'仅在用户要求交付本次成品时，把当前机器人工作目录内的附件回传到当前本人飞书会话。不能改收件人；成功以网关回执为准。',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  ];
  readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
    let req: any;
    try {
      req=JSON.parse(line); if(req.id===undefined)return;
      if(req.method==='initialize') { reply(req.id,{protocolVersion:req.params?.protocolVersion ?? '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'anc-delivery',version:'1.0.0'}}); return; }
      if(req.method==='ping') {reply(req.id,{});return;}
      if(req.method==='tools/list') {reply(req.id,{tools});return;}
      if(req.method!=='tools/call') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Unknown method'}})+'\n');return;}
      const name=req.params?.name,args=req.params?.arguments ?? {};
      let text: string;
      if(name==='delivery_status') {deliveryTarget(runtime,process.cwd(),process.env);text='CURRENT_MEMBER_SESSION_BOUND';}
      else if(name==='send_attachment' && typeof args.path==='string' && Object.keys(args).length===1) {
        const target=deliveryTarget(runtime,process.cwd(),process.env,args.path);
        const result=spawnSync(runtime.gateway,['send','--project',target.project,'--session',target.session,'--file',target.file!],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024,env:process.env});
        if(result.status!==0)throw Error('Gateway did not confirm delivery; check local gateway log');
        text=result.stdout.trim() || 'Gateway returned success for the current-session attachment.';
      } else throw Error('Unknown tool or invalid arguments');
      reply(req.id,{content:[{type:'text',text}]});
    } catch(e) {if(req?.id!==undefined)reply(req.id,{isError:true,content:[{type:'text',text:e instanceof Error?e.message:'Invalid request'}]});}
  });
}
