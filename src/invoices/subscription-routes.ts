import { Hono } from "hono";
import { ZodError } from "zod";
import { MerchantAccessError } from "../epay-compat/merchant-access.ts";
import { merchantMutationAuth } from "../epay-compat/merchant-mutation-auth.ts";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { BalanceConflict, InsufficientBalance, BalanceUnavailable } from "../epay-compat/live-balance.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { verifiedAuthorization, InvoiceError } from "./model.ts";
import { createFeeInvoiceService } from "./fee-service.ts";
import { purchaseInvoiceSubscription, subscriptionSession, invoiceSubscriptionInput } from "./subscription.ts";
import type { InvoiceRouteOptions } from "./routes.ts";
import { FaPiaoError } from "./fa-piao-client.ts";

export function createInvoiceSubscriptionRoutes(options: InvoiceRouteOptions) {
  const app = new Hono(), auth = merchantMutationAuth(options, "invoice-subscription"), clock = options.clock ?? Date.now;
  const service = options.provider ? createFeeInvoiceService({ ...options, provider: options.provider, canIssue: () => options.enabled }) : null;
  app.use('*',async(context,next)=>{context.header('Cache-Control','no-store');await next();});
  app.onError((error,context)=>{
    if(error instanceof MerchantAccessError) return context.json({ok:false,code:error.code,error:'请检查商户权限和登录状态。'},error.code==='unauthenticated'?401:error.code==='unavailable'?503:403);
    if(error instanceof InsufficientBalance) return context.json({ok:false,code:'insufficient_balance',error:'开票年费需要100元商户可用余额。'},409);
    if(error instanceof BalanceConflict) return context.json({ok:false,code:'subscription_conflict',error:'余额或服务期限已变化，请刷新后核对。'},409);
    if(error instanceof BalanceUnavailable) return context.json({ok:false,code:'balance_unavailable',error:'余额账务尚未就绪，暂不能扣费。'},503);
    if(error instanceof InvoiceError) return context.json({ok:false,code:error.code,error:error.message},error.status);
    if(error instanceof ZodError) return context.json({ok:false,code:'subscription_invalid',error:'请核对年费购买请求。'},400);
    console.error('invoice subscription route failed',{errorType:error.name});return context.json({ok:false,code:'subscription_unavailable',error:'结果暂未确认，请使用原请求核对。'},503);
  });
  app.get('/',async context=>{
    const {access,cookie}=await auth.authenticate(context.req.raw,false),session=subscriptionSession(options.database,access,clock());
    const configured=Boolean(options.provider?.platformFees&&options.provider.platformFees.validUntil>clock());
    const canPurchase=options.enabled&&access.role!=='member'&&configured;
    return context.json({ok:true,data:{merchantId:access.merchantId,...session,canPurchase,issuanceEnabled:Boolean(service?.enabled()),csrfToken:access.role!=='member'?auth.issue(cookie,access):null}});
  });
  app.post('/',async context=>{
    if(!/^application\/json(?:;|$)/i.test(context.req.header('content-type')??'')) throw new InvoiceError('invoice_invalid',400,'expected JSON');
    const input=invoiceSubscriptionInput.parse(parseStrictJson(await readBoundedBody(context.req.raw.body,8192)));
    const {access}=await auth.authenticate(context.req.raw,true);
    if(access.role==='member') throw new MerchantAccessError('forbidden');
    const prior=options.database.read(sql=>sql.prepare('SELECT 1 FROM epay_invoice_subscription_receipts WHERE merchant_id=? AND request_id=?').get(access.epayMerchantId,input.requestId));
    if(prior) return context.json({ok:true,data:{merchantId:access.merchantId,...purchaseInvoiceSubscription(options.database,access,input,clock())}});
    if(!options.enabled||!options.provider?.platformFees||options.provider.platformFees.validUntil<=clock())throw new InvoiceError('invoice_disabled',503,'年服务暂未开放购买。');
    if(!service?.enabled()&&!input.acknowledgePendingIssuance)throw new InvoiceError('invoice_preopen_confirmation_required',409,'当前实开尚未启用，请先确认预开通说明。');
    if(service?.enabled()){
      if(!options.provider.checkStatus)throw new InvoiceError('invoice_provider_unavailable',503,'暂不能核实开票授权，未扣款。');
      let status;
      try { status=await options.provider.checkStatus(options.provider.platformFees.profile); }
      catch(error){ throw new InvoiceError(error instanceof FaPiaoError?error.code:'invoice_provider_unavailable',503,'平台开票服务未就绪，未扣除年费。'); }
      if(!verifiedAuthorization(options.provider.platformFees.profile,status)) throw new InvoiceError('invoice_not_authorized',503,'平台开票授权未就绪，未扣除年费。');
    }
    const refreshed=await auth.authenticate(context.req.raw,true);
    if(refreshed.access.userId!==access.userId)throw new MerchantAccessError('forbidden');
    if(!service?.enabled()&&!input.acknowledgePendingIssuance)throw new InvoiceError('invoice_preopen_confirmation_required',409,'实开状态已变化，请重新确认预开通说明。');
    return context.json({ok:true,data:{merchantId:access.merchantId,...purchaseInvoiceSubscription(options.database,refreshed.access,input,clock())}});
  });
  return app;
}
