import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from '../dist/init.js';
import { deploy, waitReady } from '../dist/deploy.js';
import { deployOperations } from '../dist/operations.js';
import { run } from '../dist/doctor.js';
import { stop } from '../dist/launchd.js';

test('real watchdog caps recovery attempts and records recovery without contacting Feishu', {skip:process.platform!=='darwin',timeout:90000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anc-watchdog-')),companyId=`test-${Date.now()}`,label=`com.anc.${companyId}.gateway`;
  const options={dir:path.join(root,'vault'),stateDir:path.join(root,'state'),apply:true},system={launchAgentsDir:path.join(root,'LaunchAgents'),run};
  try {
    init({...options,identity:{companyId,companyName:'Watchdog Fixture',memberId:'alice',memberName:'Alice'}});
    const file=path.join(options.dir,'members/alice/persona.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('app_id: ""',`app_id: ${JSON.stringify(['cli','fixture'].join('_'))}`).replace('open_id: ""',`open_id: ${JSON.stringify(['ou','fixture'].join('_'))}`));
    fs.writeFileSync(path.join(options.stateDir,'secrets.env'),'ANC_FEISHU_SECRET_ALICE=fixture-only\n');
    const hostFile=path.join(options.stateDir,'host.json'),host=JSON.parse(fs.readFileSync(hostFile));host.operations={watchdogIntervalSeconds:3600};fs.writeFileSync(hostFile,JSON.stringify(host));
    const mock=path.join(root,'mock');fs.writeFileSync(mock,`#!${process.execPath}\nconsole.log('msg="platform ready" project=${companyId}-alice platform=feishu');console.log('[Info] [connected to wss://fixture.invalid]');setInterval(()=>{},1000);`,{mode:0o700});
    await deploy(options,{...system,locate:()=>mock,doctor:()=>({status:'ready-to-deploy',checks:[]}),sandboxProbe:()=>{},ready:(l,log,offset,projects)=>waitReady(l,log,offset,projects,15000)});
    await deployOperations(options,system);
    const log=path.join(options.stateDir,'logs/gateway.log');
    const monitor=()=>{const r=run('/bin/sh',[path.join(options.stateDir,'bin/anc-watchdog.sh'),options.stateDir]);assert.equal(r.status,0,r.stderr);assert(!fs.existsSync(path.join(options.stateDir,'watchdog.lock')),JSON.stringify({stderr:r.stderr,lock:fs.existsSync(path.join(options.stateDir,'watchdog.lock'))?fs.readdirSync(path.join(options.stateDir,'watchdog.lock')):[]}));return JSON.parse(fs.readFileSync(path.join(options.stateDir,'watchdog-status.json')));};
    assert.equal(monitor().code,'OK');
    for(let attempt=1;attempt<=3;attempt++) {
      fs.appendFileSync(log,'[Info] [disconnected to wss://fixture.invalid]\n');
      const result=monitor();assert.equal(result.healthy,false,JSON.stringify({attempt,result,log:fs.readFileSync(log,'utf8').slice(-1800)}));assert.equal(result.code,attempt<=2?'CONNECTION_UNAVAILABLE':'RESTART_LIMIT');
      if(attempt<=2)await waitReady(label,log,0,[companyId+'-alice'],15000);
    }
    assert.equal(fs.readFileSync(path.join(options.stateDir,'watchdog-restarts'),'utf8').trim().split('\n').length,2);
    fs.appendFileSync(log,'[Info] [connected to wss://fixture.invalid]\n');assert.equal(monitor().code,'OK');
    assert(!fs.existsSync(path.join(options.stateDir,'watchdog.lock')));
  } finally {
    for(const l of [`com.anc.${companyId}.watchdog`,label])await stop(l,system);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
