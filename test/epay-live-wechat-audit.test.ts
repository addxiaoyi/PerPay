import assert from "node:assert/strict";
import { it } from "node:test";
import { auditWechatRows, runLiveWechatAudit } from "../scripts/audit-live-wechat-paid.ts";
import type { observeLegacyWechatPayment } from "../src/epay-compat/legacy-wechat-observation.ts";

it("limits observations to exactly two valid source records and reports only aggregate states", async () => {
  const rows = [
    { tradeNo: "one", providerTradeNo: "first", money: "12.03", config: { appId: "secret" } },
    { tradeNo: "two", providerTradeNo: "second", money: "0.29", config: { appId: "secret" } },
  ];
  const seen: number[] = [];
  const observe: typeof observeLegacyWechatPayment = async input => {
    seen.push(input.amountCents);
    return { state: input.tradeNo === "one" ? "SUCCESS" : "NOTPAY", amountCents: input.amountCents };
  };
  assert.deepEqual(await auditWechatRows(rows, observe, fetch), { SUCCESS: 1, NOTPAY: 1 });
  assert.deepEqual(seen, [1203, 29]);
  await assert.rejects(auditWechatRows([rows[0]], observe, fetch), /count/);
  await assert.rejects(auditWechatRows([rows[0], { ...rows[1], money: "0.001" }], observe, fetch), /amount/);
  await assert.rejects(auditWechatRows([rows[0], { ...rows[1], config: null }], observe, fetch), /row/);
  await assert.rejects(runLiveWechatAudit("not-a-pid"), /explicitly enabled/);
});
