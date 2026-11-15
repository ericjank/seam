import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const kind=process.argv[2];if(!['connector','platform'].includes(kind))throw Error('build kind required');
const roots=kind==='connector'?['apps/connector/src','packages/agent-adapters/src','packages/protocol/src']:['apps/platform/src','apps/platform/drizzle','packages/protocol/src'];
const files=[];async function walk(path){for(const entry of(await readdir(resolve(root,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const next=join(path,entry.name);if(entry.isDirectory())await walk(next);else if(entry.isFile())files.push(next);}}
for(const path of roots)await walk(path);files.push('scripts/build-info.mjs','package.json','pnpm-lock.yaml','tsconfig.base.json',`apps/${kind}/package.json`,'packages/protocol/package.json');if(kind==='connector')files.push('packages/agent-adapters/package.json');
const entries=[];for(const file of files.sort())entries.push([file.replaceAll('\\','/'),createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')]);
const sourceId=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const destination=resolve(root,kind==='connector'?'apps/connector/dist/build-info.json':'apps/platform/build-info.json');await mkdir(dirname(destination),{recursive:true});
await writeFile(destination,JSON.stringify({kind,sourceId,files:entries.length},null,2));console.log(`${kind} sourceId=${sourceId}`);
