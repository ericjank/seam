import { createHash } from "node:crypto";
import { canonicalJson, type AgentTurnResult, type CollaborationContext, type CommandEvidence } from "@seam/protocol";
import { commandText } from "./evidence.js";

type IndependentResult = NonNullable<Extract<AgentTurnResult["actions"][number], { type: "integration.report" }>["independentResults"]>[number];
const scalar = (value: unknown): string | number | boolean | null => value === null || typeof value === "number" || typeof value === "boolean" ? value : typeof value === "string" ? value.slice(0,2000) : "[non-scalar]";
export async function runIndependentChecks(context: CollaborationContext, networkAllowed: boolean, signal: AbortSignal) {
  const results: IndependentResult[] = [], lifecycle=context.lifecycle;
  if (!lifecycle || lifecycle.paused || lifecycle.phase!=="joint_verifying" || !lifecycle.approvedHash || lifecycle.approvedHash!==lifecycle.documentHash || context.informationTask) return results;
  for (const item of lifecycle.contract?.acceptanceCases.filter(row=>row.runnerParticipantId===context.participant.id)??[]) for(const check of item.httpChecks??[]) {
    signal.throwIfAborted();
    const base={id:check.id,caseId:item.id,specHash:createHash("sha256").update(canonicalJson(check)).digest("hex"),documentHash:lifecycle.approvedHash,capturedAt:new Date().toISOString(),actualStatus:null as number|null};
    const unavailable=(summary:string,stage:NonNullable<IndependentResult["failureStage"]>,category:IndependentResult["category"]="environment",errorCode?:string):IndependentResult=>({...base,status:"not_run",category,summary,failureStage:stage,...(errorCode?{errorCode}: {})});
    if(!networkAllowed){results.push(unavailable("本机未允许网络访问，独立HTTP验收未执行。","permission","authorization"));continue;}
    const service=lifecycle.services.find(row=>row.participantId===check.publisherParticipantId&&row.name===check.serviceName&&Date.parse(row.expiresAt)>Date.now());
    if(!service){results.push(unavailable("没有本版有效的目标服务发布记录。","connect"));continue;}
    const url=new URL(check.path,service.baseUrl),origin=new URL(service.baseUrl);
    if(url.origin!==origin.origin||url.username||url.password||!check.path.startsWith("/")||check.path.startsWith("//")){results.push(unavailable("验收路径越出批准的服务范围，未发送请求。","policy","authorization"));continue;}
    let stage:NonNullable<IndependentResult["failureStage"]>="connect";
    try {
      const response=await fetch(url,{method:check.method,headers:{"content-type":"application/json"},...(check.method!=="GET"&&check.requestBody!==null?{body:check.requestBody}:{}),redirect:"manual",signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)])});
      base.actualStatus=response.status;
      if(response.status!==check.expectedStatus&&[401,403].includes(response.status)){await response.body?.cancel();results.push(unavailable("服务拒绝本次验收权限；不能据此判定业务代码错误。","permission","authorization"));continue;}
      if(response.status!==check.expectedStatus&&response.status>=500){await response.body?.cancel();results.push(unavailable("服务返回异常5xx，先诊断运行环境与上游状态。","connect","unknown"));continue;}
      const mismatches:NonNullable<IndependentResult["mismatches"]>=[];
      if(response.status!==check.expectedStatus)mismatches.push({path:"$status",expected:check.expectedStatus,actual:response.status,actualPresent:true});
      let parseFailed=false;
      if(check.bodyChecks.length){
        stage="read_body";const reader=response.body?.getReader();let bytes=0,text="";
        try {
          const decoder=new TextDecoder();
          if(reader) for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536){const error=new Error("response limit");error.name="RESPONSE_LIMIT";throw error;}text+=decoder.decode(chunk.value,{stream:true});}
          text+=decoder.decode();signal.throwIfAborted();
        } finally {await reader?.cancel().catch(()=>{});}
        stage="parse";let body:unknown;try{body=JSON.parse(text);}catch{parseFailed=check.bodyChecks.some(field=>field.path!=="$text");}
        for(const field of check.bodyChecks){
          let value=field.path==="$text"?text:body;
          for(const key of ["$","$text"].includes(field.path)?[]:field.path.split("."))value=value!==null&&typeof value==="object"&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined;
          const expected=field.equals==="$SEAM_REVISION"?lifecycle.revision:field.equals;
          if(value!==expected)mismatches.push({path:field.path,expected,actual:value===undefined?null:scalar(value),actualPresent:value!==undefined});
        }
      }else await response.body?.cancel();
      const passed=!mismatches.length&&!parseFailed;
      results.push({...base,status:passed?"passed":"failed",category:"code",mismatches,...(!passed?{failureStage:parseFailed?"parse" as const:"assertion" as const}:{}),summary:passed?"固定Connector按批准请求、状态码及字段期望独立验收通过。":"已完整取得响应，实际状态或字段与批准契约不符；差异见mismatches。"});
    } catch(error){
      if(signal.aborted)throw signal.reason??error;
      const name=error instanceof Error?error.name:"UNKNOWN_ERROR";
      results.push(unavailable(name==="RESPONSE_LIMIT"?"响应超过本机64KiB验收读取上限，不能判定业务代码失败。":stage==="read_body"?"响应体读取中断或超时，未取得完整业务响应，先处理传输或环境。":"独立HTTP连接失败或超时，尚不能判断业务代码。",name==="RESPONSE_LIMIT"?"policy":stage,"environment",name.slice(0,100)));
    }
  }
  return results;
}

