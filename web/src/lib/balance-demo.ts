export const DEMO_KEY = 'starpay-local-demo-key-not-a-merchant-secret';
export const DEMO_ORDER = { paymentOrderId: '00000000-0000-4000-8000-000000000001', merchantOrderId: 'DEMO_ORDER_001', amount: '10.00', amountCents: 1000 };
export type DemoNotice = { rawBody: string; timestamp: string; signature: string; callbackId: string };

async function demoSignature(rawBody: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(DEMO_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${rawBody}`));
  return 'sha256=' + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createDemoNotice(now = Date.now()): Promise<DemoNotice> {
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = JSON.stringify({ event: 'payment.paid', type: 'balance', orderId: DEMO_ORDER.paymentOrderId,
    merchantOrderId: DEMO_ORDER.merchantOrderId, amount: DEMO_ORDER.amount, platformFee: '0.10', merchantNet: '9.90',
    tradeNo: 'DEMO_PROVIDER_TRADE', paidAt: new Date(now).toISOString() });
  return { rawBody, timestamp, signature: await demoSignature(rawBody, timestamp), callbackId: 'DEMO_CALLBACK_001' };
}

export async function verifyDemoNotice(notice: DemoNotice, now = Date.now()): Promise<string> {
  if (notice.rawBody.length > 8192) throw new Error('报文超过 8 KB，请使用本页生成的模拟报文。');
  if (!/^\d{10,11}$/.test(notice.timestamp) || Math.abs(Math.floor(now / 1000) - Number(notice.timestamp)) > 300) throw new Error('时间戳无效或已超过 5 分钟，请重新生成模拟报文。');
  if (!/^sha256=[a-f0-9]{64}$/.test(notice.signature) || !notice.callbackId) throw new Error('签名格式或通知 ID 无效。');
  if (notice.signature !== await demoSignature(notice.rawBody, notice.timestamp)) throw new Error('签名不匹配：原始报文、时间戳或签名已变化。');
  let event: Record<string, unknown>;
  try { event = JSON.parse(notice.rawBody) as Record<string, unknown>; }
  catch { throw new Error('签名报文不是有效 JSON。'); }
  if (!event || event.event !== 'payment.paid' || event.type !== 'balance' || event.orderId !== DEMO_ORDER.paymentOrderId || event.merchantOrderId !== DEMO_ORDER.merchantOrderId || event.amount !== DEMO_ORDER.amount) throw new Error('报文与预期模拟订单不一致。');
  return '模拟签名与订单匹配。正式接入还需由服务器查询订单状态，并在数据库中防止重复发货。';
}
