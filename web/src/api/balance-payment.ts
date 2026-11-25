import { adminMountPath } from "../admin-base";
import { merchantSessionFetch } from "./merchant-session";
import { MerchantConsoleError } from "./merchant-console";

export type BalanceCheckout = { merchantId: string; csrfToken: string; canPay: boolean;
  order: { id: string; subject: string; receiverMerchantId: number; merchantOrigin: string; amountCents: number; status: string; expiresAt: number; returnUrl: string | null };
  balance: { availableCents: number; frozenCents: number; version: number } };
export async function balanceCheckoutSession(merchantId: string, orderId: string, token: string, signal?: AbortSignal): Promise<BalanceCheckout> {
  const response=await merchantSessionFetch(`${adminMountPath()}/api/merchant/epay/balance-payments/${encodeURIComponent(orderId)}/session?merchantId=${encodeURIComponent(merchantId)}`,
    { credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'x-checkout-token':token},...(signal?{signal}:{}) });
  const body=await response.json() as {ok?:boolean;data?:BalanceCheckout;code?:string};
  if(!response.ok||body.ok!==true||!body.data||body.data.merchantId!==merchantId) throw new MerchantConsoleError(response.status,body.code??'balance_checkout_unavailable');
  return body.data;
}
