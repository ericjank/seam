import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {statfs,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),GiB=1024**3;
export function capacityVerdict({hostFreeBytes,dockerFreeBytes},{forBuild=false,cachedBuild=false}={}) {
 const minimumHostBytes=(forBuild?8:2)*GiB,minimumDockerBytes=(forBuild?(cachedBuild?8:12):2)*GiB;
 return {ok:hostFreeBytes>=minimumHostBytes&&dockerFreeBytes>=minimumDockerBytes,hostFreeBytes,dockerFreeBytes,minimumHostBytes,minimumDockerBytes};
}
export async function preflight({forBuild=false,cachedBuild=false,pruneCache=false,output}={}) {
 const host=await statfs(process.cwd());let cleanup=null;
 if(pruneCache){const result=await exec('docker',['buildx','prune','--all','--filter','until=1h','--max-used-space','6GB','--reserved-space','2GB','--force'],{maxBuffer:2*1024*1024});cleanup={scope:'unused rebuildable BuildKit cache only; no images, containers or volumes',output:result.stdout};}
 const image=process.env.SIMULATION_NODE_IMAGE??'node:22.23.4-bookworm-slim';
 const {stdout}=await exec('docker',['run','--pull=never','--rm','--read-only','--network','none','--entrypoint','node',image,'-e','const s=require("node:fs").statfsSync("/");process.stdout.write(JSON.stringify({freeBytes:s.bavail*s.bsize}));'],{timeout:20000});
 const result={...capacityVerdict({hostFreeBytes:host.bavail*host.bsize,dockerFreeBytes:JSON.parse(stdout).freeBytes},{forBuild,cachedBuild}),forBuild,cachedBuild,cleanup,at:new Date().toISOString()};
 if(output)await writeFile(output,JSON.stringify(result,null,2));
 if(!result.ok)throw new Error(`环境容量不足：Docker可用${(result.dockerFreeBytes/GiB).toFixed(1)}GiB，要求${result.minimumDockerBytes/GiB}GiB；主机可用${(result.hostFreeBytes/GiB).toFixed(1)}GiB。仅可重建缓存可通过--prune-cache有界回收，保留所有数据库卷。`);
 return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url))preflight({forBuild:process.argv.includes('--for-build'),cachedBuild:process.argv.includes('--cached-build'),pruneCache:process.argv.includes('--prune-cache'),output:process.argv.find(arg=>arg.startsWith('--output='))?.slice(9)}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
