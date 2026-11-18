import { IntegrationTokenError } from '@vercel/integrations';
import { describe, expect, it } from 'vitest';
import {
  AlgoliaCredentialsError,
  CredentialsHttpError,
  CredentialsNetworkError,
  CredentialsTimeoutError,
  VercelTokenError,
} from '../src/index.js';
import {
  credentialsResponse,
  errorResponse,
  jsonResponse,
  rejection,
  setup,
  START_MS,
  VercelOidcTokenError,
} from './helpers.js';

function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

describe('HTTP statuses', () => {
  it.each([
    [401, 'unauthorized', false, 'Vercel resource token is invalid or expired'],
    [404, 'not_found', false, 'Resource is not accessible or the credentials exchange is unavailable'],
    [409, 'conflict', false, 'Resource is not ready'],
    [500, 'internal_error', false, 'Credentials exchange failed'],
    [503, 'service_unavailable', true, 'Credentials exchange is temporarily unavailable'],
  ] as const)('maps %i to %s', async (status, code, retryable, message) => {
    const { provider, fetch } = setup({ maxRetries: 0 });
    fetch.mockImplementation(async () => errorResponse(status, code, 'backend detail'));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsHttpError);
    expect(error).toBeInstanceOf(AlgoliaCredentialsError);
    expect(error).toMatchObject({ status, code, retryable, message });
  });

  it.each(['Unable to verify token', 'Unable to issue credentials'])('maps 503 %j to service_unavailable', async (detail) => {
    const { provider, fetch } = setup({ maxRetries: 0 });
    fetch.mockImplementation(async () => errorResponse(503, 'service_unavailable', detail));

    await expect(provider.get()).rejects.toMatchObject({ status: 503, code: 'service_unavailable', retryable: true });
  });

  it.each([400, 401, 403, 404, 409, 500])('does not retry %i', async (status) => {
    const { provider, fetch, sleep } = setup();
    fetch.mockImplementation(async () => errorResponse(status, 'unauthorized'));

    await expect(provider.get()).rejects.toMatchObject({ status, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('falls back to http_error for an unknown backend code', async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => errorResponse(403, 'forbidden_by_policy'));

    await expect(provider.get()).rejects.toMatchObject({ status: 403, code: 'http_error', retryable: false });
  });

  it('falls back to http_error for a non-JSON error body', async () => {
    const { provider, fetch } = setup({ maxRetries: 0 });
    fetch.mockImplementation(async () => new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(provider.get()).rejects.toMatchObject({ status: 502, code: 'http_error', retryable: true });
  });
});

describe('retries', () => {
  it.each([429, 502, 503, 504])('retries %i with backoff', async (status) => {
    const { provider, fetch, sleep, getIntegrationToken, clock } = setup();
    fetch
      .mockImplementationOnce(async () => errorResponse(status, 'service_unavailable'))
      .mockImplementationOnce(async () => errorResponse(status, 'service_unavailable'))
      .mockImplementation(async () => credentialsResponse(clock.ms));

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
    expect(getIntegrationToken).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After in seconds', async () => {
    const { provider, fetch, sleep, clock } = setup();
    fetch
      .mockImplementationOnce(async () =>
        errorResponse(503, 'service_unavailable', 'Unable to issue credentials', { 'retry-after': '3' }),
      )
      .mockImplementation(async () => credentialsResponse(clock.ms));

    await provider.get();

    expect(sleep.mock.calls).toEqual([[3000]]);
  });

  it('honors Retry-After as an HTTP date', async () => {
    const { provider, fetch, sleep, clock } = setup();
    const retryAt = new Date(START_MS + 2000).toUTCString();
    fetch
      .mockImplementationOnce(async () => errorResponse(429, 'rate_limited', 'slow down', { 'retry-after': retryAt }))
      .mockImplementation(async () => credentialsResponse(clock.ms));

    await provider.get();

    expect(sleep.mock.calls).toEqual([[2000]]);
  });

  it('caps Retry-After at 5 seconds', async () => {
    const { provider, fetch, sleep, clock } = setup();
    fetch
      .mockImplementationOnce(async () => errorResponse(503, 'service_unavailable', 'busy', { 'retry-after': '120' }))
      .mockImplementation(async () => credentialsResponse(clock.ms));

    await provider.get();

    expect(sleep.mock.calls).toEqual([[5000]]);
  });

  it('rejects with the last error once retries are exhausted', async () => {
    const { provider, fetch, sleep } = setup();
    fetch.mockImplementation(async () => errorResponse(503, 'service_unavailable', 'busy', { 'retry-after': '5' }));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsHttpError);
    expect(error).toMatchObject({ status: 503, code: 'service_unavailable', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('honors maxRetries', async () => {
    const { provider, fetch } = setup({ maxRetries: 4 });
    fetch.mockImplementation(async () => errorResponse(502, 'service_unavailable'));

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsHttpError);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('stops retrying at the overall deadline', async () => {
    const { provider, fetch, clock, sleep } = setup({ timeoutMs: 1000, maxRetries: 5 });
    fetch.mockImplementation(async () => {
      clock.ms += 4000;
      return errorResponse(503, 'service_unavailable', 'busy', { 'retry-after': '5' });
    });

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsHttpError);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('retries a network error', async () => {
    const { provider, fetch, clock } = setup();
    fetch
      .mockImplementationOnce(async () => {
        throw new TypeError('fetch failed');
      })
      .mockImplementation(async () => credentialsResponse(clock.ms));

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a network error once retries are exhausted', async () => {
    const { provider, fetch } = setup({ maxRetries: 0 });
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(provider.get()).rejects.toMatchObject({ code: 'network_error', retryable: true });
    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsNetworkError);
  });
});

describe('timeouts', () => {
  it('maps a timed out attempt to CredentialsTimeoutError', async () => {
    const { provider, fetch } = setup({ maxRetries: 0 });
    fetch.mockRejectedValue(timeoutError());

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsTimeoutError);
    expect(error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('aborts the request through its signal', async () => {
    const { provider, fetch } = setup({ maxRetries: 0, timeoutMs: 5 });
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsTimeoutError);
  });

  it('retries after a timeout', async () => {
    const { provider, fetch, clock } = setup();
    fetch.mockRejectedValueOnce(timeoutError()).mockImplementation(async () => credentialsResponse(clock.ms));

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('Vercel token mint failures', () => {
  it('wraps IntegrationTokenError keeping only status and code', async () => {
    const { provider, getIntegrationToken, fetch } = setup();
    getIntegrationToken.mockRejectedValue(
      new IntegrationTokenError({
        status: 404,
        code: 'not_found',
        message: 'Resource store_abc123 is not connected',
        metadata: { detail: 'private' },
      }),
    );

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(VercelTokenError);
    expect(error).toMatchObject({
      code: 'vercel_token_error',
      status: 404,
      vercelCode: 'not_found',
      retryable: false,
      message: 'Unable to obtain a Vercel resource token',
    });
    expect(error).not.toHaveProperty('metadata');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([429, 502, 503, 504])('retries a transient %i mint failure', async (status) => {
    const { provider, getIntegrationToken, fetch, sleep } = setup();
    getIntegrationToken.mockRejectedValueOnce(new IntegrationTokenError({ status, code: 'unavailable', message: 'x' }));

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(getIntegrationToken).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it('surfaces a transient mint failure once retries are exhausted', async () => {
    const { provider, getIntegrationToken, fetch } = setup();
    getIntegrationToken.mockRejectedValue(new IntegrationTokenError({ status: 503, code: 'unavailable', message: 'x' }));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(VercelTokenError);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(getIntegrationToken).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404])('does not retry a %i mint failure', async (status) => {
    const { provider, getIntegrationToken, fetch, sleep } = setup();
    getIntegrationToken.mockRejectedValue(new IntegrationTokenError({ status, code: 'denied', message: 'x' }));

    await expect(provider.get()).rejects.toMatchObject({ code: 'vercel_token_error', status, retryable: false });
    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a timed out mint', async () => {
    const { provider, getIntegrationToken, fetch, sleep } = setup({ timeoutMs: 5 });
    getIntegrationToken.mockImplementationOnce(() => new Promise<string>(() => {}));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsTimeoutError);
    expect(error).toMatchObject({ code: 'timeout', retryable: false });
    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a network mint failure', async () => {
    const { provider, getIntegrationToken, fetch, sleep } = setup();
    getIntegrationToken.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(getIntegrationToken).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it('surfaces a network mint failure once retries are exhausted', async () => {
    const { provider, getIntegrationToken, fetch } = setup();
    getIntegrationToken.mockRejectedValue(new TypeError('fetch failed'));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(VercelTokenError);
    expect(error).toMatchObject({ code: 'vercel_token_error', status: undefined, vercelCode: undefined, retryable: true });
    expect(getIntegrationToken).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a missing OIDC token without retrying it', async () => {
    const { provider, getIntegrationToken, fetch, sleep } = setup();
    getIntegrationToken.mockRejectedValue(
      new VercelOidcTokenError('The OIDC token is missing', new TypeError('ENOENT .vercel/project.json')),
    );

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(VercelTokenError);
    expect(error).toMatchObject({
      code: 'vercel_token_error',
      status: undefined,
      vercelCode: 'oidc_token_unavailable',
      retryable: false,
      message: 'Unable to obtain a Vercel resource token',
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('times out an attempt whose mint used up its budget, then retries', async () => {
    const { provider, getIntegrationToken, fetch, clock } = setup({ timeoutMs: 1000 });
    getIntegrationToken.mockImplementationOnce(async () => {
      clock.ms += 1000;
      return 'vercel-resource-token';
    });

    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(getIntegrationToken).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('wraps an arbitrary error without status or code and does not retry it', async () => {
    const { provider, getIntegrationToken } = setup();
    getIntegrationToken.mockRejectedValue(new Error('The OIDC token is missing'));

    await expect(provider.get()).rejects.toMatchObject({
      code: 'vercel_token_error',
      status: undefined,
      vercelCode: undefined,
      retryable: false,
    });
    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty token', async () => {
    const { provider, getIntegrationToken, fetch } = setup();
    getIntegrationToken.mockResolvedValue('');

    await expect(provider.get()).rejects.toBeInstanceOf(VercelTokenError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a malformed Vercel code', async () => {
    const { provider, getIntegrationToken } = setup();
    getIntegrationToken.mockRejectedValue({ status: 400, code: 'Bearer abc.def' });

    await expect(provider.get()).rejects.toMatchObject({ status: 400, vercelCode: undefined });
  });
});

describe('error serialization', () => {
  it('serializes only safe fields', async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => jsonResponse({ error: { code: 'unauthorized', message: 'x' } }, 401));

    const error = await rejection(provider.get());

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CredentialsHttpError',
      message: 'Vercel resource token is invalid or expired',
      code: 'unauthorized',
      status: 401,
      retryable: false,
    });
  });
});
