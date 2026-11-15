import { readFileSync } from "node:fs";
import { join } from "node:path";
let cached:{kind:string;sourceId:string;files:number}|undefined;
export function platformBuildInfo() {
  if(cached)return cached;
  try {const value=JSON.parse(readFileSync(join(process.cwd(),"build-info.json"),"utf8"));if(value.kind==="platform"&&/^[a-f0-9]{64}$/.test(value.sourceId))return cached=value;}catch{}
  return {kind:"platform",sourceId:"unversioned",files:0};
}
