import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { it,expect,vi } from 'vitest';
import { InvoiceSubscription } from '../src/pages/invoice-subscription';
import { merchantRequest } from '../src/api/merchant-console';
vi.mock('../src/api/merchant-console',async original=>({...await original<typeof import('../src/api/merchant-console')>(),merchantRequest:vi.fn()}));
it('shows the fixed annual price and only purchases after merchant debit confirmation',async()=>{
 const session={subscription:{active:false,validUntil:0,priceCents:10000,durationDays:365},balance:{availableCents:20000,version:4},canPurchase:true,csrfToken:'synthetic-csrf'};
 vi.mocked(merchantRequest).mockImplementation(async(_path,_params,_signal,mutation)=>mutation?{receiptId:'synthetic-receipt'}:session);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><InvoiceSubscription merchantId='main-1'/></QueryClientProvider>);
 const buy=await screen.findByRole('button',{name:'开通一年（扣余额100元）'});
 expect(buy).toBeDisabled();expect(vi.mocked(merchantRequest).mock.calls.some(call=>call[3])).toBe(false);
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(buy);
 await waitFor(()=>expect(vi.mocked(merchantRequest).mock.calls.some(call=>call[3])).toBe(true));
 expect(vi.mocked(merchantRequest).mock.calls.find(call=>call[3])![3]!.body).toMatchObject({expectedBalanceVersion:4,expectedValidUntil:0,acknowledgePendingIssuance:true});
 expect(vi.mocked(merchantRequest).mock.calls.find(call=>call[3])![3]!.body).not.toHaveProperty('priceCents');
});
