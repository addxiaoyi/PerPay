import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation,useQuery,useQueryClient } from "@tanstack/react-query";
import { usePortal } from "@/portal/context";
import { balanceCheckoutSession } from "@/api/balance-payment";
import { merchantRequest,centsText,MerchantConsoleError } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { rechargeForOrder } from '@/lib/balance-resume';

type PayCommand={requestId:string;token:string;expectedAmountCents:number;expectedBalanceVersion:number};
export function MerchantBalanceCheckout(){
  const {selected}=usePortal(),[search]=useSearchParams(),orderId=search.get('orderId')??'',token=search.get('token')??'';
  const [confirmed,setConfirmed]=useState(false),[pending,setPending]=useState<PayCommand|null>(null),client=useQueryClient();
  const session=useQuery({queryKey:['merchant-console',selected.merchantId,'balance-checkout',orderId,token],
    queryFn:({signal})=>balanceCheckoutSession(selected.merchantId,orderId,token,signal),retry:false,refetchOnMount:'always'});
  const pay=useMutation({retry:false,mutationFn:async(command:PayCommand)=>{
    const current=await balanceCheckoutSession(selected.merchantId,orderId,token);
    return merchantRequest(`balance-payments/${encodeURIComponent(orderId)}/pay`,{merchantId:selected.merchantId},undefined,{token:current.csrfToken,body:command});
  },onSuccess:()=>{setPending(null);setConfirmed(false);},onError:error=>{
    if(error instanceof MerchantConsoleError&&[400,401,403,404,409].includes(error.status))setPending(null);
  },onSettled:async()=>{await client.invalidateQueries({queryKey:['merchant-console',selected.merchantId,'balance-checkout']});}});
  function confirmPayment(){
    if(!session.data||!confirmed)return;
    const command=pending??{requestId:crypto.randomUUID(),token,expectedAmountCents:session.data.order.amountCents,expectedBalanceVersion:session.data.balance.version};
    setPending(command);pay.mutate(command);
  }
  return <section className="mx-auto max-w-xl space-y-5" aria-label="商户余额收银台"><h2 className="text-xl font-semibold">使用商户余额付款</h2>
    <ConsoleQuery query={session}>{state=><>
      <div className="space-y-3 rounded-lg border p-5"><p className="break-all font-medium">{state.order.subject}</p><p className="break-all text-sm text-muted-foreground">收款网站：{state.order.merchantOrigin}</p>
        <p className="text-2xl font-semibold tabular-nums">¥ {centsText(state.order.amountCents)}</p>
        <dl className="space-y-2 text-sm"><div><dt className="text-muted-foreground">付款商户</dt><dd>{selected.name}</dd></div><div><dt className="text-muted-foreground">可用余额</dt><dd>¥ {centsText(state.balance.availableCents)}</dd></div></dl>
      </div>
      {state.order.status==='pending'&&<>
        {state.order.receiverMerchantId!==selected.epayMerchantId&&state.balance.availableCents<state.order.amountCents&&<div className="space-y-2 rounded-lg border p-4">
          <p role="status" className="text-sm">还差 ¥ {centsText(state.order.amountCents-state.balance.availableCents)}。充值到账后可返回本订单继续付款。</p>
          <a className="inline-flex min-h-11 items-center font-medium underline" href={rechargeForOrder(selected.merchantId,{orderId,token})}>充值差额并返回订单</a>
          <p className="text-xs text-muted-foreground">原订单有效期 20 分钟；充值不会延长有效期，也不会自动支付原订单。</p>
        </div>}
        {!state.canPay&&<p role="status" className="text-sm">当前账户暂不能付款。请检查余额、订单期限及付款商户；不能向自己付款。</p>}
        <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={!state.canPay||pay.isPending}/>确认从上述商户可用余额扣款。</label>
        <Button className="min-h-11 w-full" onClick={confirmPayment} disabled={!confirmed||!state.canPay||pay.isPending}>{pay.isPending?'正在确认付款…':pending?'核对原付款请求':`确认支付 ¥ ${centsText(state.order.amountCents)}`}</Button>
      </>}
      {state.order.status!=='pending'&&<p role="status">{state.order.status==='paid'?'该订单已支付，请返回商户网站查看结果。':state.order.status==='refunded'?'该订单已原路退回余额。':'订单已过期，请从原网站重新获取支付链接。'}</p>}
      {state.order.returnUrl&&<a className="inline-flex min-h-11 items-center text-sm underline" href={state.order.returnUrl} rel="noreferrer">返回商户网站</a>}
    </>}</ConsoleQuery>
    {pay.isError&&<p role="alert" className="text-sm text-destructive">{pay.error.message}</p>}
    <p className="text-sm leading-6 text-muted-foreground">其他网站只能创建收款订单；扣款需你在本站确认。不要仅凭返回页面判断是否付款，收款网站会核对签名回调和订单状态。</p>
  </section>;
}
