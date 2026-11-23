import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adopt } from '../dist/adopt.js';
import { legacyConfig } from '../dist/legacy-config.js';
import { deploy, planDeployment, rollback } from '../dist/deploy.js';
import { loadOrg } from '../dist/org.js';
import { deploySkills } from '../dist/skills.js';
import { plistObject } from '../dist/render.js';
import { deliveryTarget } from '../dist/delivery.js';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'anc-adopt-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const vault=path.join(root,'vault'), state=path.join(root,'state'), home=path.join(root,'old-home'), agents=path.join(root,'agents');
  for(const p of [vault,home,agents])fs.mkdirSync(p);
  const persona=path.join(home,'AGENTS.md'), plist=path.join(agents,'com.fixture.legacy.plist'), config=path.join(root,'legacy.toml');
  fs.writeFileSync(persona,'# Existing private workflow\nConfirmation required before business writes.\n');
  const oldPlist=plistObject({Label:'com.fixture.legacy',ProgramArguments:['/bin/echo','--config',config],StandardOutPath:path.join(root,'old.log')});fs.writeFileSync(plist,oldPlist);
  const secret='test-fixture-private-value';
  fs.writeFileSync(config,`language = "zh"\n[instant_reply]\nenabled = true\ncontent = "received"\n[[projects]]\nname = "旧项目"\n[projects.agent]\ntype = "codex"\n[projects.agent.options]\nwork_dir = ${JSON.stringify(home)}\nmode = "suggest"\nmodel = ""\n[[projects.platforms]]\ntype = "feishu"\n[projects.platforms.options]\napp_id = ${JSON.stringify(['cli','fixture'].join('_'))}\napp_secret = ${JSON.stringify(secret)}\nallow_from = ${JSON.stringify(['ou','fixture'].join('_'))}\nprogress_style = "card"\n`,{mode:0o600});
  const plan=path.join(root,'plan.json'); fs.writeFileSync(plan,JSON.stringify({companyId:'fixture',companyName:'Fixture',vaultRoot:vault,configPath:config,label:'com.fixture.legacy',logPath:path.join(root,'old.log'),codexPath:'/bin/echo',gatewayPath:'/bin/echo',members:[{id:'alice',name:'Alice',project:'旧项目'}]}));
  let loaded=true; const calls=[];
  const system={launchAgentsDir:agents,locate:()=>'/bin/echo',doctor:()=>({status:'ready-to-deploy'}),sandboxProbe:()=>{},ready:async()=>{},legacyReady:async()=>{calls.push('legacy-ready');},run(command,args){
    calls.push([command,...args]); if(command!=='launchctl')return {status:0,stdout:'',stderr:''};
    if(args[0]==='bootout')loaded=false; if(args[0]==='bootstrap')loaded=true;
    return args[0]==='print'&&!loaded ? {status:113,stdout:'',stderr:`Could not find service "com.fixture.legacy" in domain for user gui: ${process.getuid()}`} : {status:0,stdout:'state = running\npid = 999999',stderr:''};
  }};
  return {root,vault,state,home,persona,plist,oldPlist,config,plan,system,calls,opts:{plan,stateDir:state,launchAgentsDir:agents}};
}
test('legacy import rejects unsupported TOML instead of dropping settings',()=>{
  for(const text of ['x = 1\nx = 2','[a]\nx=1\n[a]\ny=2','x = {a=1}','constructor=1','[[projects]]\nname="unterminated'])assert.throws(()=>legacyConfig(text),{code:'UNSUPPORTED_LEGACY_CONFIG'});
  assert.equal(legacyConfig('x = "text # stays" # discarded').x,'text # stays');
});
test('adoption preparation preserves private legacy files and explicit takeover gate',async t=>{
  const f=fixture(t), original=fs.readFileSync(f.config);
  assert.equal(adopt(f.opts).status,'planned'); assert(!fs.existsSync(f.state));
  adopt({...f.opts,apply:true}); assert.deepEqual(fs.readFileSync(f.config),original); assert.equal(fs.readFileSync(f.plist,'utf8'),f.oldPlist);
  const org=loadOrg(path.join(f.vault,'.anc-org')); assert(org.members[0].body.includes('Confirmation required'));
  assert.throws(()=>planDeployment({stateDir:f.state},f.system),{code:'ADOPTION_REQUIRED'});
  const plan=planDeployment({stateDir:f.state,adopt:true},f.system);
  const generated=plan.files[path.join(f.state,'config.toml')]; assert(generated.includes('name = "旧项目"')); assert(generated.includes('progress_style = "card"')); assert(!generated.includes('test-fixture-private-value'));
  deploySkills({stateDir:f.state,apply:true});
  assert.equal((await deploy({stateDir:f.state,adopt:true,apply:true},f.system)).status,'deployed');
  assert.deepEqual(fs.readFileSync(f.config),original);
  assert.equal((await rollback({stateDir:f.state},f.system)).status,'legacy-restored'); assert.equal(fs.readFileSync(f.plist,'utf8'),f.oldPlist); assert(f.calls.includes('legacy-ready'));
});
test('failed takeover restores and verifies legacy service before reporting rollback',async t=>{
  const f=fixture(t), before=fs.readFileSync(f.persona); adopt({...f.opts,apply:true});
  f.system.ready=async()=>{throw Error('new gateway failed');};
  await assert.rejects(deploy({stateDir:f.state,adopt:true,apply:true},f.system),{code:'ROLLED_BACK',exitCode:3});
  assert.deepEqual(fs.readFileSync(f.persona),before); assert.equal(fs.readFileSync(f.plist,'utf8'),f.oldPlist); assert(f.calls.includes('legacy-ready'));
  assert(!fs.existsSync(path.join(f.state,'pending-deployment.json')));
});
test('changed legacy configuration and unknown capabilities stop migration',t=>{
  const f=fixture(t); fs.appendFileSync(f.config,'\nunknown = true\n');
  assert.throws(()=>adopt(f.opts),{code:'UNSUPPORTED_LEGACY_CONFIG'}); assert(!fs.existsSync(f.state));
  fs.writeFileSync(f.config,fs.readFileSync(f.config,'utf8').replace('unknown = true',''));
  adopt({...f.opts,apply:true}); fs.appendFileSync(f.config,'\n# intervening edit\n');
  assert.throws(()=>planDeployment({stateDir:f.state,adopt:true},f.system),{code:'MIGRATION_DRIFT'});
});
test('mismatched LaunchAgent cannot be prepared as the legacy gateway',t=>{
  const f=fixture(t);fs.writeFileSync(f.plist,plistObject({Label:'com.fixture.other',ProgramArguments:['/bin/echo','--config',f.config],StandardOutPath:path.join(f.root,'old.log')}));
  assert.throws(()=>adopt(f.opts),{code:'LEGACY_SERVICE_MISMATCH'});assert(!fs.existsSync(f.state));
  fs.writeFileSync(f.plist,plistObject({Label:'com.fixture.legacy',Program:'/bin/sleep',ProgramArguments:['/bin/echo','--config',f.config],StandardOutPath:path.join(f.root,'old.log')}));
  assert.throws(()=>adopt(f.opts),{code:'LEGACY_SERVICE_MISMATCH'});assert(!fs.existsSync(f.state));
});
test('a future denied file through a symlink cannot be delivered once created',t=>{
  const f=fixture(t);adopt({...f.opts,apply:true});fs.mkdirSync(path.join(f.home,'real'));fs.symlinkSync(path.join(f.home,'real'),path.join(f.home,'alias'));
  const hostFile=path.join(f.state,'host.json'),host=JSON.parse(fs.readFileSync(hostFile));host.layout.members.alice.denyPaths=[path.join(f.home,'alias/report.pdf')];host.layout.members.alice.delivery=true;fs.writeFileSync(hostFile,JSON.stringify(host));
  const p=planDeployment({stateDir:f.state,adopt:true},f.system);fs.writeFileSync(path.join(f.home,'real/report.pdf'),'private');
  assert.throws(()=>deliveryTarget(p.runtime,f.home,{CC_PROJECT:'旧项目',CC_SESSION_KEY:'feishu:oc_fixture:'+p.org.members[0].openId,FEISHU_VERIFIED_CHAT_MODE:'p2p'},'real/report.pdf'),/excluded/);
});
test('root grants and workspaces containing legacy credentials are blocked',t=>{
  const f=fixture(t);adopt({...f.opts,apply:true});const file=path.join(f.state,'host.json'),host=JSON.parse(fs.readFileSync(file));
  host.layout.members.alice.readPaths=['/'];fs.writeFileSync(file,JSON.stringify(host));
  assert.throws(()=>planDeployment({stateDir:f.state,adopt:true},f.system),{code:'INVALID_LAYOUT'});
  host.layout.members.alice.readPaths=[];host.layout.members.alice.home=f.root;fs.writeFileSync(file,JSON.stringify(host));
  assert.throws(()=>planDeployment({stateDir:f.state,adopt:true},f.system),{code:'INVALID_MIGRATION'});
});
