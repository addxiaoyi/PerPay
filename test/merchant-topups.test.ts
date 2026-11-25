import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { it } from 'node:test';
import { mainOrderFixture, mainIdentity, mainInput } from './epay-main-native-fixture.ts';
import { createMainNativeOrder } from '../src/epay-compat/main-native-order.ts';
import { createMainOrderRoutes } from '../src/epay-compat/main-order-routes.ts';
import { confirmAlipayPayment } from '../src/epay-compat/confirm-alipay.ts';
import { readLiveBalance } from '../src/epay-compat/live-balance.ts';
import { EPayCallbackOutbox } from '../src/epay-compat/outbox.ts';
import { createInvoiceService } from '../src/invoices/service.ts';
import type { InvoiceProvider } from '../src/invoices/model.ts';

const NOW = 1_800_000_000_000;
const requestId = 'synthetic-topup-request-01';
function openBalance(f: Awaited<ReturnType<typeof mainOrderFixture>>) {
  f.database.write(sql => sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,'${'a'.repeat(64)}','${'b'.repeat(64)}',0);
    INSERT INTO epay_live_balances VALUES(1,0,0,0)`));
}
it('credits full recharge principal exactly once only after signed exact-amount evidence, without a goods callback', async () => {
  const f = await mainOrderFixture();
  try {
    openBalance(f);
    const input = { ...mainInput, amount: '100.00', channel: 'alipay_web', merchantOrderId: 'topup-synthetic-01' };
    const topup = { requestId, actorId: 'owner' };
    const order = createMainNativeOrder({ ...f, identity: mainIdentity, input, topup, now: NOW });
    const intent = f.database.read(sql => sql.prepare('SELECT amount_cents,fee_cents FROM epay_alipay_intents WHERE trade_no=?').get(order.tradeNo));
    assert.equal(Number(intent!.fee_cents), 0);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).availableCents, 0);
    const evidence = (amount = '100.00') => {
      const fields = { app_id: 'app', seller_id: 'seller', out_trade_no: order.tradeNo, trade_no: 'synthetic-provider-topup', trade_status: 'TRADE_SUCCESS', total_amount: amount };
      const content = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
      return { ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(content), f.platform.privateKey).toString('base64') };
    };
    assert.throws(() => confirmAlipayPayment(f.database, { ...evidence(), total_amount: '200.00' }, NOW + 1), /signature/);
    assert.throws(() => confirmAlipayPayment(f.database, evidence('99.99'), NOW + 1), /amount/);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).availableCents, 0);
    assert.deepEqual(confirmAlipayPayment(f.database, evidence(), NOW + 2), { duplicate: false });
    assert.deepEqual(confirmAlipayPayment(f.database, evidence(), NOW + 3), { duplicate: true });
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).availableCents, 10000);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).version, 1);
    assert.equal(new EPayCallbackOutbox(f.database).claim(NOW + 4, 1000, 3), null);
    assert.equal(f.database.read(sql => sql.prepare('SELECT notify_status FROM epay_orders WHERE trade_no=?').get(order.tradeNo))!.notify_status, 'SUCCESS');
    assert.equal(createMainNativeOrder({ ...f, identity: mainIdentity, input, topup, now: NOW + 5 }).created, false);
    assert.throws(() => createMainNativeOrder({ ...f, identity: mainIdentity, input, now: NOW + 5 }), /kind conflicts/);
    const owner = { merchantId: 'main-1', mainApiId: 'lp-1', epayMerchantId: 1, role: 'owner' as const, userId: 'owner' };
    await assert.rejects(createInvoiceService({database:f.database,provider:{} as InvoiceProvider}).createAndIssue(owner, {
      requestId:'synthetic-invoice-topup-01',tradeNo:order.tradeNo,buyerType:'INDIVIDUAL',title:'Synthetic buyer',taxId:'',email:'buyer@example.test'
    }), /topup principal/);
    assert.throws(() => f.database.write(sql => sql.prepare('DELETE FROM epay_balance_topups').run()), /immutable/);
  } finally { f.close(); }
});

it('normal merchant API cannot spoof recharge mode or convert an existing sales order', async () => {
  const f = await mainOrderFixture();
  try {
    assert.throws(() => createMainNativeOrder({...f,identity:mainIdentity,input:{...mainInput,topup:true},now:NOW}));
    const order = createMainNativeOrder({...f,identity:mainIdentity,input:mainInput,now:NOW});
    assert.equal(Number(f.database.read(sql=>sql.prepare('SELECT fee_cents FROM epay_alipay_intents WHERE trade_no=?').get(order.tradeNo))!.fee_cents),5);
    assert.throws(()=>createMainNativeOrder({...f,identity:mainIdentity,input:mainInput,topup:{requestId,actorId:'owner'},now:NOW}),/kind conflicts/);
    assert.equal(Number(f.database.read(sql=>sql.prepare('SELECT count(*) n FROM epay_balance_topups').get())!.n),0);
  } finally { f.close(); }
});

it('requires owner/admin, same-origin recharge CSRF and supported channels before persisting a pending order', async () => {
  const f = await mainOrderFixture();
  try {
    openBalance(f);
    const gateway = {fetch:()=>Response.json({ok:true})};
    const app = createMainOrderRoutes({...f,identityOrigin:'http://127.0.0.1:8787',publicOrigin:'https://gateway.example',basePath:'/pay',clock:()=>NOW,
      canCreateTopup:()=>true,alipay:gateway,alipayWeb:gateway,wechat:gateway,onError:code=>{throw Error(code);},
      send:async(input,init)=>{
        const path=new URL(String(input)).pathname;
        if(path==='/api/merchant/keys')return Response.json({ok:true,apiId:'lp-1',apiSecret:'synthetic-key'});
        if(path==='/api/merchant/profile')return Response.json({ok:true,merchant:{id:'main-1',apiId:'lp-1',enabled:true,callbackUrl:'https://merchant.example/notify'}});
        return Response.json({ok:true,merchantId:'main-1',apiId:'lp-1',userId:'owner',role:new Headers(init?.headers).get('cookie')});
      }});
    assert.equal((await app.request('/topups/session?merchantId=main-1',{headers:{cookie:'member'}})).status,403);
    const session=await (await app.request('/topups/session?merchantId=main-1',{headers:{cookie:'owner'}})).json() as {data:{csrfToken:string}};
    const submit=(patch:Record<string,unknown>={},token=session.data.csrfToken,origin='https://gateway.example',body?:string)=>app.request('/topups?merchantId=main-1',{method:'POST',headers:{cookie:'owner',origin,'x-csrf-token':token,'content-type':'application/json'},body:body??JSON.stringify({requestId,amount:'100.00',channel:'alipay_web',...patch})});
    assert.equal((await submit({},'wrong')).status,403);
    assert.equal((await submit({},session.data.csrfToken,'https://evil.example')).status,403);
    assert.equal((await submit({channel:'wechat_native'})).status,400);
    assert.equal((await submit({amount:'0.001'})).status,400);
    assert.equal((await submit({},session.data.csrfToken,'https://gateway.example','{')).status,400);
    assert.equal(Number(f.database.read(sql=>sql.prepare('SELECT count(*) n FROM epay_balance_topups').get())!.n),0);
    const first=await submit();assert.equal(first.status,202);
    assert.equal((await submit()).status,202);
    assert.equal(Number(f.database.read(sql=>sql.prepare('SELECT count(*) n FROM epay_balance_topups').get())!.n),1);
    const history=await(await app.request('/topups?merchantId=main-1',{headers:{cookie:'owner'}})).json() as {data:{topups:{checkoutUrl:string}[]}};
    assert.equal(history.data.topups.length,1);
    assert.ok(history.data.topups[0]!.checkoutUrl.startsWith('https://gateway.example/pay/epay/main/checkout/'));
    assert.equal((await app.request('/topups/notification',{method:'POST'})).status,400);
    assert.equal(f.database.read(sql=>readLiveBalance(sql,1)).availableCents,0);
  } finally { f.close(); }
});
