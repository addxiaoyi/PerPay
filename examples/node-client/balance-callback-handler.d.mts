import type { StarPayBalanceClient } from './balance-payment.mjs';
export interface SavedPayment { id:string;paymentOrderId:string;merchantOrderId:string;amount:string;amountCents:number;keyVersion?:number; }
export function balanceCallbackHandler(options: {
  clientForOrder:(order:SavedPayment)=>StarPayBalanceClient|Promise<StarPayBalanceClient>;
  orders:{findByMerchantOrderId:(id:string)=>Promise<SavedPayment|null>;confirmPaymentOnce:(notice:{orderId:string;paymentOrderId:string;callbackId:string})=>Promise<void>};
  logError?:(message:string,details:{errorType?:string})=>void;
}):(request:Request)=>Promise<Response>;
