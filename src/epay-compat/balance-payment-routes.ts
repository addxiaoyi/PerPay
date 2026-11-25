import { Hono } from "hono";
import { z, ZodError } from "zod";
import { parseStrictJson } from "../http/strict-json.ts";
import { authenticateMainOrder, readBoundedBody } from "./main-order-auth.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { BalanceConflict, InsufficientBalance, BalanceUnavailable } from "./live-balance.ts";
import { createBalancePayments, BalancePaymentError, balanceOrderInput } from "./balance-payment.ts";
import type { AppDatabase } from "../database/database.ts";
import { createHmac,timingSafeEqual } from "node:crypto";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { PublicCheckoutRateLimiter } from "../http/public-checkout-rate-limit.ts";
import { InvoiceError } from "../invoices/model.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase,"read"|"write"|"instanceId">; enabled: () => boolean; basePath: string; bridgeSecret?: string | undefined; send?: typeof fetch };
const queryInput = z.object({ operation: z.literal("starpay.balance.query.v1"), orderId: z.uuid() }).strict();
const createInput = z.object({ operation: z.literal("starpay.balance.create.v1"), order: balanceOrderInput }).strict();
const refundInput = z.object({ operation: z.literal("starpay.balance.refund.v1"), orderId: z.uuid(), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/) }).strict();
async function jsonBody(request: Request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new BalancePaymentError("balance_body_invalid",400,"expected JSON");
  try { return parseStrictJson(await readBoundedBody(request.body,8192)); }
  catch { throw new BalancePaymentError('balance_body_invalid',400,'invalid JSON body'); }
}
function errors(app: Hono) {
  app.use("*",async(context,next)=>{context.header("Cache-Control","no-store");context.header("Referrer-Policy","no-referrer");await next();});
  app.onError((error,context)=>{
    if(error instanceof MerchantAccessError) return context.json({ok:false,code:error.code,error:"请检查登录状态和商户权限。"},error.code==="unauthenticated"?401:error.code==="unavailable"?503:403);
    if(error instanceof InvoiceError) return context.json({ok:false,code:error.code,error:'当前账户没有该商户的付款权限。'},error.status);
    if(error instanceof BalancePaymentError) { if(error.code==='balance_rate_limited')context.header('Retry-After','1'); return context.json({ok:false,code:error.code,error:error.message},error.status); }
    if(error instanceof BalanceConflict) return context.json({ok:false,code:"balance_conflict",error:"订单或余额已变化，请刷新后核对。"},409);
    if(error instanceof InsufficientBalance) return context.json({ok:false,code:"insufficient_balance",error:"商户可用余额不足。"},409);
    if(error instanceof BalanceUnavailable) return context.json({ok:false,code:"balance_unavailable",error:"余额账务尚未就绪，暂不能支付。"},503);
    if(error instanceof ZodError) return context.json({ok:false,code:"balance_invalid",error:"请核对订单、金额和支付参数。"},400);
    console.error("balance payment route failed",{path:context.req.path,errorType:error.name});
    return context.json({ok:false,code:"balance_payment_unavailable",error:"支付结果暂未确认，请查询原订单。"},503);
  });
}
export function createBalanceMerchantApi(options: Options) {
  const app=new Hono(),payments=createBalancePayments(options),limiter=new PublicCheckoutRateLimiter({sourceBurst:30,sourceRequestsPerSecond:3}); errors(app);
  async function identity(request:Request) {
    if(!options.enabled()) throw new BalancePaymentError("balance_payment_disabled",503,"余额支付暂未开放。");
    const local=request.headers.has('x-starpay-pid');
    if(!local&&!request.headers.has("x-lightpay-signature")) throw new MerchantAccessError("unauthenticated");
    const timestamp=request.headers.get(local?'x-starpay-timestamp':"x-lightpay-timestamp")??"";
    if(!/^\d{10,11}$/.test(timestamp)) throw new MerchantAccessError("unauthenticated");
    const bytes=await readBoundedBody(request.body,8192),raw=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    if(!/^application\/json(?:;|$)/i.test(request.headers.get("content-type")??"")) throw new BalancePaymentError("balance_body_invalid",400,"expected JSON");
    const input=parseStrictJson(bytes);
    if(Math.abs(Math.floor((options.clock??Date.now)()/1000)-Number(timestamp))>300)throw new MerchantAccessError('unauthenticated');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new BalancePaymentError('balance_body_invalid',400,'expected a JSON object');
    if(local){
      const pid=request.headers.get('x-starpay-pid')??'',signed=request.headers.get('x-starpay-signature')??'';
      if(!/^[1-9]\d{0,14}$/.test(pid)||!/^sha256=[a-f0-9]{64}$/.test(signed))throw new MerchantAccessError('unauthenticated');
      const access=options.database.read(sql=>{
        const row=sql.prepare(`SELECT b.main_merchant_id,b.main_api_id FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1 WHERE b.epay_merchant_id=?`).get(Number(pid));
        if(!row)throw new MerchantAccessError('forbidden');
        const secret=readMerchantSecret(sql,new RuntimeSecretCipher(options.masterKey,options.database.instanceId()),Number(pid));
        const expected=createHmac('sha256',secret).update(`${timestamp}\n${raw}`).digest();
        if(!timingSafeEqual(expected,Buffer.from(signed.slice(7),'hex')))throw new MerchantAccessError('unauthenticated');
        const parsed=input as {order?:{notifyUrl?:unknown};orderId?:unknown};
        const contract=typeof parsed.orderId==='string'?sql.prepare(`SELECT o.notify_url FROM epay_balance_orders b JOIN epay_orders o ON o.trade_no=b.trade_no WHERE b.order_id=? AND b.merchant_id=?`).get(parsed.orderId,Number(pid)):null;
        const callbackUrl=typeof parsed.order?.notifyUrl==='string'?parsed.order.notifyUrl:contract?String(contract.notify_url):'';
        return {merchantId:String(row.main_merchant_id),apiId:String(row.main_api_id),epayMerchantId:Number(pid),callbackSecret:secret,callbackUrl};
      });
      if(!limiter.take(String(access.epayMerchantId)))throw new BalancePaymentError('balance_rate_limited',429,'requests are too frequent; retry the original order');
      return {access,input};
    }
    const access=await authenticateMainOrder(options,request,raw);
    if(!limiter.take(String(access.epayMerchantId)))throw new BalancePaymentError('balance_rate_limited',429,'requests are too frequent; retry the original order');
    return { access, input };
  }
  app.post('/orders',async context=>{
    const {access,input}=await identity(context.req.raw),command=createInput.parse(input),created=payments.create(access,command.order);
    const root=options.basePath==='/'?'':options.basePath;
    return context.json({ok:true,data:{merchantId:access.merchantId,...created,checkoutUrl:`${options.publicOrigin}${root}/merchant/balance-pay?orderId=${created.order.id}&token=${encodeURIComponent(created.token)}`}},created.duplicate?200:201);
  });
  app.post('/query',async context=>{const {access,input}=await identity(context.req.raw),command=queryInput.parse(input);return context.json({ok:true,data:{merchantId:access.merchantId,order:payments.read(access,command.orderId)}});});
  app.post('/refund',async context=>{
    const {access,input}=await identity(context.req.raw),command=refundInput.parse(input);
    return context.json({ok:true,data:{merchantId:access.merchantId,...payments.refund({merchantId:access.merchantId,mainApiId:access.apiId,epayMerchantId:access.epayMerchantId,userId:`api:${access.apiId}`,role:'owner'},command.orderId,command.requestId)}});
  });
  return app;
}
export function createBalancePayerRoutes(options: Omit<Options,'basePath'>) {
  const app=new Hono(),auth=merchantMutationAuth(options,'balance-payment'),payments=createBalancePayments(options);errors(app);
  app.get('/:id/session',async context=>{
    const {access,cookie}=await auth.authenticate(context.req.raw,false),session=payments.inspect(access,context.req.param('id'),context.req.header('x-checkout-token')??'');
    return context.json({ok:true,data:{merchantId:access.merchantId,...session,csrfToken:auth.issue(cookie,access)}});
  });
  app.post('/:id/pay',async context=>{
    const input=await jsonBody(context.req.raw);
    const {access}=await auth.authenticate(context.req.raw,true);
    return context.json({ok:true,data:{merchantId:access.merchantId,...payments.pay(access,context.req.param('id'),input)}});
  });
  return app;
}
