import { useState } from 'react';
import { createDemoNotice, verifyDemoNotice, DEMO_KEY, type DemoNotice } from '@/lib/balance-demo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CopyValue } from '@/components/copy-value';

export function BalanceIntegrationLab() {
  const [notice, setNotice] = useState<DemoNotice | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function generate() {
    setBusy(true); setError(''); setMessage('');
    try { setNotice(await createDemoNotice()); }
    catch { setError('浏览器无法生成签名，请在 HTTPS 页面重试，或运行 SDK 中的本地联调脚本。'); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!notice) return;
    setBusy(true); setMessage(''); setError('');
    try { setMessage(await verifyDemoNotice(notice)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '模拟验签未完成。'); }
    finally { setBusy(false); }
  }
  function change(field: keyof DemoNotice, value: string) {
    setNotice(current => current ? { ...current, [field]: value } : null); setMessage(''); setError('');
  }
  return <section className="space-y-4 rounded-lg border p-5" aria-label="余额支付自助联调">
    <h3 className="text-lg font-semibold">无资金自助联调</h3>
    <p className="text-sm leading-6 text-muted-foreground">使用公开测试密钥在当前浏览器生成模拟通知，不创建线上订单、不扣款、不发送回调。可修改金额或签名，检查是否能识别篡改。请勿粘贴真实密钥或业务报文。</p>
    <p className="break-all text-xs text-muted-foreground">测试密钥：{DEMO_KEY}</p>
    <Button className="min-h-11" onClick={generate} disabled={busy}>{busy ? '正在处理…' : '生成模拟支付通知'}</Button>
    {notice && <div className="space-y-4">
      <label className="block space-y-2 text-sm">原始 JSON 报文<Textarea aria-label="模拟通知原始 JSON" value={notice.rawBody} onChange={event => change('rawBody', event.target.value)} maxLength={8192} rows={6} spellCheck={false} disabled={busy}/></label>
      <CopyValue value={notice.rawBody} label="复制模拟通知报文" buttonOnly/>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">x-lightpay-timestamp<Input aria-label="模拟时间戳" value={notice.timestamp} onChange={event => change('timestamp', event.target.value)} maxLength={11} disabled={busy}/></label>
        <label className="space-y-2 text-sm">x-idempotency-key<Input aria-label="模拟通知 ID" value={notice.callbackId} onChange={event => change('callbackId', event.target.value)} maxLength={80} disabled={busy}/></label>
      </div>
      <label className="block space-y-2 text-sm">x-lightpay-signature<Textarea aria-label="模拟签名" value={notice.signature} onChange={event => change('signature', event.target.value)} maxLength={71} rows={2} spellCheck={false} disabled={busy}/></label>
      <Button className="min-h-11" variant="outline" onClick={verify} disabled={busy}>验证模拟签名和订单</Button>
    </div>}
    {message && <p role="status" className="text-sm leading-6">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="space-y-2 border-t pt-4"><h4 className="text-sm font-medium">在自己服务器验证完整 SDK 流程</h4>
      <p className="text-sm text-muted-foreground">解压 SDK 后运行以下命令。脚本使用内存模拟下单、重复通知、退款和篡改拦截，不连接生产接口。</p>
      <CopyValue value="node balance-selftest.mjs" label="复制 SDK 本地联调命令"/>
      <p className="text-xs leading-5 text-muted-foreground">模拟通过说明本地处理符合示例；正式商户密钥、公网回调连通及实际到账仍需正式验收。</p>
    </div>
  </section>;
}
