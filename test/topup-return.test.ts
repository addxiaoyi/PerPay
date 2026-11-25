import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mainOrderFixture, mainIdentity } from './epay-main-native-fixture.ts';
import { createBalancePayments } from '../src/epay-compat/balance-payment.ts';
import { topupReturnUrl } from '../src/epay-compat/topup-return.ts';

it('returns to the original signed order and payer only, and never transfers funds', async () => {
  const f=await mainOrderFixture();const now=1_800_000_000_000;
  try {
    f.database.write(sql=>{for(const id of [1,2]){
      sql.prepare('INSERT INTO epay_balance_openings VALUES(?,?,0,0,0,?,?,0)').run(id,'synthetic','a'.repeat(64),'b'.repeat(64));
      sql.prepare('INSERT INTO epay_live_balances VALUES(?,0,0,0)').run(id);
    }});
    const options={...f,clock:()=>now,publicOrigin:'https://gateway.example',basePath:'/pay'};
    const payments=createBalancePayments({...options,enabled:()=>true});
    const order=payments.create(mainIdentity,{merchantOrderId:'resume-order-001',subject:'Synthetic product',amount:'10.00'});
    const payer={merchantId:'main-2',mainApiId:'lp-2',epayMerchantId:2,userId:'payer',role:'owner' as const};
    const resume={orderId:order.order.id,token:order.token};
    const url=new URL(topupReturnUrl(options,payer,resume));
    assert.equal(url.origin,'https://gateway.example');assert.equal(url.pathname,'/pay/merchant/topups');
    assert.equal(url.searchParams.get('merchantId'),payer.merchantId);
    assert.equal(url.searchParams.get('resumeOrderId'),order.order.id);
    assert.equal(url.searchParams.get('resumeToken'),order.token);
    assert.throws(()=>topupReturnUrl(options,payer,{...resume,token:'forged'}),/capability/);
    assert.throws(()=>topupReturnUrl({...options,clock:()=>now+3*3600000},payer,resume),/capability/);
    assert.throws(()=>topupReturnUrl(options,{...payer,role:'member'},resume),/owner/);
    assert.equal(Number(f.database.read(sql=>sql.prepare('SELECT count(*) n FROM epay_balance_ledger').get())!.n),0);
  } finally {f.close();}
});