/** A configured local command and complete observed assertions permit a deterministic receipt. */
export function buildConfiguredIntegrationReport(context: CollaborationContext, configuredCommand: string | undefined, runs: CommandEvidence[], independentResults: Awaited<ReturnType<typeof runIndependentChecks>>): AgentTurnResult | null {
  const lifecycle = context.lifecycle;
  const cases = lifecycle?.contract?.acceptanceCases.filter(row => row.runnerParticipantId === context.participant.id) ?? [];
  if (!lifecycle || lifecycle.paused || context.informationTask || lifecycle.phase !== "joint_verifying" || !lifecycle.approvedHash || lifecycle.approvedHash !== lifecycle.documentHash || !configuredCommand || !cases.length || cases.some(row => commandText(row.command) !== commandText(configuredCommand))) return null;
  const checks = cases.map(item => {
    const observed = runs.filter(row => commandText(row.command) === commandText(item.command));
    const oracle = independentResults.filter(row => row.caseId === item.id), missing = oracle.find(row => row.status === "not_run");
    const failed = oracle.some(row => row.status === "failed") || observed.some(row => row.exitCode !== 0);
    const codeFailure = oracle.some(row => row.status === "failed") || observed.some(row => row.exitCode !== 0 && /(?:not ok \d+|ERR_ASSERTION|AssertionError)/.test(row.output));
    const required = item.requiredAssertions ?? [];
    const assertions = [...new Set(observed.filter(row => row.exitCode === 0).flatMap(row => row.assertions))];
    const passed = observed.length > 0 && !failed && !missing && required.every(name => assertions.includes(name)) && oracle.every(row => row.status === "passed");
    return { caseId: item.id, command: item.command, status: missing ? "not_run" as const : passed ? "passed" as const : "failed" as const,
      category: missing?.category ?? (codeFailure ? "code" as const : "unknown" as const), summary: missing?.summary ?? (passed ? "Connector已运行本机配置命令并核对完整必需断言和独立契约结果，自动汇总实际回执。" : "配置命令失败或未覆盖完整必需断言，保留原始输出并停止通过结论。"),
      evidence: { automaticReceipt: true }, assertionNames: assertions, runIds: observed.map(row => row.id) };
  });
  return { message: "Connector依据实际命令与独立HTTP结果直接汇总本轮联合验收，无需调用模型重复转写测试报告。", kind: "status", notifyParticipantIds: [], needsHumanInput: false,
    actions: [{ type: "integration.report", revision: lifecycle.revision, documentHash: lifecycle.approvedHash!, checks, runs, independentResults }] };
}
