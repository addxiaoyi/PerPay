import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { PortalContext } from '../src/portal/context';
import { MerchantTopups } from '../src/pages/merchant-topups';
import { MerchantBalanceCheckout } from '../src/pages/merchant-balance-checkout';
import { balanceCheckoutSession } from '../src/api/balance-payment';
import { merchantRequest } from '../src/api/merchant-console';
import { readBalanceResume } from '../src/lib/balance-resume';

vi.mock('../src/api/balance-payment',()=>({balanceCheckoutSession:vi.fn()}));
vi.mock('../src/api/merchant-console',async original=>({...await original<typeof import('../src/api/merchant-console')>(),merchantRequest:vi.fn()}));
const orderId='00000000-0000-4000-8000-000000000001',token='a'.repeat(32)+'.2.1800000000000.'+'b'.repeat(43);
const merchant={merchantId:'main-1',epayMerchantId:1,name:'Synthetic payer',role:'owner' as const,feeBps:500,version:0};
const checkout={merchantId:'main-1',csrfToken:'synthetic',canPay:false,order:{id:orderId,subject:'Original product',receiverMerchantId:2,merchantOrigin:'https://shop.example',amountCents:1000,status:'pending',expiresAt:1_900_000_000_000,returnUrl:null},balance:{availableCents:350,frozenCents:0,version:7}};
function wrap(page:React.ReactNode,path:string){return <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={[path]}><PortalContext.Provider value={{mode:'merchant',merchants:[merchant],selected:merchant,enabled:true,isAdmin:false}}>{page}</PortalContext.Provider></MemoryRouter></QueryClientProvider>;}

it('links an insufficient wallet to recharge with the same merchant, order and signed capability',async()=>{
 vi.mocked(balanceCheckoutSession).mockResolvedValue(checkout);
 render(wrap(<MerchantBalanceCheckout/>,`/balance-pay?orderId=${orderId}&token=${token}`));
 const link=await screen.findByRole('link',{name:'充值差额并返回订单'});
 const url=new URL(link.getAttribute('href')!,window.location.origin);
 expect(url.searchParams.get('merchantId')).toBe('main-1');expect(readBalanceResume(url.searchParams)).toEqual({orderId,token});
 expect(merchantRequest).not.toHaveBeenCalled();
});

it('prefills the verified shortfall, retains the original checkout and never pays automatically after recharge',async()=>{
 let funded=false;
 vi.mocked(balanceCheckoutSession).mockImplementation(async()=>funded?{...checkout,canPay:true,balance:{...checkout.balance,availableCents:1000}}:checkout);
 vi.mocked(merchantRequest).mockImplementation(async(path,_params,_signal,mutation)=>mutation?{checkoutUrl:'https://elsewhere.invalid/checkout',order:{amountCents:650,status:'pending_payment'}}:path==='topups'?{topups:[]}:{balance:{availableCents:funded?1000:350,frozenCents:0},channels:['alipay_web'],canRecharge:true,csrfToken:'synthetic'});
 render(wrap(<MerchantTopups merchantId='main-1'/>,`/topups?resumeOrderId=${orderId}&resumeToken=${token}`));
 await waitFor(()=>expect(screen.getByLabelText('充值金额（元）')).toHaveValue('6.50'));
 fireEvent.click(screen.getByRole('button',{name:'创建充值订单'}));
 await waitFor(()=>expect(vi.mocked(merchantRequest).mock.calls.find(call=>call[3])?.[3]?.body).toMatchObject({amount:'6.50',resume:{orderId,token}}));
 funded=true;fireEvent.click(screen.getByRole('button',{name:'刷新到账状态'}));
 expect(await screen.findByText('余额已足够，可返回原订单确认付款。')).toBeVisible();
 const url=new URL(screen.getByRole('link',{name:'返回原订单确认付款'}).getAttribute('href')!,window.location.origin);
 expect(url.searchParams.get('orderId')).toBe(orderId);expect(url.searchParams.get('merchantId')).toBe('main-1');
 expect(vi.mocked(merchantRequest).mock.calls.some(call=>call[0].includes('/pay'))).toBe(false);
});

it('rejects arbitrary or duplicate continuation URLs',()=>{
 expect(readBalanceResume(new URLSearchParams('resumeOrderId=https://evil.example&resumeToken=x'))).toBeNull();
 expect(readBalanceResume(new URLSearchParams(`resumeOrderId=${orderId}&resumeOrderId=${orderId}&resumeToken=${token}`))).toBeNull();
});
