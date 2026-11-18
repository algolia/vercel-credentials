import type { ProviderConfig } from './config.js';
import {
  CredentialsHttpError,
  CredentialsNetworkError,
  CredentialsTimeoutError,
  isRedirectStatus,
  type AlgoliaCredentialsError,
} from './errors.js';
import { httpError, parseCredentials } from './response.js';
import type { AlgoliaCredentials } from './types.js';

type ExchangeReply =
  | { redirect: true; status: number | undefined }
  | { redirect: false; ok: boolean; status: number; retryAfter: string | null; body: string };

export async function exchangeToken(config: ProviderConfig, token: string, timeoutMs: number): Promise<AlgoliaCredentials> {
  const reply = await postToken(config, token, timeoutMs);
  if (reply.redirect) throw new CredentialsHttpError(reply.status);
  if (!reply.ok) throw httpError(reply.status, reply.body, reply.retryAfter, config.now());
  return parseCredentials(reply.body, config.now());
}

async function postToken(config: ProviderConfig, token: string, timeoutMs: number): Promise<ExchangeReply> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await config.fetch(config.exchangeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal,
    });
    if (isRedirect(response)) return redirectReply(response);
    const body = await response.text();
    return { redirect: false, ok: response.ok, status: response.status, retryAfter: response.headers.get('retry-after'), body };
  } catch (error) {
    throw transportError(error, signal);
  }
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || response.status === 0 || isRedirectStatus(response.status);
}

function redirectReply(response: Response): ExchangeReply {
  response.body?.cancel().catch(() => undefined);
  return { redirect: true, status: isRedirectStatus(response.status) ? response.status : undefined };
}

function transportError(error: unknown, signal: AbortSignal): AlgoliaCredentialsError {
  return signal.aborted || isTimeoutError(error) ? new CredentialsTimeoutError() : new CredentialsNetworkError();
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}
