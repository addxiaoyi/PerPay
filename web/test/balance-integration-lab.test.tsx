import { webcrypto, createHmac } from 'node:crypto';
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { BalanceIntegrationLab } from '../src/pages/balance-integration-lab';
import { createDemoNotice, verifyDemoNotice, DEMO_KEY, DEMO_ORDER } from '../src/lib/balance-demo';
import { StarPayBalanceClient } from '../../examples/node-client/balance-payment.mjs';

it('generates callbacks that the real SDK accepts and rejects tampering, mismatched orders and expiry', async () => {
  vi.stubGlobal('crypto', webcrypto);
  try {
    const now = 1_800_000_000_000, notice = await createDemoNotice(now);
    expect(await verifyDemoNotice(notice, now)).toContain('匹配');
    const client = new StarPayBalanceClient({baseUrl:'https://sandbox.invalid/pay',pid:1,key:DEMO_KEY,clock:()=>now,
      send:async()=>Response.json({ok:true,data:{order:{receiverMerchantId:1,status:'paid',merchantOrderId:DEMO_ORDER.merchantOrderId,amountCents:1000}}})});
    const headers = new Headers({'x-lightpay-timestamp':notice.timestamp,'x-lightpay-signature':notice.signature,'x-idempotency-key':notice.callbackId});
    expect((await client.verifyPaidCallback(notice.rawBody,headers,DEMO_ORDER)).paid).toBe(true);
    await expect(verifyDemoNotice({...notice,rawBody:notice.rawBody.replace('10.00','20.00')},now)).rejects.toThrow('签名不匹配');
    await expect(verifyDemoNotice(notice,now+301000)).rejects.toThrow('5 分钟');
    const changed=notice.rawBody.replace(DEMO_ORDER.merchantOrderId,'OTHER_ORDER');
    const signature='sha256='+createHmac('sha256',DEMO_KEY).update(`${notice.timestamp}\n${changed}`).digest('hex');
    await expect(verifyDemoNotice({...notice,rawBody:changed,signature},now)).rejects.toThrow('订单不一致');
  } finally { vi.unstubAllGlobals(); }
});

it('runs only locally and explains the verification result without any financial request', async () => {
  vi.stubGlobal('crypto', webcrypto); const fetchSpy=vi.fn(); vi.stubGlobal('fetch',fetchSpy);
  try {
    render(<BalanceIntegrationLab/>);
    fireEvent.click(screen.getByRole('button',{name:'生成模拟支付通知'}));
    fireEvent.click(await screen.findByRole('button',{name:'验证模拟签名和订单'}));
    expect(await screen.findByText(/模拟签名与订单匹配/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('模拟通知原始 JSON'),{target:{value:'{}'}});
    fireEvent.click(screen.getByRole('button',{name:'验证模拟签名和订单'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('签名不匹配');
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
