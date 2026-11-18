import type { ProviderConfig } from './config.js';
import { CredentialsTimeoutError, isTransientStatus, VercelTokenError } from './errors.js';

const VERCEL_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OIDC_TOKEN_ERROR_NAME = 'VercelOidcTokenError';
const OIDC_TOKEN_UNAVAILABLE = 'oidc_token_unavailable';

export async function mintResourceToken(config: ProviderConfig, timeoutMs: number): Promise<string> {
  let token: unknown;
  try {
    token = await withTimeout(timeoutMs, () => config.getIntegrationToken(config.resource));
  } catch (error) {
    throw error instanceof CredentialsTimeoutError ? error : toVercelTokenError(error);
  }
  if (typeof token !== 'string' || token === '') throw new VercelTokenError();
  return token;
}

function withTimeout<T>(timeoutMs: number, start: () => Promise<T>): Promise<T> {
  const timeout = timeoutRejection(AbortSignal.timeout(timeoutMs));
  return Promise.race([timeout, Promise.resolve().then(start)]);
}

function timeoutRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new CredentialsTimeoutError(false)), { once: true });
  });
}

function toVercelTokenError(error: unknown): VercelTokenError {
  const { name, status, code } = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  if (name === OIDC_TOKEN_ERROR_NAME) return new VercelTokenError(undefined, OIDC_TOKEN_UNAVAILABLE, false);
  const httpStatus = safeStatus(status);
  return new VercelTokenError(httpStatus, safeVercelCode(code), isRetryableMintFailure(httpStatus, error));
}

function isRetryableMintFailure(status: number | undefined, error: unknown): boolean {
  return status === undefined ? error instanceof TypeError : isTransientStatus(status);
}

function safeStatus(status: unknown): number | undefined {
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? (status as number) : undefined;
}

function safeVercelCode(code: unknown): string | undefined {
  return typeof code === 'string' && VERCEL_CODE_PATTERN.test(code) ? code : undefined;
}
