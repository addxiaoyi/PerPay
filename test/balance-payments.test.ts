import assert from 'node:assert/strict';
import { it } from 'node:test';
import { balanceFixture } from './epay-live-balance-fixture.ts';
import { createBalancePayments } from '../src/epay-compat/balance-payment.ts';
import { readLiveBalance } from '../src/epay-compat/live-balance.ts';
import { auditConfirmedPayments } from '../src/epay-compat/confirmation-audit.ts';
import { purchaseInvoiceSubscription,readInvoiceSubscription } from '../src/invoices/subscription.ts';
import { createBalanceMerchantApi,createBalancePayerRoutes } from '../src/epay-compat/balance-payment-routes.ts';
import { createHash } from 'node:crypto';
import { StarPayBalanceClient } from '../examples/node-client/balance-payment.mjs';
import { readMainCallback,deliverMainCallback } from '../src/epay-compat/main-callback.ts';
import { readConfirmedOrder } from '../src/epay-compat/confirmed-order.ts';
import { Hono } from 'hono';
import { createInvoiceSubscriptionRoutes } from '../src/invoices/subscription-routes.ts';
import type { InvoiceProvider } from '../src/invoices/model.ts';

const NOW=1_800_000_000_000;
const payer={merchantId:'main-1',mainApiId:'api-1',epayMerchantId:1,userId:'owner-1',role:'owner' as const};
const receiver={merchantId:'main-2',mainApiId:'api-2',epayMerchantId:2,userId:'owner-2',role:'owner' as const};
async function fixture(){const f=await balanceFixture();f.db.write(sql=>{for(const [id,amount]of [[1,20_000],[2,0]] as const){
 sql.prepare('INSERT INTO epay_balance_openings VALUES(?,?,?,?,?,?,?,?)').run(id,'fixture',amount,0,amount,'a'.repeat(64),'b'.repeat(64),0);
 sql.prepare('INSERT INTO epay_live_balances VALUES(?,?,0,0)').run(id,amount);
}});return f;}
it('transfers the exact amount once, credits fee-adjusted revenue, emits a callback and refunds only to the original payer',async()=>{
 const f=await fixture();try{
  const pay=createBalancePayments({database:f.db,masterKey:f.key,enabled:()=>true,clock:()=>NOW});
  const identity={merchantId:'main-2',epayMerchantId:2,apiId:'api-2',callbackUrl:'https://merchant.example/notify',callbackSecret:'s'.repeat(32)};
  const created=pay.create(identity,{merchantOrderId:'outside-001',amount:'10.00',subject:'Synthetic product',returnUrl:'https://merchant.example/result'});
  assert.equal(created.order.amountCents,1000);assert.equal(pay.create(identity,{merchantOrderId:'outside-001',amount:'10.00',subject:'Synthetic product',returnUrl:'https://merchant.example/result'}).duplicate,true);
  const command={requestId:'balance-pay-request-001',token:created.token,expectedAmountCents:1000,expectedBalanceVersion:0};
  const paid=pay.pay(payer,created.order.id,command);assert.equal(paid.balance.availableCents,19000);
  assert.equal(f.db.read(sql=>readLiveBalance(sql,2).availableCents),950);
  assert.equal(pay.pay(payer,created.order.id,command).duplicate,true);
  assert.equal(f.db.read(sql=>auditConfirmedPayments(sql).inconsistent),0);
  assert.equal(f.db.read(sql=>auditConfirmedPayments(sql).unconfirmedCallbacks),0);
  assert.equal(pay.refund(receiver,created.order.id,'balance-refund-001').order.status,'refunded');
  assert.equal(f.db.read(sql=>readLiveBalance(sql,1).availableCents),20000);assert.equal(f.db.read(sql=>readLiveBalance(sql,2).availableCents),0);
  assert.equal(pay.refund(receiver,created.order.id,'balance-refund-001').duplicate,true);
 }finally{f.close();}
});

