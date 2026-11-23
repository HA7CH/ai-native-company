import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { init } from './init.js';
import { deploy, waitReady } from './deploy.js';
import { deploySkills } from './skills.js';
import { deployOperations } from './operations.js';
import { run } from './doctor.js';
import { fail } from './common.js';
import { stop } from './launchd.js';
export async function selftest() {
  if (process.platform!=='darwin') fail('UNSUPPORTED_PLATFORM','selftest 需要 macOS GUI 会话','在 macOS 桌面用户下运行。');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anc-selftest-')), id=`test-${Date.now()}`,label=`com.anc.${id}.gateway`;
  const opts={dir:path.join(root,'vault'),stateDir:path.join(root,'state'),apply:true};
  const system={launchAgentsDir:path.join(root,'LaunchAgents'),run};
  const steps: string[]=[];
  try {
    init({...opts,identity:{companyId:id,companyName:'Sandbox Company',memberId:'alice',memberName:'Alice'}});
    const member=path.join(opts.dir,'members/alice/persona.md');
    fs.writeFileSync(member,fs.readFileSync(member,'utf8').replace('app_id: ""',`app_id: ${JSON.stringify(['cli','sandboxOnly'].join('_'))}`).replace('open_id: ""',`open_id: ${JSON.stringify(['ou','sandboxOnly'].join('_'))}`));
    fs.writeFileSync(path.join(opts.stateDir,'secrets.env'),'ANC_FEISHU_SECRET_ALICE=local-fixture-only\n');
    const fake=path.join(root,'mock-gateway');
    fs.writeFileSync(fake,`#!${process.execPath}\nconsole.log('msg="platform ready" project=${id}-alice platform=feishu');console.log('[Info] [connected to wss://fixture.invalid]');setInterval(()=>{},1000);\n`,{mode:0o700});
    const gatewaySystem={...system,locate:()=>fake,doctor:()=>({schemaVersion:1,status:'ready-to-deploy',checks:[]}),sandboxProbe:()=>{},ready:(l:string,log:string,offset:number,projects:string[])=>waitReady(l,log,offset,projects,15000)};
    deploySkills(opts); steps.push('skills');
    await deploy(opts,gatewaySystem); steps.push('gateway-bootstrap-and-ready');
    await deployOperations(opts,system); steps.push('watchdog-bootstrap');
    const watcher=run('/bin/sh',[path.join(opts.stateDir,'bin/anc-watchdog.sh'),opts.stateDir]);
    const health=JSON.parse(fs.readFileSync(path.join(opts.stateDir,'watchdog-status.json'),'utf8'));
    if(watcher.status!==0 || health.healthy!==true)throw Error('watchdog healthy check failed');steps.push('watchdog-idle-connection-evidence');
    const persona=path.join(opts.stateDir,'homes/alice/AGENTS.md'),previous=fs.readFileSync(persona,'utf8');fs.appendFileSync(member,'\nChanged instruction');
    let attempts=0;gatewaySystem.ready=(l,log,offset,projects)=>waitReady(l,log,offset,++attempts===1?['missing-project']:projects,attempts===1?4000:15000);
    try {await deploy(opts,gatewaySystem);throw Error('expected rollback');} catch(e) {if(!(e && typeof e==='object' && 'code' in e && e.code==='ROLLED_BACK'))throw e;}
    if(attempts!==2 || fs.readFileSync(persona,'utf8')!==previous)throw Error('rollback bytes not restored');steps.push('failed-update-and-verified-rollback');
    return {schemaVersion:1,status:'passed',steps,verification:'isolated launchd mock; no Feishu message or model call'};
  } finally {
    for(const l of [`com.anc.${id}.watchdog`,`com.anc.${id}.vault-sync`,label])await stop(l,system);
    fs.rmSync(root,{recursive:true,force:true});
  }
}
