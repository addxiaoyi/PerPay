import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { merchantRequest, centsText, dateText, MerchantConsoleError } from '@/api/merchant-console';
import { balanceCheckoutSession } from '@/api/balance-payment';
import { readBalanceResume, originalCheckout, sameOriginCheckout, type BalanceResume } from '@/lib/balance-resume';
import { ConsoleQuery } from '@/components/merchant-console-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';

type Session = { balance: { availableCents: number; frozenCents: number }; channels: string[]; canRecharge: boolean; csrfToken: string };
type Command = { requestId: string; amount: string; channel: string; resume?: BalanceResume };
type Topup = { tradeNo: string; amountCents: number; status: string; createdAt: number; checkoutUrl?: string | null };
const channelLabel = (channel: string) => channel === 'alipay_web' ? '支付宝网页支付' : '微信扫码支付';

export function MerchantTopups({ merchantId }: { merchantId: string }) {
  const [search] = useSearchParams();
  const resume = readBalanceResume(search);
  const invalidResume = !resume && (search.has('resumeOrderId') || search.has('resumeToken'));
  const [amount, setAmount] = useState<string | null>(null);
  const [channel, setChannel] = useState('alipay_web');
  const [pending, setPending] = useState<Command | null>(null);
  const [validation, setValidation] = useState('');
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ['merchant-console', merchantId, 'topup-session'],
    queryFn: ({ signal }) => merchantRequest<Session>('topups/session', { merchantId }, signal),
    retry: false, refetchInterval: 10_000,
  });
  const original = useQuery({
    queryKey: ['merchant-console', merchantId, 'topup-original', resume?.orderId, resume?.token],
    queryFn: ({ signal }) => balanceCheckoutSession(merchantId, resume!.orderId, resume!.token, signal),
    enabled: Boolean(resume), retry: false, refetchInterval: resume ? 10_000 : false,
  });
  const records = useQuery({
    queryKey: ['merchant-console', merchantId, 'topups'],
    queryFn: ({ signal }) => merchantRequest<{ topups: Topup[] }>('topups', { merchantId }, signal),
    retry: false, refetchInterval: query => query.state.data?.topups.some(row => row.status === 'PENDING') ? 10_000 : false,
  });
  const shortfall = original.data ? Math.max(0, original.data.order.amountCents - original.data.balance.availableCents) : 0;
  const rechargeAmount = amount ?? (shortfall > 0 ? (shortfall / 100).toFixed(2) : '100.00');
  const canResumeRecharge = !invalidResume && (!resume || original.data?.order.status === 'pending');
  const create = useMutation({
    retry: false,
    mutationFn: async (command: Command) => {
      const fresh = await merchantRequest<Session>('topups/session', { merchantId });
      if (!fresh.canRecharge) throw new MerchantConsoleError(503, 'topup_disabled');
      const payment = await merchantRequest<{ checkoutUrl: string; order: { amountCents: number; status: string } }>('topups', { merchantId }, undefined, { token: fresh.csrfToken, body: command });
      const href = sameOriginCheckout(payment.checkoutUrl);
      if (!href) throw new Error('充值链接未通过校验，请核对原订单。');
      return { ...payment, checkoutUrl: href };
    },
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof MerchantConsoleError && [400, 401, 403, 409].includes(error.status)) setPending(null); },
    onSettled: async () => { await client.invalidateQueries({ queryKey: ['merchant-console', merchantId, 'topups'] }); },
  });
  function requestTopup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d+(?:\.\d{1,2})?$/.test(rechargeAmount) || Number(rechargeAmount) <= 0) {
      setValidation('请输入大于零、最多两位小数的充值金额。'); return;
    }
    const selected = session.data?.channels.includes(channel) ? channel : session.data?.channels[0];
    if (!selected) { setValidation('暂时没有可用充值通道。'); return; }
    if (!pending && !canResumeRecharge) { setValidation('请先核对原订单状态。'); return; }
    const command = pending ?? { requestId: crypto.randomUUID(), amount: rechargeAmount, channel: selected, ...(resume ? { resume } : {}) };
    setValidation(''); setPending(command); create.mutate(command);
  }
  function refresh() { void session.refetch(); void records.refetch(); if (resume) void original.refetch(); }
  return <section className="space-y-5">
    <div><h2 className="text-xl font-semibold">商户余额充值</h2><p className="mt-2 text-sm text-muted-foreground">充值本金全额入账，可用于余额支付和年服务购买。冻结余额不能用于交易。</p></div>
    {invalidResume && <p role="alert">原订单链接不完整，请返回收银台重新进入。</p>}
    {resume && <ConsoleQuery query={original}>{checkout => <div className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">充值后继续支付：{checkout.order.subject}</h3>
      <p className="text-sm">订单金额 ¥ {centsText(checkout.order.amountCents)} · 当前还差 ¥ {centsText(shortfall)}</p>
      <p role="status" className="text-sm">{checkout.order.status !== 'pending' ? '原订单已支付、退款或过期，请返回查看；无需为该订单继续充值。' : checkout.canPay ? '余额已足够，可返回原订单确认付款。' : '请完成充值并等待到账，随后返回原订单。原订单有效期不因充值延长。'}</p>
      <a className="inline-flex min-h-11 items-center font-medium underline" href={originalCheckout(merchantId, resume)}>返回原订单确认付款</a>
      <p className="text-xs text-muted-foreground">充值不会自动支付原订单。完成充值后仍需在收银台确认扣款。</p>
    </div>}</ConsoleQuery>}
    <ConsoleQuery query={session}>{state => {
      const selected = state.channels.includes(channel) ? channel : state.channels[0] ?? '';
      return <form onSubmit={requestTopup} className="space-y-4 rounded-lg border p-5">
        <p className="text-sm">可用余额 ¥ {centsText(state.balance.availableCents)} · 冻结余额 ¥ {centsText(state.balance.frozenCents)}</p>
        <fieldset disabled={create.isPending || Boolean(pending)} className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">充值金额（元）<Input aria-label="充值金额（元）" value={rechargeAmount} onChange={event => setAmount(event.target.value)} inputMode="decimal" maxLength={16} required /></label>
          <div className="space-y-1 text-sm"><label htmlFor="topup-channel">支付通道</label>
            <Select value={selected} onValueChange={value => { if (value) setChannel(value); }}>
              <SelectTrigger id="topup-channel" aria-label="充值支付通道"><SelectValue>{selected ? channelLabel(selected) : '暂无可用通道'}</SelectValue></SelectTrigger>
              <SelectContent>{state.channels.map(value => <SelectItem key={value} value={value}>{channelLabel(value)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </fieldset>
        <p className="text-xs leading-5 text-muted-foreground">创建订单不会立即增加余额。请完成支付，系统核实到账后才记入余额；充值本金不扣交易手续费。</p>
        <Button className="min-h-11" type="submit" disabled={!state.canRecharge || !state.channels.length || create.isPending || (!pending && !canResumeRecharge)}>{create.isPending ? '正在创建充值订单…' : pending ? '核对原充值请求' : '创建充值订单'}</Button>
        {!state.canRecharge && <p role="status" className="text-sm">平台暂不接受新充值，请稍后刷新。</p>}
        {(validation || create.isError) && <p role="alert" className="text-sm text-destructive">{validation || create.error?.message}</p>}
        {create.data && <div className="space-y-2"><p role="status" className="text-sm">充值订单已生成，金额 ¥ {centsText(create.data.order.amountCents)}。</p><a className="inline-flex min-h-11 items-center text-sm underline" href={create.data.checkoutUrl} target="_blank" rel="noopener noreferrer">前往支付通道完成充值</a></div>}
      </form>;
    }}</ConsoleQuery>
    <div className="flex items-center justify-between"><h3 className="font-medium">最近充值</h3><Button className="min-h-11" variant="outline" onClick={refresh}>刷新到账状态</Button></div>
    <ConsoleQuery query={records}>{history => <>
      {!history.topups.length && <p className="text-sm text-muted-foreground">尚无充值记录。</p>}
      <ul className="divide-y">{history.topups.map(row => {
        const href = sameOriginCheckout(row.checkoutUrl);
        return <li key={row.tradeNo} className="space-y-1 py-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><span>¥ {centsText(row.amountCents)}</span><span>{row.status === 'PAID' ? '已到账' : row.status === 'PENDING' ? '待支付确认' : row.status === 'REFUNDED' ? '已退回' : '已结束'}</span></div>
          <p className="break-all text-xs text-muted-foreground">{row.tradeNo} · {dateText(row.createdAt)}</p>
          {href && <a className="inline-flex min-h-11 items-center underline" href={href} target="_blank" rel="noopener noreferrer">查看原充值收银台</a>}
        </li>;
      })}</ul>
    </>}</ConsoleQuery>
  </section>;
}
