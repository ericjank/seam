import assert from 'node:assert/strict';import {test} from 'node:test';import {capacityVerdict} from './preflight.mjs';
const GiB=1024**3;
test('host free space cannot hide a full Docker VM',()=>assert.equal(capacityVerdict({hostFreeBytes:100*GiB,dockerFreeBytes:GiB}).ok,false));
test('build headroom is checked before paid model or database setup',()=>{assert.equal(capacityVerdict({hostFreeBytes:100*GiB,dockerFreeBytes:10*GiB},{forBuild:true}).ok,false);assert.equal(capacityVerdict({hostFreeBytes:100*GiB,dockerFreeBytes:13*GiB},{forBuild:true}).ok,true);});
test('reused dependency layers use an explicit smaller build budget while retaining runtime headroom',()=>assert.equal(capacityVerdict({hostFreeBytes:100*GiB,dockerFreeBytes:10*GiB},{forBuild:true,cachedBuild:true}).ok,true));
