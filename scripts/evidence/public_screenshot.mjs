import{writeFile,mkdir,readFile}from'node:fs/promises';import{dirname}from'node:path';import{createHash}from'node:crypto';
export const sensitiveSelector='[data-sensitive], [data-secret], input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]';
/** Only screenshots with this capture-time mask and matching SHA may be exported. */
export async function capturePublicScreenshot(page,path,options={}){
 await mkdir(dirname(path),{recursive:true});
 const bytes=await page.screenshot({...options,path,mask:[page.locator(sensitiveSelector)],maskColor:'#17263d'});
 const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
 await writeFile(path+'.public.json',JSON.stringify({schemaVersion:1,sha256,captureMaskApplied:true,maskSelector:sensitiveSelector,capturedAt:new Date().toISOString(),scope:'project credential panels and password inputs masked at capture time; binary trace images omitted separately'},null,2));return bytes;
}
