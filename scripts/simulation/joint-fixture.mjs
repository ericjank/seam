/** Shared, explicit acceptance oracle for the two synthetic quote revisions. */
export function jointFixture({ liveURL, role }) {
  return `import assert from "node:assert/strict";
import { test } from "node:test";
${role === "consumer" ? 'import { getQuote } from "./client.mjs";' : ''}
const base = ${JSON.stringify(liveURL)};
const configuration = await fetch(base + "/__seam_acceptance__/revision");
assert.equal(configuration.status, 200);
const { revision } = await configuration.json();
assert.ok(revision === 1 || revision === 2);
const post = input => fetch(base + "/quote", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
const quote = ${role === "consumer" ? "input => getQuote(base, input)" : "async input => { const response = await post(input); if (!response.ok) throw new Error(\"HTTP \" + response.status); return response.json(); }"};
const expected = (sku, quantity, subtotal, percent = 0) => ({ sku, quantity, subtotal, currency:"CNY", ...(revision === 2 ? {discount:Math.floor(subtotal * percent / 100),total:subtotal - Math.floor(subtotal * percent / 100)} : {}) });
for (const [sku, quantity, subtotal] of [["SKU-001",2,24000],["SKU-002",3,13500],["SKU-001",1,12000],["SKU-002",100,450000]]) {
  test("real peer HTTP quote " + sku + " quantity=" + quantity, async () => {
    assert.deepEqual(await quote({sku,quantity}), expected(sku,quantity,subtotal));
  });
}
test("real peer HTTP invalid quantities and consumer rejection", async () => {
  for (const quantity of [0,101,1.5,"2",null,false]) {
    const input = {sku:"SKU-001",quantity};
    assert.equal((await post(input)).status,400);
    await assert.rejects(() => quote(input), /400/);
  }
});
test("real peer HTTP unknown SKU and consumer rejection", async () => {
  const input = {sku:"unknown",quantity:1};
  assert.equal((await post(input)).status,400);
  await assert.rejects(() => quote(input), /400/);
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
