import type { ProviderConfig } from './config.js';
import { CredentialsTimeoutError, VercelTokenError } from './errors.js';

const VERCEL_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export async function mintResourceToken(config: ProviderConfig, timeoutMs: number): Promise<string> {
  let token: unknown;
  try {
    token = await withTimeout(Promise.resolve().then(() => config.getIntegrationToken(config.resource)), timeoutMs);
  } catch (error) {
    throw error instanceof CredentialsTimeoutError ? error : toVercelTokenError(error);
  }
  if (typeof token !== 'string' || token === '') throw new VercelTokenError();
  return token;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new CredentialsTimeoutError()), { once: true });
  });
  return Promise.race([promise, timeout]);
}

function toVercelTokenError(error: unknown): VercelTokenError {
  const { status, code } = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  return new VercelTokenError(safeStatus(status), safeVercelCode(code));
}

function safeStatus(status: unknown): number | undefined {
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? (status as number) : undefined;
}

function safeVercelCode(code: unknown): string | undefined {
  return typeof code === 'string' && VERCEL_CODE_PATTERN.test(code) ? code : undefined;
}
