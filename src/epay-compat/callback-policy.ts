export const EPAY_CALLBACK_POLICY = Object.freeze({
  timeoutMilliseconds: 10_000,
  leaseMilliseconds: 30_000,
  maximumAttempts: 80,
  retryDelayMilliseconds: 30_000,
  retryMaximumDelayMilliseconds: 3_600_000,
});
