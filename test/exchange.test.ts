import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialsConfigurationError,
  CredentialsHttpError,
  createAlgoliaCredentialsProvider,
  InvalidCredentialsResponseError,
  type AlgoliaCredentialsProviderOptions,
} from '../src/index.js';
import {
  APP_ID,
  credentialsResponse,
  DEFAULT_ENDPOINT,
  ENDPOINT_ENV_VAR,
  jsonResponse,
  RESOURCE,
  rejection,
  setup,
  START_MS,
  TOKEN,
  WRITE_KEY,
} from './helpers.js';

describe('successful exchange', () => {
  it('returns the exchanged credentials', async () => {
    const { provider } = setup();

    await expect(provider.get()).resolves.toEqual({
      applicationId: APP_ID,
      writeApiKey: WRITE_KEY,
      validUntil: START_MS / 1000 + 300,
    });
  });

  it.each(['store_abc123', 'ir_XYZ789'])('mints a token for resource %s', async (resource) => {
    const { provider, getIntegrationToken } = setup({ resource });

    await provider.get();

    expect(getIntegrationToken).toHaveBeenCalledWith(resource);
  });

  it('posts the Vercel token as a bearer token without a body', async () => {
    const { provider, fetch } = setup();

    await provider.get();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(DEFAULT_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns only the credential fields', async () => {
    const { provider, fetch, clock } = setup();
    fetch.mockImplementation(async () => credentialsResponse(clock.ms, 300, { extra: 'ignored' }));

    expect(Object.keys(await provider.get()).sort()).toEqual(['applicationId', 'validUntil', 'writeApiKey']);
  });
});

describe('redirects', () => {
  const LOCATION = 'https://attacker.example.test/steal?token=SECRET-location-91be';

  function redirectResponse(status: number) {
    return new Response('moved', { status, headers: { location: LOCATION } });
  }

  function opaqueRedirect() {
    return { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
  }

  it.each([301, 302, 303, 307, 308])('rejects a %i without following or retrying it', async (status) => {
    const { provider, fetch, sleep } = setup();
    fetch.mockImplementation(async () => redirectResponse(status));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsHttpError);
    expect(error).toMatchObject({
      code: 'http_error',
      status,
      retryable: false,
      message: 'Credentials exchange answered with a redirect',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307])('does not expose the Location of a %i', async (status) => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => redirectResponse(status));

    const error = await rejection(provider.get());

    const text = [String(error), JSON.stringify(error), inspect(error, { depth: 10 })].join('\n');
    expect(text).not.toContain('attacker.example.test');
    expect(text).not.toContain('SECRET-location-91be');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('rejects an opaque redirect without a status', async () => {
    const { provider, fetch, sleep } = setup();
    fetch.mockImplementation(async () => opaqueRedirect());

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(CredentialsHttpError);
    expect(error).toMatchObject({
      code: 'http_error',
      status: undefined,
      retryable: false,
      message: 'Credentials exchange answered with a redirect',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('endpoint', () => {
  const OVERRIDE = 'https://example.test/api/1/vercel/credentials';

  async function requestedUrl() {
    const { provider, fetch } = setup();
    await provider.get();
    return fetch.mock.calls[0]![0];
  }

  it('calls the production endpoint when the override is unset', async () => {
    expect(process.env[ENDPOINT_ENV_VAR]).toBeUndefined();

    await expect(requestedUrl()).resolves.toBe(DEFAULT_ENDPOINT);
  });

  it('calls the production endpoint when the override is empty', async () => {
    vi.stubEnv(ENDPOINT_ENV_VAR, '');

    await expect(requestedUrl()).resolves.toBe(DEFAULT_ENDPOINT);
  });

  it('calls the override when set', async () => {
    vi.stubEnv(ENDPOINT_ENV_VAR, OVERRIDE);

    await expect(requestedUrl()).resolves.toBe(OVERRIDE);
  });

  it('reads the override when the provider is created', async () => {
    vi.stubEnv(ENDPOINT_ENV_VAR, OVERRIDE);
    const { provider, fetch } = setup();
    vi.stubEnv(ENDPOINT_ENV_VAR, undefined);

    await provider.get();

    expect(fetch.mock.calls[0]![0]).toBe(OVERRIDE);
  });

  it.each([
    'http://dashboard.example.test/api/1/vercel/credentials',
    'ftp://dashboard.example.test/credentials',
    'not a url',
    'https://user:pass@dashboard.example.test/credentials',
    'https://user@dashboard.example.test/credentials',
  ])('rejects override %j at creation', (override) => {
    vi.stubEnv(ENDPOINT_ENV_VAR, override);

    expect(() => setup()).toThrow(CredentialsConfigurationError);
  });

  it('does not echo an invalid override', () => {
    vi.stubEnv(ENDPOINT_ENV_VAR, 'http://user:SECRET-pass-5e1d@dashboard.example.test/credentials');

    let error: unknown;
    try {
      setup();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CredentialsConfigurationError);
    const text = [String(error), JSON.stringify(error), inspect(error, { depth: 10 })].join('\n');
    expect(text).not.toContain('SECRET-pass-5e1d');
    expect(text).not.toContain('dashboard.example.test');
  });
});

describe('configuration', () => {
  const base: AlgoliaCredentialsProviderOptions = { resource: RESOURCE };

  it.each(['', 'abc', 'store_', 'ir_', 'oac_abc', 'store_abc-def', 'store_abc/../x', ' store_abc', 'STORE_abc'])(
    'rejects resource %j',
    (resource) => {
      expect(() => createAlgoliaCredentialsProvider({ ...base, resource })).toThrow(CredentialsConfigurationError);
    },
  );

  it('needs only a resource', () => {
    expect(() => createAlgoliaCredentialsProvider(base)).not.toThrow();
  });

  it('accepts the largest timer delay as timeoutMs', async () => {
    const { provider } = setup({ timeoutMs: 2_147_483_647 });

    await expect(provider.get()).resolves.toMatchObject({ applicationId: APP_ID });
  });

  it.each<Partial<AlgoliaCredentialsProviderOptions>>([
    { refreshMarginSeconds: -1 },
    { refreshMarginSeconds: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 2_147_483_648 },
    { timeoutMs: Number.MAX_SAFE_INTEGER },
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { fetch: 'fetch' as never },
  ])('rejects %j', (overrides) => {
    expect(() => createAlgoliaCredentialsProvider({ ...base, ...overrides })).toThrow(CredentialsConfigurationError);
  });

  it('exposes a safe configuration error code', () => {
    let error: unknown;
    try {
      createAlgoliaCredentialsProvider({ ...base, resource: 'bad' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'invalid_configuration', retryable: false });
  });
});

describe('malformed responses', () => {
  const validUntil = START_MS / 1000 + 300;

  it.each([
    ['missing applicationId', { writeApiKey: WRITE_KEY, validUntil }],
    ['empty applicationId', { applicationId: '', writeApiKey: WRITE_KEY, validUntil }],
    ['numeric applicationId', { applicationId: 42, writeApiKey: WRITE_KEY, validUntil }],
    ['missing writeApiKey', { applicationId: APP_ID, validUntil }],
    ['empty writeApiKey', { applicationId: APP_ID, writeApiKey: '', validUntil }],
    ['missing validUntil', { applicationId: APP_ID, writeApiKey: WRITE_KEY }],
    ['string validUntil', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: String(validUntil) }],
    ['null validUntil', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: null }],
    ['expired validUntil', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: START_MS / 1000 - 1 }],
    ['validUntil equal to now', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: START_MS / 1000 }],
    ['validUntil more than one hour away', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: START_MS / 1000 + 3601 }],
    ['validUntil far in the future', { applicationId: APP_ID, writeApiKey: WRITE_KEY, validUntil: 32_503_680_000 }],
    ['array body', [APP_ID, WRITE_KEY, validUntil]],
    ['null body', null],
  ])('rejects %s without retrying', async (_name, body) => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => jsonResponse(body));

    const error = await rejection(provider.get());

    expect(error).toBeInstanceOf(InvalidCredentialsResponseError);
    expect(error).toMatchObject({ code: 'invalid_response', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts credentials valid for exactly one hour', async () => {
    const { provider, fetch, clock } = setup();
    fetch.mockImplementation(async () => credentialsResponse(clock.ms, 3600));

    await expect(provider.get()).resolves.toMatchObject({ validUntil: START_MS / 1000 + 3600 });
  });

  it('rejects a non-finite validUntil', async () => {
    const { provider, fetch } = setup();
    const body = `{"applicationId":"${APP_ID}","writeApiKey":"${WRITE_KEY}","validUntil":1e400}`;
    fetch.mockImplementation(async () => new Response(body, { status: 200 }));

    await expect(provider.get()).rejects.toBeInstanceOf(InvalidCredentialsResponseError);
  });

  it.each(['not json', '', '<html>oops</html>'])('rejects non-JSON body %j', async (body) => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => new Response(body, { status: 200 }));

    await expect(provider.get()).rejects.toBeInstanceOf(InvalidCredentialsResponseError);
  });
});