it('requires payer CSRF and rejects members without debiting any wallet',async()=>{
 const f=await fixture();try{
  const options={database:f.db,masterKey:f.key,enabled:()=>true,clock:()=>NOW,identityOrigin:'http://127.0.0.1:8787',publicOrigin:'https://gateway.example'};
  const payments=createBalancePayments(options),created=payments.create({merchantId:'main-2',epayMerchantId:2,apiId:'api-2',callbackUrl:'https://shop.example/notify',callbackSecret:'s'.repeat(32)},
   {merchantOrderId:'csrf-order-1',amount:'10.00',subject:'Synthetic'});
  const app=new Hono().route('/payer',createBalancePayerRoutes({...options,identityFetch:async(_input,init)=>Response.json({ok:true,merchantId:'main-1',apiId:'api-1',role:new Headers(init?.headers).get('cookie'),userId:'owner-1'})}));
  const url=`/payer/${created.order.id}/session?merchantId=main-1`;
  assert.equal((await app.request(url,{headers:{cookie:'member','x-checkout-token':created.token}})).status,403);
  const session=await(await app.request(url,{headers:{cookie:'owner','x-checkout-token':created.token}})).json() as {data:{csrfToken:string}};
  const body=JSON.stringify({requestId:'csrf-balance-pay-001',token:created.token,expectedAmountCents:1000,expectedBalanceVersion:0});
  const denied=await app.request(`/payer/${created.order.id}/pay?merchantId=main-1`,{method:'POST',headers:{cookie:'owner',origin:'https://evil.example','content-type':'application/json','x-csrf-token':session.data.csrfToken},body});
  assert.equal(denied.status,403);assert.equal(f.db.read(sql=>readLiveBalance(sql,1).availableCents),20000);
 }finally{f.close();}
});

it('does not deduct an annual fee after merchant authorization is revoked during the provider check',async()=>{
 const f=await fixture();let revoked=false;
 const provider:InvoiceProvider={kind:'fa-piao',issuanceEnabled:true,platformFees:{enabled:true,validUntil:NOW+86_400_000,profile:{provider:'fa-piao',subMchId:'1000',sellerName:'Synthetic',sellerTaxId:'91310000123456789A',billingPersonId:'biller',itemName:'Fee',taxCode:'3040205000000000000',taxRateBps:100}},
  authorize:async()=>({authorized:true,subMchId:'1000',billingPersonIds:['biller']}),checkStatus:async()=>{revoked=true;return {authorized:true,subMchId:'1000',billingPersonIds:['biller']};},
  issue:async()=>{throw Error('issuance prohibited');},query:async()=>({status:'UNKNOWN'}),download:async()=>{throw Error('no invoice');},invite:async()=>({url:'https://example.test'})};
 const app=new Hono().route('/subscription',createInvoiceSubscriptionRoutes({database:f.db,masterKey:f.key,enabled:true,provider,clock:()=>NOW,
  publicOrigin:'https://gateway.example',identityOrigin:'http://127.0.0.1:8787',identityFetch:async()=>revoked?Response.json({ok:false},{status:401}):Response.json({ok:true,merchantId:'main-1',apiId:'api-1',role:'owner',userId:'owner-1'})}));
 try{
  const session=await(await app.request('/subscription?merchantId=main-1',{headers:{cookie:'owner'}})).json() as {data:{csrfToken:string}};
  const response=await app.request('/subscription?merchantId=main-1',{method:'POST',headers:{cookie:'owner',origin:'https://gateway.example','x-csrf-token':session.data.csrfToken,'content-type':'application/json'},
   body:JSON.stringify({requestId:'revoked-annual-request',expectedBalanceVersion:0,expectedValidUntil:0})});
  assert.equal(response.status,401);assert.equal(f.db.read(sql=>readLiveBalance(sql,1).availableCents),20000);
  assert.equal(f.db.read(sql=>sql.prepare('SELECT count(*) n FROM epay_invoice_subscription_receipts').get()!.n),0n);
 }finally{f.close();}
});

it('rejects altered amounts, self payments, members, stale balance versions and overdrafts without partial postings',async()=>{
 const f=await fixture();try{
  const payments=createBalancePayments({database:f.db,masterKey:f.key,enabled:()=>true,clock:()=>NOW});
  const identity={merchantId:'main-2',epayMerchantId:2,apiId:'api-2',callbackUrl:'https://shop.example/notify',callbackSecret:'s'.repeat(32)};
  const first=payments.create(identity,{merchantOrderId:'large-order-1',amount:'150.00',subject:'Synthetic'}),second=payments.create(identity,{merchantOrderId:'large-order-2',amount:'150.00',subject:'Synthetic'});
  const cmd={requestId:'balance-large-request-1',token:first.token,expectedAmountCents:15000,expectedBalanceVersion:0};
  assert.throws(()=>payments.pay({...payer,role:'member'},first.order.id,cmd),/owner/);
  assert.throws(()=>payments.pay(receiver,first.order.id,cmd),/itself/);
  assert.throws(()=>payments.pay(payer,first.order.id,{...cmd,expectedAmountCents:1}),/amount differs/);
  payments.pay(payer,first.order.id,cmd);
  assert.throws(()=>payments.pay(payer,second.order.id,{...cmd,token:second.token,requestId:'balance-large-request-2'}),/balance changed/);
  assert.throws(()=>payments.pay(payer,second.order.id,{...cmd,token:second.token,requestId:'balance-large-request-2',expectedBalanceVersion:1}),/insufficient/);
  assert.equal(f.db.read(sql=>readLiveBalance(sql,1).availableCents),5000);
  assert.equal(f.db.read(sql=>sql.prepare('SELECT count(*) n FROM epay_balance_confirmations').get()!.n),1n);
 }finally{f.close();}
});

