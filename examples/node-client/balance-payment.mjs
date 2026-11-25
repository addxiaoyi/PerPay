import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class StarPayBalanceClient {
  #secret;
  #callbackKey;
  constructor({baseUrl,merchantId,apiId,apiSecret,pid,key,callbackKey,notifyUrl='',send=fetch,clock=Date.now}){
    const url=new URL(baseUrl);
    const hasCredentials=Boolean(pid&&key)||Boolean(merchantId&&apiId&&apiSecret);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!hasCredentials)throw new Error('invalid StarPAY balance client configuration');
    this.baseUrl=url.href.replace(/\/$/,'');this.merchantId=merchantId;this.apiId=apiId;this.pid=pid;this.notifyUrl=notifyUrl;this.#secret=key??apiSecret;this.#callbackKey=callbackKey??this.#secret;this.send=send;this.clock=clock;
  }
  async request(path,input){
    const body=JSON.stringify(input),timestamp=String(Math.floor(this.clock()/1000));
    const signature=createHmac('sha256',this.#secret).update(`${timestamp}\n${body}`).digest('hex');
    const response=await this.send(`${this.baseUrl}/epay/balance/${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{'content-type':'application/json',...(this.pid?{'x-starpay-pid':String(this.pid),'x-starpay-timestamp':timestamp,'x-starpay-signature':`sha256=${signature}`}:
        {'x-merchant-id':this.merchantId,'x-lightpay-api-id':this.apiId,'x-lightpay-timestamp':timestamp,'x-lightpay-signature':`sha256=${signature}`})},body});
    const reply=await response.json();
    if(!response.ok||reply.ok!==true||(this.pid?reply.data?.order?.receiverMerchantId!==Number(this.pid):reply.data?.merchantId!==this.merchantId))throw new Error(`StarPAY balance request failed: ${reply.code??response.status}`);
    return reply.data;
  }
  create({merchantOrderId,amount,subject,returnUrl=''}){return this.request('orders',{operation:'starpay.balance.create.v1',order:{merchantOrderId,amount,subject,notifyUrl:this.notifyUrl,returnUrl}});}
  query(orderId){return this.request('query',{operation:'starpay.balance.query.v1',orderId});}
  refund(orderId,requestId=randomUUID()){return this.request('refund',{operation:'starpay.balance.refund.v1',orderId,requestId});}
  async verifyPaidCallback(rawBody,headers,expected){
    const timestamp=headers.get('x-lightpay-timestamp')??'',signature=headers.get('x-lightpay-signature')??'',callbackId=headers.get('x-idempotency-key')??'';
    if(!/^\d{10,11}$/.test(timestamp)||Math.abs(Math.floor(this.clock()/1000)-Number(timestamp))>300||!/^sha256=[a-f0-9]{64}$/.test(signature)||!callbackId)throw new Error('invalid callback signature headers');
    const digest=createHmac('sha256',this.#callbackKey).update(`${timestamp}\n${rawBody}`).digest('hex');
    if(!timingSafeEqual(Buffer.from(signature.slice(7),'hex'),Buffer.from(digest,'hex')))throw new Error('callback signature mismatch');
    const event=JSON.parse(rawBody);
    if(event.event!=='payment.paid'||event.type!=='balance'||event.orderId!==expected.paymentOrderId||event.merchantOrderId!==expected.merchantOrderId||event.amount!==expected.amount)throw new Error('callback differs from saved order');
    const {order}=await this.query(expected.paymentOrderId);
    if(order.merchantOrderId!==expected.merchantOrderId||order.amountCents!==expected.amountCents)throw new Error('queried payment differs from saved order');
    return {callbackId,paid:order.status==='paid',order};
  }
}
