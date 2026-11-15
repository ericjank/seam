#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {SimulationApi} from './http.mjs';
// Only synthetic, run-owned rows in the isolated Docker database are mutated.
assert.equal(process.env.DB_HOST,'mysql');assert.equal(process.env.DB_DATABASE,'seam_simulation_test');
const require=createRequire('/app/apps/platform/package.json'),mysql=require('mysql2/promise');
const db=await mysql.createConnection({host:'mysql',user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE,timezone:'Z'});
const api=new SimulationApi('http://127.0.0.1:3000'),checks=[],observations=[],suffix=randomUUID().slice(0,8),owned=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const caps={adapter:'mock',executionMode:'external',testConfigured:false,supportsInformationLookup:true,protocolVersion:9};
async function claim(peer,expected=true){
 const deadline=Date.now()+12_000;
 do{const {job}=await api.call('/api/connectors/poll',{agentId:peer.agent.id,waitMs:0,supportsInformationLookup:true,protocolVersion:9},{token:peer.agent.token});if(job||!expected)return job;await delay(150);}while(Date.now()<deadline);
 assert.fail('expected a run-owned synthetic job');
}
const complete=(peer,job,actions)=>api.call('/api/connectors/complete',{agentId:peer.agent.id,jobId:job.id,attempts:job.attempts,status:'completed',result:{agentTurn:{message:'显式合成协议夹具，不代表真实模型或业务执行',kind:'status',actions,needsHumanInput:false,notifyParticipantIds:[]}}},{token:peer.agent.token});
const content=peer=>`# ${peer.project.name} 的实施贡献\n${'仅验证事实绑定和审批关口；审批前只读，批准后按共同文档执行，不伪造运行结果。'.repeat(5)}`;
async function create(label){
 const peers=[];for(const name of ['a','b']){const p=await api.register(`six-${label}-${name}-${suffix}`,'mock');await api.call('/api/connectors/heartbeat',{agentId:p.agent.id,capabilities:caps},{token:p.agent.token});peers.push(p);}
 const created=await api.call('/api/collaborations',{projectId:peers[0].project.id,targetProjectId:peers[1].project.id,objective:`隔离六项回归：${label}-${suffix}`});owned.push(created.id);
 const detail=()=>api.detail(created.id);return {id:created.id,peers,detail};
}
const searched=[{scope:'local_project',reference:'README.md',finding:'本地未含对端公开版本'},{scope:'shared_context',reference:'facts',finding:'当前共享事实没有此版本'}];
async function respond(peer,job,value='v1'){
 const task=job.payload.context.informationTask;assert.ok(task);
 await complete(peer,job,[{type:'information.respond',revision:job.payload.context.lifecycle.revision,requestId:task.requestId,attempt:task.attempt,status:'found',value,validForSeconds:3600,answer:`真实协议夹具当前版本 ${value}`,sources:[{scope:'local_project',reference:'docs/version.json',finding:'当前公开文件内容',contentHash:(value==='v1'?'a':'b').repeat(64)}]}]);
}
async function initialFacts(f,hold=false){
 const [a,b]=f.peers,ja=await claim(a);let jb=await claim(b);
 if(hold){
  const started=Date.now();await complete(b,jb,[{type:'workflow.blocked',revision:1,kind:'retryable',reason:'本测试只注入一次短暂环境故障，等待本方退避重试',dependencyParticipantIds:[],retryAfterSeconds:1,category:'environment',requiresAuthorization:false,requiresReview:false}]);
  jb=await claim(b);const d=await f.detail();assert.equal(d.jobs.find(j=>j.id===ja.id).status,'running');assert.ok(Date.now()-started<10_000);
  observations.push({event:'participant-retry-while-peer-running',elapsedMs:Date.now()-started,slowJobId:ja.id,retryJobId:jb.id});checks.push('真实HTTP/MySQL：A仍运行时B独立退避重派发，不受批次屏障阻塞');
 }
 await complete(b,jb,[{type:'plan.submit',revision:1,content:content(b),factRefs:[]}]);
 await complete(a,ja,[{type:'information.request',revision:1,key:'quote.version',question:'本轮需要提供方公开协议的当前版本',searched}]);
 await respond(b,await claim(b));
 await complete(a,await claim(a),[{type:'plan.submit',revision:1,content:content(a),factRefs:['quote.version']}]);
}
async function agree(f){
 let d=await f.detail(),l=d.lifecycle;assert.equal(l.phase,'plan_synthesis');const ids=l.requiredParticipantIds;
 const peer=f.peers.find(p=>d.participants.find(r=>r.participant.id===l.coordinatorParticipantId).participant.agentId===p.agent.id);
 const contract={effectiveRequirements:[{id:'fact-binding',text:'仅验证事实与审批，不启动业务HTTP服务',verification:'review'}],retiredRequirements:[],factRefs:['quote.version'],scope:'明确标记的合成协议工作流测试，不得当作业务完成或真实命令结果。',interfaces:[{id:'fixture',definition:'本夹具仅使用固定公开版本字段，所有执行回执都明确标记为合成。'}],responsibilities:ids.map(participantId=>({participantId,changes:'审阅固定字段、事实来源与审批状态；该夹具不执行真实业务修改。'})),acceptanceCases:ids.map((runnerParticipantId,i)=>({id:`fixture-${i}`,runnerParticipantId,description:'协议状态机夹具，仅检查字段一致性，不声明真实命令运行',command:'node --test fixture.test.mjs',expectedResult:'仅验证合成协议状态，不声明业务测试通过',requiredAssertions:['synthetic protocol only']})),serviceExpectations:[],risks:'隔离数据库及自有项目；不调用真实模型，不声明真实业务成功。',changeSummary:'只验证事实的当前修订绑定及管理员批准，不扩大业务范围。',impactedParticipantIds:ids,retainedDecisions:l.revision>1?['沿用公开版本约定']:[]};
 await complete(peer,await claim(peer),[{type:'plan.compose',revision:l.revision,baseDocumentHash:l.documentHash,contract}]);
 for(const p of f.peers){const job=await claim(p);await complete(p,job,[{type:'plan.confirm',revision:l.revision,documentHash:job.payload.context.lifecycle.documentHash}]);}
 d=await f.detail();assert.equal(d.lifecycle.phase,'awaiting_approval');return d;
}
async function expire(f){await db.execute("UPDATE collaboration_lifecycles SET shared_facts=JSON_SET(shared_facts,'$[0].validUntil',?) WHERE collaboration_id=?",['1970-01-01T00:00:00.000Z',f.id]);}
try{
 await api.loginOwner();const f=await create('unchanged'),[a,b]=f.peers;await initialFacts(f,true);await agree(f);
 await api.lifecycle(f.id,{action:'append',requirements:'新增修订沿用公开版本，只验证来源核验，不重复提交分析'});
 const ja=await claim(a),jb=await claim(b);await complete(a,ja,[{type:'plan.submit',revision:2,content:content(a),factRefs:['quote.version']}]);
 let d=await f.detail();assert.ok(!d.lifecycle.contributions.some(c=>c.participantId===ja.payload.context.participant.id));assert.equal(d.jobs.find(j=>j.id===jb.id).status,'running');
 await complete(b,jb,[{type:'plan.submit',revision:2,content:content(b),factRefs:[]}]);
 const verify=await claim(b);assert.equal(verify.payload.context.informationTask.mode,'verify');await respond(b,verify);
 d=await f.detail();assert.equal(d.lifecycle.facts[0].verifiedRevision,2);assert.ok(d.lifecycle.contributions.some(c=>c.participantId===ja.payload.context.participant.id&&c.content===content(a)));
 checks.push('跨修订引用事实强制自动核验；对端普通任务结束后领取查询；未变来源自动恢复原分析，无需模型重复提交');
 d=await agree(f);const approved=d.lifecycle.documentHash;await expire(f);await api.lifecycle(f.id,{action:'approve',revision:2,documentHash:approved});
 d=await f.detail();assert.equal(d.lifecycle.phase,'awaiting_approval');assert.equal(d.lifecycle.approvalPending.documentHash,approved);assert.equal(d.lifecycle.approvedHash,null);await respond(b,await claim(b));
 d=await f.detail();assert.equal(d.lifecycle.phase,'executing');assert.equal(d.lifecycle.approvedHash,approved);assert.equal(d.lifecycle.approvalPending,null);
 observations.push({event:'approval-resumed-same-document',documentHash:approved,factBindings:d.lifecycle.factBindings});checks.push('批准时已过期事实只读复核，同来源同hash续接原管理员批准，不重复要求点击');
 const events=[];let cursor=0,more=true;while(more){const page=await api.call(`/api/collaborations/${f.id}/events?after=${cursor}&limit=1`,undefined,{method:'GET'});events.push(...page.events);assert.ok(page.nextCursor>=cursor);cursor=page.nextCursor;more=page.hasMore;}
 assert.ok(events.some(e=>e.current.revision===1&&e.current.phase==='awaiting_approval'));assert.equal(events.at(-1).current.phase,'executing');assert.equal(new Set(events.map(e=>e.sequence)).size,events.length);
 const unauth=new SimulationApi(api.base);await unauth.expect(`/api/collaborations/${f.id}/events`,undefined,401,{method:'GET'});await unauth.expect(`/api/collaborations/${f.id}/executions`,undefined,401,{method:'GET'});
 const executionPage=await api.call(`/api/collaborations/${f.id}/executions?limit=2`,undefined,{method:'GET'});assert.equal(executionPage.executions.length,2);assert.equal(executionPage.hasMore,true);assert.ok(!JSON.stringify(executionPage).includes(a.agent.token));
 observations.push({event:'durable-transitions',events});checks.push('持久阶段事件可分页重放，执行查询有界且无令牌，未登录访问均401');await api.lifecycle(f.id,{action:'pause'});
 const changed=await create('changed');await initialFacts(changed);d=await agree(changed);await expire(changed);await api.lifecycle(changed.id,{action:'approve',revision:1,documentHash:d.lifecycle.documentHash});await respond(changed.peers[1],await claim(changed.peers[1]),'v2');
 d=await changed.detail();assert.equal(d.lifecycle.phase,'planning');assert.equal(d.lifecycle.documentHash,null);assert.equal(d.lifecycle.approvedHash,null);assert.equal(d.lifecycle.approvalPending,null);assert.ok(!d.lifecycle.contributions.some(c=>c.factRefs?.includes('quote.version')));
 observations.push({event:'changed-source-invalidates-document-and-approval',lifecycle:d.lifecycle});checks.push('批准后复核来源变化时自动作废旧文档及批准意图，重新规划并重新等待人工批准');await api.lifecycle(changed.id,{action:'pause'});
 console.log(JSON.stringify({ok:true,checks,observations,collaborationIds:owned,scope:'真实HTTP/MySQL协议回归；Agent动作明确为合成，SQL仅注入本次自有事实TTL；不冒充真实模型或业务执行'},null,2));
}finally{for(const id of owned){try{await api.lifecycle(id,{action:'pause'});}catch{}}await db.end();}