it('runs the receiving-site PID/key adapter and verifies a signed paid callback against the current order',async()=>{
 const f=await fixture();try{
  const key='synthetic-merchant-key';f.db.write(sql=>{
    const sealed=f.cipher.encrypt('epay:merchant:2:api_key',1,key);
    sql.prepare('INSERT INTO epay_merchant_secrets VALUES(2,1,1,?,?,?,?,0)').run(sealed.nonce,sealed.ciphertext,sealed.authenticationTag,createHash('sha256').update(key).digest('hex'));
  });
  const options={database:f.db,masterKey:f.key,identityOrigin:'http://127.0.0.1:8787',publicOrigin:'https://gateway.example',basePath:'/pay',enabled:()=>true,clock:()=>NOW};
  const app=createBalanceMerchantApi(options);
  const client=new StarPayBalanceClient({baseUrl:'https://gateway.example/pay',pid:'2',key,notifyUrl:'https://shop.example/notify',clock:()=>NOW,
    send:async(input:string|URL|Request,init?:RequestInit)=>app.request(new URL(String(input)).pathname.replace('/pay/epay/balance',''),init)});
  const created=await client.create({merchantOrderId:'adapter-order-1',amount:'10.00',subject:'Synthetic'});
  const payments=createBalancePayments(options);payments.pay(payer,created.order.id,{requestId:'adapter-pay-request-1',token:created.token,expectedAmountCents:1000,expectedBalanceVersion:0});
  const callback=f.db.read(sql=>readMainCallback(sql,f.cipher,readConfirmedOrder(sql,created.order.tradeNo,2)!))!;
  let delivered=false;
  await deliverMainCallback({callback,phase:'GET',now:NOW,timeoutMilliseconds:5000,transport:{post:async(request)=>{
    const verified=await client.verifyPaidCallback(Buffer.from(request.body).toString('utf-8'),new Headers(request.headers),{paymentOrderId:created.order.id,merchantOrderId:'adapter-order-1',amount:'10.00',amountCents:1000});
    assert.equal(verified.paid,true);delivered=true;return {status:200,body:Buffer.from('success'),contentType:'text/plain',contentEncoding:null,
      responseFingerprint:'a'.repeat(64),resolvedAddressesFingerprint:'b'.repeat(64),connectedAddress:'198.51.100.1'};
  }}});
  assert.equal(delivered,true);assert.equal((await client.query(created.order.id)).order.status,'paid');
  assert.equal((await client.refund(created.order.id,'adapter-refund-request-1')).order.status,'refunded');
 }finally{f.close();}
});
it('deducts the fixed annual fee once and extends remaining time on renewal',async()=>{
 const f=await fixture();try{
  const input={requestId:'invoice-year-request-001',expectedBalanceVersion:0,expectedValidUntil:0};
  const first=purchaseInvoiceSubscription(f.db,payer,input,NOW);
  assert.equal(first.balance.availableCents,10000);assert.equal(first.subscription.validUntil,NOW+365*86_400_000);
  assert.equal(purchaseInvoiceSubscription(f.db,payer,input,NOW).duplicate,true);
  const next=purchaseInvoiceSubscription(f.db,payer,{requestId:'invoice-year-request-002',expectedBalanceVersion:1,expectedValidUntil:first.subscription.validUntil},NOW+1000);
  assert.equal(next.balance.availableCents,0);assert.equal(next.subscription.validUntil,NOW+730*86_400_000);
  assert.equal(f.db.read(sql=>readInvoiceSubscription(sql,1,NOW).active),true);
  assert.throws(()=>purchaseInvoiceSubscription(f.db,payer,{requestId:'invoice-year-request-003',expectedBalanceVersion:2,expectedValidUntil:next.subscription.validUntil},NOW),/100 yuan/);
 }finally{f.close();}
});
