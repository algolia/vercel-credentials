import { resolveConfig, type ProviderConfig } from './config.js';
import { exchangeToken } from './exchange.js';
import { attemptTimeout, deadlineFrom, withRetries } from './retry.js';
import { mintResourceToken } from './token.js';
import type { AlgoliaCredentials, AlgoliaCredentialsProvider, AlgoliaCredentialsProviderOptions } from './types.js';

interface CacheEntry {
  credentials: AlgoliaCredentials;
  refreshAtMs: number;
}

/**
 * Creates a provider bound to one Vercel Marketplace resource. Credentials are cached in memory
 * by this provider only and renewed shortly before `validUntil`. Calls
 * `https://dashboard.algolia.com/api/1/vercel/credentials`, or the HTTPS URL in
 * `ALGOLIA_VERCEL_CREDENTIALS_URL` when set. Throws `CredentialsConfigurationError` when the
 * options or that URL are invalid.
 */
export function createAlgoliaCredentialsProvider(options: AlgoliaCredentialsProviderOptions): AlgoliaCredentialsProvider {
  const config = resolveConfig(options);
  let cached: CacheEntry | undefined;
  let inFlight: Promise<AlgoliaCredentials> | undefined;

  async function refresh(): Promise<AlgoliaCredentials> {
    cached = undefined;
    const credentials = await requestCredentials(config);
    cached = cacheEntry(credentials, config);
    return credentials;
  }

  function get(): Promise<AlgoliaCredentials> {
    if (cached && config.now() < cached.refreshAtMs) return Promise.resolve(cached.credentials);
    inFlight ??= refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return { get };
}

function requestCredentials(config: ProviderConfig): Promise<AlgoliaCredentials> {
  return withRetries(config, deadlineFrom(config), (timeoutMs) => mintAndExchange(config, config.now() + timeoutMs));
}

async function mintAndExchange(config: ProviderConfig, attemptDeadline: number): Promise<AlgoliaCredentials> {
  const token = await mintResourceToken(config, attemptTimeout(config, attemptDeadline));
  return exchangeToken(config, token, attemptTimeout(config, attemptDeadline));
}

function cacheEntry(credentials: AlgoliaCredentials, config: ProviderConfig): CacheEntry {
  const expiresAtMs = credentials.validUntil * 1000;
  const lifetimeMs = expiresAtMs - config.now();
  const marginMs = Math.max(0, Math.min(config.refreshMarginMs, lifetimeMs / 2));
  return { credentials, refreshAtMs: expiresAtMs - marginMs };
}
