import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from '../src/epay-compat/schema.ts';
import { TAX_INVOICE_SCHEMA_SQL,FA_PIAO_SCHEMA_SQL,INVOICE_RECONCILIATION_SCHEMA_SQL } from '../src/invoices/schema.ts';
import { FEE_INVOICE_SCHEMA_SQL } from '../src/invoices/fee-schema.ts';
import { BALANCE_PAYMENT_SCHEMA_SQL } from '../src/epay-compat/balance-payment-schema.ts';

it('rebuilds fee requests for balance payments without losing issued invoice history or receipt foreign keys',()=>{
 const sql=new DatabaseSync(':memory:');try{
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  sql.exec(`CREATE TABLE epay_native_refunds(trade_no TEXT,status TEXT);
    CREATE TABLE epay_alipay_confirmations(trade_no TEXT,merchant_id INTEGER,fee_cents INTEGER);
    CREATE TABLE epay_wechat_confirmations(trade_no TEXT,merchant_id INTEGER,fee_cents INTEGER);`);
  sql.exec(TAX_INVOICE_SCHEMA_SQL);sql.exec(FA_PIAO_SCHEMA_SQL);sql.exec(INVOICE_RECONCILIATION_SCHEMA_SQL);sql.exec(FEE_INVOICE_SCHEMA_SQL);
  sql.exec(`INSERT INTO epay_merchant_accounts VALUES(1,'Synthetic',0,1,500,0,0);
    INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
    VALUES('paid-fee','paid-fee',1,'Synthetic',1000,'https://example.test','PAID','PENDING',0,0,0);
    INSERT INTO epay_alipay_confirmations VALUES('paid-fee',1,50);`);
  sql.prepare('INSERT INTO epay_fee_invoice_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    '11111111-1111-1111-1111-111111111111','a'.repeat(32),'a'.repeat(32),1,'existing-fee-request',1,'paid-fee',50,'alipay','provider','{}','ORGANIZATION','Buyer','91310000987654321B','buyer@example.test',
    'owner','ISSUED','20260000000000000001',null,0,0);
  sql.prepare("INSERT INTO epay_fee_invoice_provider_receipts VALUES(?,'fa-piao',?,0)").run('a'.repeat(32),'20260000000000000001');
  const request=sql.prepare('SELECT * FROM epay_fee_invoice_requests').get(),receipt=sql.prepare('SELECT * FROM epay_fee_invoice_provider_receipts').get();
  sql.exec('BEGIN');sql.exec(BALANCE_PAYMENT_SCHEMA_SQL);sql.exec('COMMIT');
  assert.deepEqual(sql.prepare('SELECT * FROM epay_fee_invoice_requests').get(),request);
  assert.deepEqual(sql.prepare('SELECT * FROM epay_fee_invoice_provider_receipts').get(),receipt);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{sql.close();}
});
