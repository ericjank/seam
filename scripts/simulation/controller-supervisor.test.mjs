import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {superviseController} from './controller-supervisor.mjs';
async function fixture(source,run){const root=await mkdtemp(join(tmpdir(),'seam-controller-test-'));try{const file=join(root,'worker.mjs');await writeFile(file,source);await run(file);}finally{await rm(root,{recursive:true,force:true});}}
test('owned controller crash restarts with same task configuration and no parent/Connector replacement',()=>fixture(`process.once('message',config=>{if(config.taskId!=='same-task')process.exit(2);if(config.controllerAttempt===1)process.exit(88);process.send({status:'passed'});process.disconnect();});`,async file=>{const events=[],output=[];const result=await superviseController({file,configuration:{taskId:'same-task'},onEvent:event=>events.push(event),onOutput:chunk=>output.push(String(chunk))});assert.equal(result.recoveries,1);assert.deepEqual(events.map(event=>event.event),['controller-started','controller-recovered']);assert.notEqual(events[0].pid,events[1].pid);assert.equal(output.join(''),'');}));
test('semantic test failure is reported once, never retried as an infrastructure crash',()=>fixture(`process.once('message',()=>{process.send({status:'failed',error:'actual verification failed'});process.disconnect();});`,async file=>{const events=[];await assert.rejects(superviseController({file,configuration:{},onEvent:event=>events.push(event)}),/actual verification failed/);assert.equal(events.length,1);}));
test('repeated unexpected crashes have a bounded restart budget',()=>fixture(`process.once('message',()=>process.exit(88));`,async file=>{const events=[];await assert.rejects(superviseController({file,configuration:{},maxRestarts:1,onEvent:event=>events.push(event)}),/restart budget exhausted/);assert.equal(events.length,2);}));
