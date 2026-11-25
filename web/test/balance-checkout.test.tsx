import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { it,expect,vi } from 'vitest';
import { PortalContext } from '../src/portal/context';
import { MerchantBalanceCheckout } from '../src/pages/merchant-balance-checkout';
import { balanceCheckoutSession } from '../src/api/balance-payment';
import { merchantRequest } from '../src/api/merchant-console';

vi.mock('../src/api/balance-payment',()=>({balanceCheckoutSession:vi.fn()}));
vi.mock('../src/api/merchant-console',async original=>({...await original<typeof import('../src/api/merchant-console')>(),merchantRequest:vi.fn()}));
it('opens a read-only checkout and sends a debit only after explicit balance confirmation',async()=>{
 const session={merchantId:'main-1',csrfToken:'synthetic-csrf',canPay:true,order:{id:'payment-id',subject:'Synthetic product',receiverMerchantId:2,merchantOrigin:'https://shop.example',amountCents:1000,status:'pending',expiresAt:1_800_000_000_000,returnUrl:null},balance:{availableCents:20000,frozenCents:0,version:7}};
 vi.mocked(balanceCheckoutSession).mockResolvedValue(session);vi.mocked(merchantRequest).mockResolvedValue({order:{status:'paid'}});
 const merchant={merchantId:'main-1',epayMerchantId:1,name:'Synthetic payer',role:'owner' as const,feeBps:500,version:0};
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/balance-pay?orderId=payment-id&token=synthetic-checkout']}><PortalContext.Provider value={{mode:'merchant',merchants:[merchant],selected:merchant,enabled:true,isAdmin:false}}><MerchantBalanceCheckout/></PortalContext.Provider></MemoryRouter></QueryClientProvider>);
 const pay=await screen.findByRole('button',{name:'确认支付 ¥ 10.00'});
 expect(pay).toBeDisabled();expect(merchantRequest).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(pay);
 await waitFor(()=>expect(merchantRequest).toHaveBeenCalled());
 const body=vi.mocked(merchantRequest).mock.calls[0]![3]!.body;
 expect(body).toMatchObject({token:'synthetic-checkout',expectedAmountCents:1000,expectedBalanceVersion:7});
 expect(body).not.toHaveProperty('receiverMerchantId');
});
