import type { ProviderConfig } from './config.js';
import { AlgoliaCredentialsError, CredentialsHttpError, CredentialsTimeoutError } from './errors.js';

const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

export function deadlineFrom(config: ProviderConfig): number {
  return config.now() + config.timeoutMs * (config.maxRetries + 1) + MAX_RETRY_DELAY_MS * config.maxRetries;
}

export function attemptTimeout(config: ProviderConfig, deadline: number): number {
  const remaining = Math.ceil(deadline - config.now());
  if (remaining <= 0) throw new CredentialsTimeoutError();
  return Math.min(config.timeoutMs, remaining);
}

export async function withRetries<T>(
  config: ProviderConfig,
  deadline: number,
  attempt: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt(attemptTimeout(config, deadline));
    } catch (error) {
      const delay = retryDelay(error, retry);
      if (delay === undefined || retry >= config.maxRetries || config.now() + delay >= deadline) throw error;
      await config.sleep(delay);
    }
  }
}

function retryDelay(error: unknown, retry: number): number | undefined {
  if (!(error instanceof AlgoliaCredentialsError) || !error.retryable) return undefined;
  const requested = error instanceof CredentialsHttpError ? error.retryAfterMs : undefined;
  return Math.min(requested ?? BASE_RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
}
