import { describe, expect, it } from 'vitest';
import { CredentialsHttpError } from '../src/index.js';
import { credentialsResponse, deferred, errorResponse, setup, START_MS } from './helpers.js';

describe('caching', () => {
  it('reuses cached credentials', async () => {
    const { provider, fetch, getIntegrationToken } = setup();

    const first = await provider.get();
    const second = await provider.get();

    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the 30 second margin is reached', async () => {
    const { provider, fetch, clock } = setup();
    await provider.get();

    clock.ms = START_MS + 269_999;
    await provider.get();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.ms = START_MS + 270_000;
    const refreshed = await provider.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refreshed.validUntil).toBe(Math.floor(clock.ms / 1000) + 300);
  });

  it('honors a custom refresh margin', async () => {
    const { provider, fetch, clock } = setup({ refreshMarginSeconds: 60 });
    await provider.get();

    clock.ms = START_MS + 239_999;
    await provider.get();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.ms = START_MS + 240_000;
    await provider.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shrinks the margin to half of a short lifetime', async () => {
    const { provider, fetch, clock } = setup();
    fetch.mockImplementation(async () => credentialsResponse(clock.ms, 40));
    await provider.get();

    clock.ms = START_MS + 19_999;
    await provider.get();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.ms = START_MS + 20_000;
    await provider.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never returns expired credentials when the refresh fails', async () => {
    const { provider, fetch, clock } = setup();
    await provider.get();
    fetch.mockImplementation(async () => errorResponse(401, 'unauthorized'));

    clock.ms = START_MS + 301_000;

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsHttpError);
  });

  it('does not return credentials inside the margin when the refresh fails', async () => {
    const { provider, fetch, clock } = setup();
    await provider.get();
    fetch.mockImplementation(async () => errorResponse(409, 'conflict'));

    clock.ms = START_MS + 290_000;

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialsHttpError);
  });
});

describe('concurrency', () => {
  it('shares one mint and one exchange between concurrent calls', async () => {
    const { provider, fetch, getIntegrationToken, clock } = setup();
    const reply = deferred<Response>();
    fetch.mockImplementation(() => reply.promise);

    const calls = [provider.get(), provider.get(), provider.get()];
    await Promise.resolve();
    reply.resolve(credentialsResponse(clock.ms));
    const results = await Promise.all(calls);

    expect(getIntegrationToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('rejects every waiter and clears the in-flight refresh on failure', async () => {
    const { provider, fetch, getIntegrationToken, clock } = setup();
    fetch.mockImplementationOnce(async () => errorResponse(401, 'unauthorized'));

    const results = await Promise.allSettled([provider.get(), provider.get()]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockImplementation(async () => credentialsResponse(clock.ms));
    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(getIntegrationToken).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a failed Vercel mint on the next call', async () => {
    const { provider, getIntegrationToken } = setup();
    getIntegrationToken.mockRejectedValueOnce(new Error('mint failed'));

    await expect(provider.get()).rejects.toThrow();
    await expect(provider.get()).resolves.toMatchObject({ applicationId: 'APPID123' });
    expect(getIntegrationToken).toHaveBeenCalledTimes(2);
  });
});

describe('isolation', () => {
  it('keeps a separate cache per provider', async () => {
    const first = setup({ resource: 'store_first' });
    const second = setup({ resource: 'ir_second', fetch: first.fetch, getIntegrationToken: first.getIntegrationToken });

    await first.provider.get();
    await second.provider.get();
    await first.provider.get();
    await second.provider.get();

    expect(first.fetch).toHaveBeenCalledTimes(2);
    expect(first.getIntegrationToken.mock.calls).toEqual([['store_first'], ['ir_second']]);
  });
});
