import { createHash } from "node:crypto";
import { canonicalJson, type SharedFact, type LifecycleContext } from "@seam/protocol";
import { HttpError } from "./http";
export function factSourceHash(fact: SharedFact) {
  return createHash("sha256").update(canonicalJson(fact.responses.map(row => ({ participantId: row.participantId, sources: row.sources.map(source => ({ scope: source.scope, reference: source.reference, contentHash: source.contentHash ?? null, sourceVersion: source.sourceVersion ?? null })).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))) })).sort((a,b)=>a.participantId.localeCompare(b.participantId)))).digest("hex");
}
export function bindFacts(refs: string[], facts: SharedFact[]): NonNullable<LifecycleContext["factBindings"]> {
  if (new Set(refs).size !== refs.length) throw new HttpError(422, "共享事实引用不得重复");
  return refs.map(key => { const fact = facts.find(row=>row.key===key); if(!fact)throw new HttpError(422,`共享事实${key}不存在，请先自动查找再引用`); return { key,value:fact.value,sourceHash:factSourceHash(fact) }; });
}
export function factsReady(refs: string[], facts: SharedFact[], revision: number, now=Date.now()) {
  return refs.every(key=>facts.some(fact=>fact.key===key && fact.status==="active" && fact.verifiedRevision===revision && Date.parse(fact.validUntil)>now));
}
export function sameBindings(a: NonNullable<LifecycleContext["factBindings"]>, b: NonNullable<LifecycleContext["factBindings"]>) {
  return canonicalJson([...a].sort((x,y)=>x.key.localeCompare(y.key)))===canonicalJson([...b].sort((x,y)=>x.key.localeCompare(y.key)));
}
