import { adminMountPath } from '../admin-base';

export type BalanceResume = { orderId: string; token: string };
const ORDER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CHECKOUT_TOKEN = /^[a-f0-9]{32}\.[1-9]\d{0,15}\.[1-9]\d{0,15}\.[A-Za-z0-9_-]{43}$/;

export function readBalanceResume(search: URLSearchParams): BalanceResume | null {
  const orderIds = search.getAll('resumeOrderId'), tokens = search.getAll('resumeToken');
  if (orderIds.length !== 1 || tokens.length !== 1) return null;
  const orderId = orderIds[0]!, token = tokens[0]!;
  return ORDER_ID.test(orderId) && CHECKOUT_TOKEN.test(token) ? { orderId, token } : null;
}

export function rechargeForOrder(merchantId: string, resume: BalanceResume): string {
  const search = new URLSearchParams({ merchantId, resumeOrderId: resume.orderId, resumeToken: resume.token });
  return `${adminMountPath()}/merchant/topups?${search}`;
}

export function originalCheckout(merchantId: string, resume: BalanceResume): string {
  const search = new URLSearchParams({ merchantId, orderId: resume.orderId, token: resume.token });
  return `${adminMountPath()}/merchant/balance-pay?${search}`;
}

export function sameOriginCheckout(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === window.location.origin ? url.href : null;
  } catch { return null; }
}
