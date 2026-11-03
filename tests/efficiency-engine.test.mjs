import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../runtime/engine.mjs';

test('Routing supplies concrete ready frontier and ignores blocked descendants without overriding Jev', async () => {
 const task=(id,writePaths,dependsOn=[])=>({id,role:'developer',description:`Implement ${id}`,writePaths,dependsOn,acceptance:['Behavior holds'],parallel:true});
 const a=task('ancestor',['src/shared.mjs']),b=task('context',['src/context.mjs'],['ancestor']),c=task('rtk',['src/rtk.mjs'],['ancestor']),future=task('integration',['src/context.mjs'],['context','rtk']);
 const models=[{id:'codex:desktop-default',client:'codex',model:'desktop-default',available:true}];
 let captured,parallel=false;
 const engine=new Engine({store:{getRun:()=>({cancelRequested:false})},provider:{decideJev:async request=>{captured=request;return{model:models[0].id,parallel,confidence:.98,modelConfidence:1,parallelConfidence:.98,sessionConfidence:.9,sessionMode:'fresh'};}}});
 engine.save=()=>{};engine.log=()=>{};
 const run={id:'fixture',task:'Objective '.repeat(200),client:'codex',models,config:{primaryModel:'desktop-default'},executionMode:{selected:'deep'},plan:{tasks:[a,b,c,future]},nodes:{ancestor:{status:'integrated'},context:{status:'pending'},rtk:{status:'pending'},integration:{status:'pending'}}};
 await engine.route(run,b,run.nodes.context);
 assert.equal(captured.node.parallelismFacts?.taskReady,true);
 assert.equal(captured.node.parallelismFacts?.planAllowsParallel,true);
 assert.deepEqual(captured.node.parallelismFacts?.compatibleReadyPeers.map(x=>x.id),['rtk']);
 assert.deepEqual(captured.node.parallelismFacts.compatibleReadyPeers[0],{id:'rtk',role:'developer',description:'Implement rtk',acceptance:['Behavior holds'],writePaths:['src/rtk.mjs']});
 assert.match(captured.node.parallelismFacts.rule,/snapshot/i);
 assert.deepEqual(captured.node.parallelismFacts?.conflictingActivePeers,[]);
 assert.ok(captured.task.length<600,'routing objective stays bounded independently of task history');
 assert.equal(run.nodes.context.routing.parallel,false,'facts do not override a serial Jev decision');
 assert.equal(captured.node.coordination.length,4,'the prepared graph is still supplied');
 run.nodes.integration.status='running';parallel=true;
 await engine.route(run,b,run.nodes.context);
 assert.deepEqual(captured.node.parallelismFacts.conflictingActivePeers,['integration']);
 assert.equal(run.nodes.context.routing.parallel,true,'normal typed routing remains separate from scheduler safety enforcement');
});
