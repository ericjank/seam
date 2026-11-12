/** Shared, explicit acceptance oracle for the two synthetic quote revisions. */
export function jointFixture({ liveURL, role, revision }) {
  if (![1, 2].includes(revision)) throw new Error("explicit approved fixture revision required");
  return `import assert from "node:assert/strict";
import { test } from "node:test";
${role === "consumer" ? 'import { getQuote } from "./client.mjs";' : ''}
const base = ${JSON.stringify(liveURL)};
const revision = ${revision};
const configuration = await fetch(base + "/health");
assert.equal(configuration.status,200);
assert.match(configuration.headers.get("content-type")??"",/^application\\/json\\b/);
assert.deepEqual(await configuration.json(),{ready:true,revision});
test("real peer HTTP health ready and approved revision",()=>{});
const post = input => fetch(base + "/quote", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
const quote = ${role === "consumer" ? "input => getQuote(base, input)" : "async input => { const response = await post(input); if (!response.ok) throw new Error(\"HTTP \" + response.status); return response.json(); }"};
const expected = (sku, quantity, subtotal, percent = 0) => ({ sku, quantity, subtotal, currency:"CNY", ...(revision === 2 ? {discount:Math.floor(subtotal * percent / 100),total:subtotal - Math.floor(subtotal * percent / 100)} : {}) });
for (const [sku, quantity, subtotal] of [["SKU-001",2,24000],["SKU-002",3,13500],["SKU-001",1,12000],["SKU-001",100,1200000],["SKU-002",1,4500],["SKU-002",100,450000]]) {
  test("real peer HTTP quote " + sku + " quantity=" + quantity, async () => {
    assert.deepEqual(await quote({sku,quantity}), expected(sku,quantity,subtotal));
  });
}
test("real peer HTTP invalid quantities and consumer rejection", async () => {
  for (const quantity of [0,-1,101,1.5,"2",null,false,undefined]) {
    const input = {sku:"SKU-001",quantity};
    const response=await post(input); assert.equal(response.status,400);
    assert.match(response.headers.get("content-type")??"",/^application\\/json\\b/);
    const body=await response.json(); assert.equal(typeof body.error,"string"); assert.ok(body.error.trim());
    await assert.rejects(() => quote(input), /400/);
  }
});
test("real peer HTTP unknown SKU and consumer rejection", async () => {
  const input = {sku:"unknown",quantity:1};
  const response=await post(input); assert.equal(response.status,400);
  assert.match(response.headers.get("content-type")??"",/^application\\/json\\b/);
  const body=await response.json(); assert.equal(typeof body.error,"string"); assert.ok(body.error.trim());
  await assert.rejects(() => quote(input), /400/);
});
test("real peer HTTP malformed JSON and nonobjects return errors",async()=>{
  for(const raw of ["{", "null", "[]", "false", "42", "{}"]){
    const response=await fetch(base+"/quote",{method:"POST",headers:{"content-type":"application/json"},body:raw});
    assert.equal(response.status,400); assert.match(response.headers.get("content-type")??"",/^application\\/json\\b/);
    const body=await response.json(); assert.equal(typeof body.error,"string"); assert.ok(body.error.trim());
  }
});
if (revision === 2) {
  for (const discountPercent of [0,10,100]) test("real peer HTTP discount " + discountPercent, async () => {
    const input = {sku:"SKU-001",quantity:2,discountPercent};
    assert.deepEqual(await quote(input), expected(input.sku,input.quantity,24000,discountPercent));
  });
  test("real peer HTTP invalid discounts and consumer rejection", async () => {
    for (const discountPercent of [-1,101,1.5,"10",null,false,true,""]) {
      const input = {sku:"SKU-001",quantity:2,discountPercent};
      assert.equal((await post(input)).status,400);
      await assert.rejects(() => quote(input), /400/);
    }
  });
}
`;
}
