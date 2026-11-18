export const BACKEND_ERROR_CODES = [
  'unauthorized',
  'not_found',
  'conflict',
  'service_unavailable',
  'internal_error',
] as const;

export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];

export type AlgoliaCredentialsErrorCode =
  | BackendErrorCode
  | 'http_error'
  | 'invalid_configuration'
  | 'vercel_token_error'
  | 'invalid_response'
  | 'timeout'
  | 'network_error';

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const REDIRECT_MESSAGE = 'Credentials exchange answered with a redirect';

const HTTP_MESSAGES: Record<number, string> = {
  401: 'Vercel resource token is invalid or expired',
  404: 'Resource is not accessible or the credentials exchange is unavailable',
  409: 'Resource is not ready',
  429: 'Credentials exchange is rate limited',
  500: 'Credentials exchange failed',
  502: 'Credentials exchange is temporarily unavailable',
  503: 'Credentials exchange is temporarily unavailable',
  504: 'Credentials exchange is temporarily unavailable',
};

interface ErrorDetails {
  code: AlgoliaCredentialsErrorCode;
  retryable: boolean;
  status?: number | undefined;
}

export function isTransientStatus(status: number | undefined): boolean {
  return status !== undefined && TRANSIENT_STATUSES.has(status);
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function httpMessage(status: number | undefined): string {
  if (status === undefined || isRedirectStatus(status)) return REDIRECT_MESSAGE;
  return HTTP_MESSAGES[status] ?? `Credentials exchange failed with HTTP ${status}`;
}

/** Base class of every error thrown by the provider. Never carries tokens, keys, headers or response bodies. */
export class AlgoliaCredentialsError extends Error {
  override name = 'AlgoliaCredentialsError';
  readonly code: AlgoliaCredentialsErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, { code, retryable, status }: ErrorDetails) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  toJSON() {
    return { name: this.name, message: this.message, code: this.code, status: this.status, retryable: this.retryable };
  }
}

/** Invalid provider options. */
export class CredentialsConfigurationError extends AlgoliaCredentialsError {
  override name = 'CredentialsConfigurationError';

  constructor(message: string) {
    super(message, { code: 'invalid_configuration', retryable: false });
  }
}

/** `getIntegrationToken` failed. Keeps Vercel's status and code, never its message or metadata. */
export class VercelTokenError extends AlgoliaCredentialsError {
  override name = 'VercelTokenError';
  readonly vercelCode: string | undefined;

  constructor(status?: number, vercelCode?: string) {
    super('Unable to obtain a Vercel resource token', {
      code: 'vercel_token_error',
      status,
      retryable: isTransientStatus(status),
    });
    this.vercelCode = vercelCode;
  }

  override toJSON() {
    return { ...super.toJSON(), vercelCode: this.vercelCode };
  }
}

/**
 * The exchange endpoint answered with a non-2xx status or a redirect, which is never followed.
 * `status` is undefined when the redirect is opaque.
 */
export class CredentialsHttpError extends AlgoliaCredentialsError {
  override name = 'CredentialsHttpError';
  readonly retryAfterMs: number | undefined;

  constructor(status: number | undefined, backendCode?: BackendErrorCode, retryAfterMs?: number) {
    super(httpMessage(status), {
      code: backendCode ?? 'http_error',
      status,
      retryable: isTransientStatus(status),
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/** The exchange endpoint answered 2xx with unusable credentials. */
export class InvalidCredentialsResponseError extends AlgoliaCredentialsError {
  override name = 'InvalidCredentialsResponseError';

  constructor(message: string) {
    super(message, { code: 'invalid_response', retryable: false });
  }
}

/** An attempt or the whole `get()` exceeded its time budget. */
export class CredentialsTimeoutError extends AlgoliaCredentialsError {
  override name = 'CredentialsTimeoutError';

  constructor() {
    super('Credentials request timed out', { code: 'timeout', retryable: true });
  }
}

/** The exchange request failed before any response was received. */
export class CredentialsNetworkError extends AlgoliaCredentialsError {
  override name = 'CredentialsNetworkError';

  constructor() {
    super('Credentials exchange request failed', { code: 'network_error', retryable: true });
  }
}
