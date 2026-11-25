export interface BalanceOrder {
  id:string;merchantOrderId:string;receiverMerchantId:number;amountCents:number;feeCents:number;tradeNo:string;
  status:'pending'|'paid'|'refunded'|'expired';paidAt:number|null;refundedAt:number|null;
}
export interface BalanceClientOptions {
  baseUrl:string;merchantId?:string;apiId?:string;apiSecret?:string;pid?:string|number;key?:string;notifyUrl?:string;
  send?:typeof fetch;clock?:()=>number;callbackKey?:string;
}
export class StarPayBalanceClient {
  constructor(options:BalanceClientOptions);
  create(input:{merchantOrderId:string;amount:string;subject:string;returnUrl?:string}):Promise<{order:BalanceOrder;token:string;checkoutUrl:string;duplicate:boolean}>;
  query(orderId:string):Promise<{order:BalanceOrder}>;
  refund(orderId:string,requestId?:string):Promise<{order:BalanceOrder;duplicate:boolean}>;
  verifyPaidCallback(rawBody:string,headers:Headers,expected:{paymentOrderId:string;merchantOrderId:string;amount:string;amountCents:number}):Promise<{callbackId:string;paid:boolean;order:BalanceOrder}>;
}
