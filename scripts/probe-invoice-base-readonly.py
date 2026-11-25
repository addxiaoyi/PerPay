"""Read invoice readiness with existing server-side credentials; never issue a tax invoice."""
import os
import subprocess

pid = subprocess.check_output(
    ["systemctl", "show", "perpay-candidate.service", "--property=MainPID", "--value"],
    universal_newlines=True,
).strip()
if not pid.isdigit() or pid == "0":
    raise RuntimeError("payment service is not running")
root = os.readlink("/proc/{}/cwd".format(pid))
runtime = os.readlink("/proc/{}/exe".format(pid))
probe = r"""
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {DatabaseSync} = require('node:sqlite');
(async () => {
  const pid = process.argv[1], root = process.argv[2];
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    .filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const sql = new DatabaseSync(path.join(env.PERPAY_DATA_DIR, 'perpay.sqlite3'), {readOnly:true});
  let master;
  try {
    sql.exec('PRAGMA query_only=ON');
    const now = Date.now(), merchantId = '1117967967';
    const credential = sql.prepare(`SELECT c.credential_id,c.app_id,c.provider_merchant_id,c.platform_key,c.platform_key_id
      FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.credential_id=? AND c.provider_merchant_id=? AND c.valid_from<=? AND c.valid_until>? AND r.credential_id IS NULL`)
      .get(env.PERPAY_EPAY_WECHAT_CREDENTIAL_ID || '', merchantId, now, now);
    if (!credential || !env.PERPAY_EPAY_WECHAT_SIGNING_KEY_ID) {
      console.log(JSON.stringify({observedAt:new Date().toISOString(),credentialMatched:false,requestSent:false}));
      return;
    }
    const load = relative => import(pathToFileURL(path.join(root, relative)).href);
    const {RuntimeSecretCipher} = await load('src/settings/crypto.ts');
    const {signWechatRequest} = await load('src/epay-compat/wechat-signing-keys.ts');
    const {verifyWechatSignature} = await load('src/epay-compat/wechat-evidence.ts');
    const {readBoundedBody} = await load('src/epay-compat/main-order-auth.ts');
    master = Buffer.from(env.PERPAY_MASTER_KEY || fs.readFileSync(path.join(env.PERPAY_SECRETS_DIR, 'master-key'), 'utf8').trim(), 'hex');
    const instanceId = String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get().value);
    const endpoint = '/v3/new-tax-control-fapiao/merchant/base-information';
    const nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(now / 1000));
    const signed = signWechatRequest(sql, new RuntimeSecretCipher(master, instanceId), env.PERPAY_EPAY_WECHAT_SIGNING_KEY_ID,
      credential.app_id, merchantId, now, `GET\n${endpoint}\n${timestamp}\n${nonce}\n\n`);
    const response = await fetch('https://api.mch.weixin.qq.com' + endpoint, {method:'GET',
      headers:{accept:'application/json',authorization:`WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`},
      redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
    const bytes = await readBoundedBody(response.body, 65536);
    let verified = false;
    try { verifyWechatSignature(bytes,response.headers,{platformKey:credential.platform_key,platformKeyId:credential.platform_key_id},Date.now()); verified=true; } catch {}
    const fields = JSON.parse(bytes.toString('utf8'));
    const code = typeof fields.code === 'string' && /^[A-Z_]{1,64}$/.test(fields.code) ? fields.code : null;
    console.log(JSON.stringify({observedAt:new Date().toISOString(),credentialMatched:true,requestSent:true,
      endpoint,httpStatus:response.status,responseVerified:verified,code,
      ...(response.status===200 && verified ? {sellerNameMatches:fields.seller_information?.name==='上海舵星科技有限公司',
        hasSellerTaxId:!!fields.seller_information?.taxpayer_id,hasDrawer:!!fields.extra_information?.drawer} : {}),
      actualInvoicesIssued:0}));
  } finally { master?.fill(0); sql.close(); }
})().catch(() => { console.error(JSON.stringify({error:'invoice_readiness_probe_failed',actualInvoicesIssued:0})); process.exitCode=1; });
"""
subprocess.check_call([runtime, "-e", probe, pid, root])
