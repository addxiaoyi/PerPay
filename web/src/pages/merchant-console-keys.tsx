import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminMountPath } from "@/admin-base";
import { merchantRequest, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";

type MerchantKeys = { merchantId: string; epayPid: string; apiId: string; keyConfigured: boolean; md5Key?: string };
type RotationSession = { canRotate: boolean; version: number; csrfToken: string | null };

export function MerchantConsoleKeys({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const client = useQueryClient();
  const rotationSession = useQuery({ queryKey: ["merchant-console", merchantId, "key-rotation-session", role], queryFn: ({ signal }) => merchantRequest<RotationSession>("keys/rotation-session", { merchantId }, signal), retry: false, enabled: role !== "member" });
  const [confirmRotation, setConfirmRotation] = useState(false), [rotationRequest, setRotationRequest] = useState<{ requestId: string; expectedVersion: number } | null>(null);
  const metadata = useQuery({ queryKey: ["merchant-console", merchantId, "keys-meta"], queryFn: ({ signal }) => merchantRequest<MerchantKeys>("keys/meta", { merchantId }, signal), retry: false });
  const [secret, setSecret] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [mainSecret, setMainSecret] = useState("");
  const request = useRef<AbortController | null>(null);
  const rotate = useMutation({ retry: false, mutationFn: async (command: { requestId: string; expectedVersion: number }) => {
    const session = await merchantRequest<RotationSession>("keys/rotation-session", { merchantId });
    if (!session.canRotate || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest<{ version: number; duplicate: boolean }>("keys/rotate", { merchantId }, undefined, { token: session.csrfToken, body: command });
  }, onSuccess: async () => { setConfirmRotation(false); setRotationRequest(null); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  function beginRotation() {
    request.current?.abort(); request.current = null; setSecret(""); setMainSecret(""); setPending(false); setError("");
    setConfirmRotation(true); rotate.reset();
  }
  function confirmKeyRotation() {
    if (role === "member" || !rotationSession.data?.canRotate) return;
    const command = rotationRequest ?? { requestId: crypto.randomUUID(), expectedVersion: rotationSession.data.version };
    setRotationRequest(command); rotate.mutate(command);
  }
  useEffect(() => {
    function hideWhenBackgrounded() {
      if (document.visibilityState !== "hidden") return;
      request.current?.abort(); request.current = null;
      setSecret(""); setMainSecret(""); setPending(false);
    }
    document.addEventListener("visibilitychange", hideWhenBackgrounded);
    return () => { request.current?.abort(); document.removeEventListener("visibilitychange", hideWhenBackgrounded); };
  }, []);
  async function toggleKey() {
    if (secret) { setSecret(""); return; }
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError("");
    try {
      // Keep plaintext out of query caches and discard it when the view is hidden.
      const keys = await merchantRequest<MerchantKeys>("keys", { merchantId }, controller.signal);
      if (!controller.signal.aborted) {
        if (!keys.md5Key) throw new Error("merchant key is missing");
        setSecret(keys.md5Key);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof MerchantConsoleError ? failure.message : "密钥暂时无法读取，请稍后重试。");
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }
  async function toggleMainKey() {
    if (mainSecret) { setMainSecret(""); return; }
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError("");
    try {
      const keys = await merchantRequest<{ apiSecret: string }>("profile/main-key", { merchantId }, controller.signal);
      if (!controller.signal.aborted) {
        if (!keys.apiSecret) throw new Error("main key unavailable");
        setMainSecret(keys.apiSecret);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof MerchantConsoleError ? failure.message : "主站 API 密钥暂时无法读取。");
    } finally { if (request.current === controller) { request.current = null; setPending(false); } }
  }
  const root = `${window.location.origin}${adminMountPath()}`;
  return <section aria-label="API 接入" className="space-y-6"><div><h2 className="text-xl font-semibold">API 接入</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">保留原商户号与 EPay MD5 签名。将密钥保存在接入网站的服务器端。</p></div><ConsoleQuery query={metadata}>{keys => <><dl className="grid gap-5 sm:grid-cols-2">{[["EPay 商户号 / pid", keys.epayPid], ["StarMC API ID", keys.apiId], ["网关根地址", root], ["表单下单地址", `${root}/submit.php`], ["接口下单地址", `${root}/mapi.php`], ["支付类型", "alipay / wxpay"]].map(([label, value]) => <div key={label} className="min-w-0 space-y-1 border-b pb-4"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-all font-mono text-sm leading-6">{value}</dd></div>)}</dl><div className="space-y-3 border-t pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">EPay MD5 签名密钥</h3><Button variant="outline" disabled={pending || rotate.isPending || confirmRotation || !keys.keyConfigured} aria-pressed={Boolean(secret)} onClick={toggleKey}>{pending ? "正在读取…" : secret ? "隐藏密钥" : "查看密钥"}</Button></div>{!keys.keyConfigured ? <p className="text-sm text-muted-foreground">当前商户尚未配置签名密钥，请联系管理员。</p> : secret ? <code className="block break-all border bg-muted/30 p-4 text-sm" aria-label="EPay MD5 密钥">{secret}</code> : <p className="text-sm text-muted-foreground">密钥已隐藏。切换商户或离开当前页面后会自动隐藏。</p>}<p className="text-sm leading-6 text-muted-foreground">签名参数按名称升序拼接，排除 sign、sign_type 和空值；末尾追加 MD5 密钥，再计算小写 MD5。StarMC API Key 继续由主站管理。</p></div></>}</ConsoleQuery><div className="space-y-3 border-t pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">StarMC API 密钥</h3><Button variant="outline" disabled={pending || rotate.isPending || confirmRotation} aria-pressed={Boolean(mainSecret)} onClick={toggleMainKey}>{mainSecret ? "隐藏主站密钥" : "查看主站密钥"}</Button></div>{mainSecret ? <code className="block break-all border bg-muted/30 p-4 text-sm" aria-label="StarMC API 密钥">{mainSecret}</code> : <p className="text-sm text-muted-foreground">用于主站商户 API 的 HMAC 签名，与 EPay MD5 密钥不同。</p>}</div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{role !== "member" && rotationSession.data?.canRotate && !rotationSession.isError && <div className="space-y-4 border-t pt-5"><h3 className="font-medium">轮换 EPay 密钥</h3><p className="text-sm leading-6 text-muted-foreground">换钥后，原密钥不能创建新订单。已有订单的回调与返回签名继续使用下单时的密钥，请在接入网站保留旧密钥直到在途订单处理完毕。</p>{!confirmRotation ? <Button variant="outline" onClick={beginRotation}>准备轮换密钥</Button> : <div className="space-y-3 rounded-lg border p-4"><p className="text-sm">确认后请在接入网站更新配置，再恢复新订单提交。</p><div className="flex flex-wrap gap-3"><Button disabled={rotate.isPending} onClick={confirmKeyRotation}>{rotate.isPending ? "正在轮换…" : rotationRequest ? "重试本次轮换" : "确认轮换密钥"}</Button>{!rotationRequest && <Button variant="ghost" onClick={() => setConfirmRotation(false)}>取消</Button>}</div></div>}{rotate.isSuccess && <p role="status" className="text-sm">密钥已轮换。点击“查看密钥”获取新密钥。</p>}{rotate.isError && <p role="alert" className="text-sm text-destructive">{rotate.error.message}</p>}</div>}</section>;
}
