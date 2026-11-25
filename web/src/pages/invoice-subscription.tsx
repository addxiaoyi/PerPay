import { useState } from "react";
import { useMutation,useQuery,useQueryClient } from "@tanstack/react-query";
import { merchantRequest,centsText,dateText,MerchantConsoleError } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type Session={subscription:{active:boolean;validUntil:number;priceCents:number;durationDays:number};balance:{availableCents:number;version:number};canPurchase:boolean;issuanceEnabled?:boolean;csrfToken:string|null};
type Command={requestId:string;expectedBalanceVersion:number;expectedValidUntil:number;acknowledgePendingIssuance:boolean};
export function InvoiceSubscription({merchantId}:{merchantId:string}){
  const [confirmed,setConfirmed]=useState(false),[pending,setPending]=useState<Command|null>(null),client=useQueryClient();
  const session=useQuery({queryKey:['merchant-console',merchantId,'invoice-subscription'],queryFn:({signal})=>merchantRequest<Session>('fee-invoices/subscription',{merchantId},signal),retry:false});
  const buy=useMutation({retry:false,mutationFn:async(command:Command)=>{
    const current=await merchantRequest<Session>('fee-invoices/subscription',{merchantId});
    if(!current.csrfToken||(!current.canPurchase&&!pending))throw new MerchantConsoleError(403,'invoice_disabled');
    return merchantRequest('fee-invoices/subscription',{merchantId},undefined,{token:current.csrfToken,body:command});
  },onSuccess:()=>{setPending(null);setConfirmed(false);},onError:error=>{if(error instanceof MerchantConsoleError&&[400,401,403,409].includes(error.status))setPending(null);},
    onSettled:async()=>{await client.invalidateQueries({queryKey:['merchant-console',merchantId]});}});
  function purchase(){if(!session.data||!confirmed)return;const command=pending??{requestId:crypto.randomUUID(),expectedBalanceVersion:session.data.balance.version,expectedValidUntil:session.data.subscription.validUntil,acknowledgePendingIssuance:session.data.issuanceEnabled!==true};setPending(command);buy.mutate(command);}
  return <div className="space-y-3 rounded-md border p-4"><h4 className="font-medium">开票年服务 · 100 元/年</h4>
    <ConsoleQuery query={session}>{state=><>
      <p className="text-sm">{state.subscription.active?`服务有效至 ${dateText(state.subscription.validUntil)}`:'尚未开通年服务。'} 每次开通或续费延长 {state.subscription.durationDays} 天，不自动续费。</p>
      <p className="text-sm text-muted-foreground">可用余额：¥ {centsText(state.balance.availableCents)}。年费直接扣除 ¥ {centsText(state.subscription.priceCents)}，不会转为可用余额。</p>
      {!state.canPurchase&&<p role="status" className="text-sm">当前账户无购买权限或年服务未开放，请联系平台管理员。</p>}
      {state.canPurchase&&state.issuanceEnabled!==true&&<p role="status" className="text-sm">当前真实开票尚未启用，可先购买服务资格。365 天从此次购买时计起；发票需等待平台开启后才会处理。</p>}
      <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={!state.canPurchase||buy.isPending}/>{state.issuanceEnabled===true?'确认从本商户可用余额扣除 100 元年费。':'我已了解预开通和计期说明，确认从商户余额扣除 100 元。'}</label>
      <Button className="min-h-11" onClick={purchase} disabled={!confirmed||(!state.canPurchase&&!pending)||buy.isPending||(!pending&&state.balance.availableCents<state.subscription.priceCents)}>{buy.isPending?'正在核对开通结果…':pending?'核对原年费请求':state.subscription.active?'续费一年（扣余额100元）':'开通一年（扣余额100元）'}</Button>
    </>}</ConsoleQuery>
    {buy.isError&&<p role="alert" className="text-sm text-destructive">{buy.error.message}</p>}
    {buy.isSuccess&&<p role="status" className="text-sm">年费已记入余额流水，服务期限已更新。</p>}
  </div>;
}
