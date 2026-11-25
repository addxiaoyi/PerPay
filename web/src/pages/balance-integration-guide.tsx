import { adminMountPath } from '@/admin-base';
import { CopyValue } from '@/components/copy-value';
import { balanceCreateCode } from '@/portal/balance-guide';
import { BalanceIntegrationLab } from './balance-integration-lab';

export function BalanceIntegrationGuide({merchantId}: {merchantId: string}) {
  const root = `${window.location.origin}${adminMountPath()}`;
  const query = new URLSearchParams({merchantId, topic:'sdk'});
  return <section className="space-y-5" aria-label="跨站余额支付接入">
    <div className="space-y-2"><h3 className="text-lg font-semibold">跨站余额支付</h3><p className="text-sm leading-6 text-muted-foreground">其他网站创建收款订单，买家在 StarPAY 确认商户余额扣款，接入网站验签并查询后完成发货。</p></div>
    <p className="text-sm leading-6">使用本页的 EPay PID 与 EPay MD5 密钥，余额接口采用 HMAC-SHA256。普通易支付的 alipay / wxpay 和余额 SDK 是不同的接入协议。</p>
    <div className="flex flex-wrap gap-4 text-sm"><a className="inline-flex min-h-11 items-center underline" href={`${root}/epay/docs/balance-merchant-sdk.zip`} download>下载余额 SDK 与本地联调脚本</a><a className="inline-flex min-h-11 items-center underline" href={`${root}/merchant/docs?${query}`}>阅读完整余额支付教程</a></div>
    <dl className="space-y-3 text-sm">{[['下单', 'orders'], ['查询', 'query'], ['退款', 'refund']].map(([label,path])=><div key={path}><dt className="font-medium">{label} · POST</dt><dd className="break-all"><CopyValue value={`${root}/epay/balance/${path}`} label={`复制余额${label}地址`}/></dd></div>)}</dl>
    <div className="space-y-2"><h4 className="font-medium">Node.js 下单示例</h4><CopyValue value={balanceCreateCode} label="复制余额下单示例"/></div>
    <BalanceIntegrationLab/>
  </section>;
}
