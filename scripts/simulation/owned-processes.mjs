import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,mkdir,writeFile,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile);
export async function savePrivate(root,name,value){const directory=join(root,'private');await mkdir(directory,{recursive:true,mode:0o700});const destination=join(directory,name),temp=destination+'.'+randomUUID();await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await rename(temp,destination);}
export async function readPrivate(root,name){return JSON.parse(await readFile(join(root,'private',name),'utf8'));}
export async function processMatches(record){
 if(!Number.isInteger(record?.pid)||record.pid<=1||!record.marker||!record.entry)throw Error('owned process identity missing');
 try{const {stdout}=await exec('ps',['-p',String(record.pid),'-o','command=']);return stdout.includes(record.entry)&&stdout.includes(record.marker);}catch(error){if(error.code===1)return false;throw error;}
}
export async function stopOwned(record,signal='SIGTERM'){
 if(!await processMatches(record))return false;process.kill(record.detached?-record.pid:record.pid,signal);return true;
}
export async function launchOwned({entry,env,logPath,marker=randomUUID(),detached=true}){
 const file=await open(logPath,'a',0o600);
 try{const child=spawn(process.execPath,[entry,`--seam-owned=${marker}`],{env,detached,stdio:['ignore',file.fd,file.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid,entry,marker,detached,logPath};}finally{await file.close();}
}
