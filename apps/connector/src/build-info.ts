import { readFileSync } from "node:fs";
export function connectorBuildInfo() {
  try {const value=JSON.parse(readFileSync(new URL("./build-info.json",import.meta.url),"utf8"));if(value.kind==="connector"&&/^[a-f0-9]{64}$/.test(value.sourceId))return value as {kind:string;sourceId:string;files:number};}catch{}
  return {kind:"connector",sourceId:"unversioned",files:0};
}
