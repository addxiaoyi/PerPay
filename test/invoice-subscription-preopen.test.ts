import assert from 'node:assert/strict';
import { it } from 'node:test';
import { balanceFixture } from './epay-live-balance-fixture.ts';
import { createInvoiceSubscriptionRoutes } from '../src/invoices/subscription-routes.ts';
import type { InvoiceProvider } from '../src/invoices/model.ts';
const NOW=1_800_000_000_000;
it('permits acknowledged pre-purchase once while real issuance stays off and rejects unconfirmed/member deductions',async()=>{
 const f=await balanceFixture();let providerCalls=0;
 try{
  f.db.write(sql=>sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',20000,0,20000,'${'a'.repeat(64)}','${'b'.repeat(64)}',0);INSERT INTO epay_live_balances VALUES(1,20000,0,0)`));
  const provider={issuanceEnabled:false,platformFees:{enabled:false,validUntil:NOW+86400000,profile:{}},checkStatus:async()=>{providerCalls++;throw Error('closed provider must not be contacted');}} as unknown as InvoiceProvider;
  const app=createInvoiceSubscriptionRoutes({database:f.db,masterKey:f.key,enabled:true,provider,clock:()=>NOW,identityOrigin:'http://127.0.0.1:8787',publicOrigin:'https://gateway.example',identityFetch:async(_,init)=>Response.json({ok:true,merchantId:'main-1',apiId:'api-1',userId:'owner',role:new Headers(init?.headers).get('cookie')})});
  const session=await(await app.request('/?merchantId=main-1',{headers:{cookie:'owner'}})).json() as {data:{canPurchase:boolean;issuanceEnabled:boolean;csrfToken:string}};
  assert.equal(session.data.canPurchase,true);assert.equal(session.data.issuanceEnabled,false);
  const buy=(ack=false,role='owner')=>app.request('/?merchantId=main-1',{method:'POST',headers:{cookie:role,origin:'https://gateway.example','content-type':'application/json','x-csrf-token':session.data.csrfToken},body:JSON.stringify({requestId:'synthetic-preopen-request',expectedBalanceVersion:0,expectedValidUntil:0,acknowledgePendingIssuance:ack})});
  assert.equal((await buy()).status,409);assert.equal((await buy(true,'member')).status,403);
  assert.equal((await buy(true)).status,200);assert.equal((await buy(true)).status,200);
  const state=f.db.read(sql=>({receipts:sql.prepare('SELECT count(*) n FROM epay_invoice_subscription_receipts').get()!.n,balance:sql.prepare('SELECT available_cents FROM epay_live_balances WHERE merchant_id=1').get()!.available_cents,expiry:sql.prepare('SELECT valid_until FROM epay_invoice_subscriptions').get()!.valid_until,invoices:sql.prepare('SELECT count(*) n FROM epay_fee_invoice_requests').get()!.n}));
  assert.equal(Number(state.receipts),1);assert.equal(Number(state.balance),10000);assert.equal(Number(state.expiry),NOW+365*86400000);assert.equal(Number(state.invoices),0);assert.equal(providerCalls,0);
 }finally{f.close();}
});
