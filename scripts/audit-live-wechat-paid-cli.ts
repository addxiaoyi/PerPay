import { runLiveWechatAudit } from "./audit-live-wechat-paid.ts";

try {
  const summary = await runLiveWechatAudit(process.argv[2] ?? "");
  process.stdout.write(`${JSON.stringify({ readOnly: true, verifiedProviderStates: summary })}\n`);
} catch {
  process.stderr.write("WeChat read-only audit failed; no order or ledger changes were made\n");
  process.exitCode = 1;
}
