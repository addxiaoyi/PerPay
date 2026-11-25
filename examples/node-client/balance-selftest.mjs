// Local SDK exercise: every HTTP request is intercepted by the in-memory transport.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { StarPayBalanceClient } from './balance-payment.mjs';
import { balanceCallbackHandler } from './balance-callback-handler.mjs';

const key = 'starpay-local-demo-key-not-a-merchant-secret';
const now = 1_800_000_000_000;
const order = { id: '00000000-0000-4000-8000-000000000001', merchantOrderId: 'DEMO_ORDER_001', receiverMerchantId: 1,
  amountCents: 1000, feeCents: 10, tradeNo: 'DEMO_TRADE', status: 'pending', paidAt: null, refundedAt: null };
let created = false, refundId = null, localRequests = 0;
const sign = (timestamp, body) => 'sha256=' + createHmac('sha256', key).update(`${timestamp}\n${body}`).digest('hex');
const client = new StarPayBalanceClient({ baseUrl: 'https://sandbox.invalid/pay', pid: '1', key, notifyUrl: 'https://shop.invalid/notify', clock: () => now,
  send: async (url, init) => {
    localRequests++;
    const headers = new Headers(init.headers), timestamp = headers.get('x-starpay-timestamp');
    assert.equal(new URL(url).origin, 'https://sandbox.invalid');
    assert.equal(headers.get('x-starpay-pid'), '1');
    assert.equal(headers.get('x-starpay-signature'), sign(timestamp, init.body));
    const command = JSON.parse(init.body);
    if (url.endsWith('/orders')) {
      assert.equal(command.operation, 'starpay.balance.create.v1');
      assert.equal(command.order.merchantOrderId, order.merchantOrderId);
      assert.equal(command.order.amount, '10.00');
      const duplicate = created; created = true;
      return Response.json({ ok: true, data: { order, duplicate, token: 'LOCAL_ONLY', checkoutUrl: 'https://sandbox.invalid/checkout' } });
    }
    assert.equal(command.orderId, order.id);
    if (url.endsWith('/query')) {
      assert.equal(command.operation, 'starpay.balance.query.v1');
      return Response.json({ ok: true, data: { order } });
    }
    assert.ok(url.endsWith('/refund')); assert.equal(command.operation, 'starpay.balance.refund.v1');
    if (refundId) assert.equal(command.requestId, refundId);
    const duplicate = Boolean(refundId); refundId = command.requestId;
    order.status = 'refunded'; order.refundedAt = now;
    return Response.json({ ok: true, data: { order, duplicate } });
  },
});
const input = { merchantOrderId: order.merchantOrderId, amount: '10.00', subject: 'Local demonstration' };
assert.equal((await client.create(input)).duplicate, false);
assert.equal((await client.create(input)).duplicate, true);
assert.equal((await client.query(order.id)).order.status, 'pending');
order.status = 'paid'; order.paidAt = now;
const expected = { paymentOrderId: order.id, merchantOrderId: order.merchantOrderId, amount: '10.00', amountCents: 1000 };
const body = JSON.stringify({ event: 'payment.paid', type: 'balance', orderId: order.id, merchantOrderId: order.merchantOrderId, amount: '10.00' });
const timestamp = String(Math.floor(now / 1000));
const headers = new Headers({ 'x-lightpay-timestamp': timestamp, 'x-lightpay-signature': sign(timestamp, body), 'x-idempotency-key': 'DEMO_CALLBACK_001' });
const delivered = new Set(); let fulfilled = 0;
async function deliver() {
  const notice = await client.verifyPaidCallback(body, headers, expected);
  // A real integration uses a database transaction and unique constraints here.
  if (notice.paid && !delivered.has(notice.callbackId)) { delivered.add(notice.callbackId); fulfilled++; }
}
await deliver(); await deliver(); assert.equal(fulfilled, 1);
const noticeHandler=balanceCallbackHandler({clientForOrder:()=>client,logError:()=>{},orders:{
  findByMerchantOrderId:async id=>id===order.merchantOrderId?{...expected,id:'local-order'}:null,
  confirmPaymentOnce:async notice=>{if(!delivered.has(notice.callbackId)){delivered.add(notice.callbackId);fulfilled++;}},
}});
const noticeHeaders=new Headers(headers);noticeHeaders.set('content-type','application/json');
for(let repeat=0;repeat<2;repeat++)assert.equal((await noticeHandler(new Request('https://shop.invalid/notify',{method:'POST',headers:noticeHeaders,body}))).status,200);
assert.equal(fulfilled,1);
assert.equal((await noticeHandler(new Request('https://shop.invalid/notify',{method:'POST',headers:noticeHeaders,body:body.replace('10.00','99.00')}))).status,503);
const currentKey='current-demo-key-after-rotation';
const rotated=new StarPayBalanceClient({baseUrl:'https://sandbox.invalid/pay',pid:'1',key:currentKey,callbackKey:key,clock:()=>now,send:async(_url,init)=>{
  const sent=new Headers(init.headers);
  assert.equal(sent.get('x-starpay-signature'),'sha256='+createHmac('sha256',currentKey).update(sent.get('x-starpay-timestamp')+'\n'+init.body).digest('hex'));
  return Response.json({ok:true,data:{order}});
}});
assert.equal((await rotated.verifyPaidCallback(body,headers,expected)).paid,true);
await assert.rejects(client.verifyPaidCallback(body.replace('10.00', '99.00'), headers, expected), /signature mismatch/);
const expired = new Headers(headers); expired.set('x-lightpay-timestamp', String(Number(timestamp) - 301));
await assert.rejects(client.verifyPaidCallback(body, expired, expected), /signature headers/);
assert.equal((await client.refund(order.id, 'DEMO_REFUND_REQUEST_001')).order.status, 'refunded');
assert.equal((await client.refund(order.id, 'DEMO_REFUND_REQUEST_001')).duplicate, true);
assert.equal((await client.verifyPaidCallback(body, headers, expected)).paid, false);
console.log(JSON.stringify({ passed: true, localRequests, networkRequests: 0, realOrders: 0, realDebits: 0,
  checks: ['create', 'retry', 'query', 'callback', 'callback handler', 'key rotation', 'duplicate delivery', 'tampering', 'timestamp', 'refund', 'late callback'] }, null, 2));
