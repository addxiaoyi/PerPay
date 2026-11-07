export function validateWechatNativeFields(input: { appId: string; providerMerchantId: string; name: string }): void {
  if (!input.appId || input.appId.length > 32 || !input.providerMerchantId || input.providerMerchantId.length > 32 || !input.name.trim() || [...input.name].length > 127 || /[\x00-\x1f\x7f]/.test(input.name)) throw new Error("invalid WeChat native order fields");
}
