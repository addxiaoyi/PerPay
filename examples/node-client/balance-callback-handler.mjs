// Inject your own durable order repository. No database credentials belong in this file.
export function balanceCallbackHandler({ clientForOrder, orders, logError = console.error }) {
  return async function receiveNotice(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return new Response('expected JSON', { status: 415 });
    const chunks = []; let bytes = 0;
    const reader = request.body?.getReader();
    if (!reader) return new Response('empty notification', { status: 400 });
    let rawBody;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8192) return new Response('notification too large', { status: 413 });
        chunks.push(chunk.value);
      }
      rawBody = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch { return new Response('invalid notification', { status: 400 }); }
    finally { try { await reader.cancel(); } catch (error) { logError('StarPAY notification stream cancellation failed', {errorType:error?.name}); } reader.releaseLock(); }
    let event;
    try { event = JSON.parse(rawBody); }
    catch { return new Response('invalid JSON', { status: 400 }); }
    if (!event || typeof event.merchantOrderId !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(event.merchantOrderId)) return new Response('invalid order reference', { status: 400 });
    try {
      // An unverified order number is a lookup hint, never evidence of payment.
      const saved = await orders.findByMerchantOrderId(event.merchantOrderId);
      if (!saved) return new Response('unknown order', { status: 404 });
      const client = await clientForOrder(saved);
      const notice = await client.verifyPaidCallback(rawBody, request.headers, {
        paymentOrderId: saved.paymentOrderId, merchantOrderId: saved.merchantOrderId, amount: saved.amount, amountCents: saved.amountCents,
      });
      if (!notice.paid) return new Response('not currently paid', { status: 409 });
      // This method must atomically deduplicate callback/order IDs and enqueue fulfillment once.
      await orders.confirmPaymentOnce({ orderId: saved.id, paymentOrderId: saved.paymentOrderId, callbackId: notice.callbackId });
      return Response.json({ ok: true });
    } catch (error) {
      logError('StarPAY callback verification or processing failed', { errorType: error?.name });
      return new Response('notification not accepted', { status: 503 });
    }
  };
}
