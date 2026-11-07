import QRCode from "qrcode";
import { createHash } from "node:crypto";

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f5f7f8;color:#18252a;font:16px system-ui,sans-serif}main{width:min(100% - 32px,440px);margin:8vh auto;background:#fff;border:1px solid #dce4e4;border-radius:8px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 24px}h2{font-size:16px;font-weight:500;overflow-wrap:anywhere;margin:0 0 12px}.amount{font-size:32px;font-weight:700;margin:0 0 20px}.qr{display:block;width:min(280px,100%);height:auto;margin:auto}p{color:#596a6a;line-height:1.5}small{color:#687777;line-height:1.5}`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
const SCRIPT = `(()=>{const token=document.querySelector('meta[name="checkout-token"]').content;const state=document.getElementById('payment-state');let running=false;const poll=async()=>{if(running)return;running=true;try{const response=await fetch(new URL('checkout-status',location.href),{headers:{'x-checkout-token':token},cache:'no-store',credentials:'omit'});if(!response.ok)throw new Error('status unavailable');const data=await response.json();if(data.status==='paid'){state.textContent='付款已确认';clearInterval(timer);if(typeof data.returnUrl==='string'){const target=new URL(data.returnUrl);if(target.protocol==='https:')location.replace(target.href)}else if(data.returnAvailable===false)state.textContent='付款已确认，请返回商户查看订单'}else if(data.status==='unavailable'){state.textContent='暂时无法确认付款状态，请联系商户';clearInterval(timer)}}catch{state.textContent='正在重新确认付款状态，请勿重复付款'}finally{running=false}};const timer=setInterval(poll,3000);poll()})();`;
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function checkoutNotice(title: string, message: string, status: number, order?: { name: string; amountCents: number }): Response {
  const details = order ? `<h2>${escapeHtml(order.name)}</h2><div class="amount">¥ ${(order.amountCents / 100).toFixed(2)}</div>` : "";
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · StarPAY</title><style>${STYLE}</style></head><body><main><small>StarPAY 收银台</small><h1>${escapeHtml(title)}</h1>${details}<p role="status">${escapeHtml(message)}</p></main></body></html>`, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } });
}

export function paymentWaitingPage(token: string, statusPath: string): Response {
  if (!/^[a-f0-9]{32}\.[1-9]\d{0,15}\.[1-9]\d{0,15}\.[A-Za-z0-9_-]{43}$/.test(token) || !/^\/[A-Za-z0-9/_-]+$/.test(statusPath)) throw new Error("invalid payment status capability");
  const script = SCRIPT.replace("new URL('checkout-status',location.href)", `new URL(${JSON.stringify(statusPath)},location.origin)`);
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="checkout-token" content="${token}"><title>支付结果 · StarPAY</title><style>${STYLE}</style></head><body><main><small>StarPAY 收银台</small><h1>支付结果</h1><p>正在向支付渠道确认订单，请勿重复付款。</p><small id="payment-state" aria-live="polite">等待付款确认</small></main><script>${script}</script></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; script-src 'sha256-${scriptHash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
}

// QR data is embedded locally; never send a payment URL to a QR image service.
export async function isolatedCheckout(code: string, name: string, amountCents: number, token: string, statusPath?: string): Promise<Response> {
  if (!code || code.length > 1024 || /[\x00-\x20\x7f]/.test(code) || !name || name.length > 127 || !Number.isSafeInteger(amountCents) || amountCents < 1 || !/^[a-f0-9]{32}\.[1-9]\d{0,15}\.[1-9]\d{0,15}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid checkout details");
  if (statusPath !== undefined && !/^\/[A-Za-z0-9/_-]+$/.test(statusPath)) throw new Error("invalid checkout status path");
  const script = statusPath ? SCRIPT.replace("new URL('checkout-status',location.href)", `new URL(${JSON.stringify(statusPath)},location.origin)`) : SCRIPT;
  const scriptHash = statusPath ? createHash("sha256").update(script).digest("base64") : SCRIPT_HASH;
  const image = await QRCode.toDataURL(code, { errorCorrectionLevel: "M", margin: 2, width: 280 });
  const amount = `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`;
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="checkout-token" content="${token}"><title>扫码付款 · StarPAY</title><style>${STYLE}</style></head><body><main><small>StarPAY 收银台</small><h1>扫码付款</h1><h2>${escapeHtml(name)}</h2><div class="amount">¥ ${amount}</div><img class="qr" src="${image}" width="280" height="280" alt="付款二维码"><p>请使用对应支付应用扫码</p><small id="payment-state" aria-live="polite">等待付款</small></main><script>${script}</script></body></html>`;
  return new Response(body, { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; img-src data:; style-src 'sha256-${STYLE_HASH}'; script-src 'sha256-${scriptHash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  } });
}
