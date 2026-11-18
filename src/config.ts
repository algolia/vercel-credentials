import { setTimeout as delay } from 'node:timers/promises';
import { getIntegrationToken as vercelGetIntegrationToken } from '@vercel/integrations';
import { CredentialsConfigurationError } from './errors.js';
import type { AlgoliaCredentialsProviderOptions, Fetch, GetIntegrationToken } from './types.js';

const RESOURCE_PATTERN = /^(store|ir)_[A-Za-z0-9]+$/;
const DEFAULT_EXCHANGE_URL = 'https://dashboard.algolia.com/api/1/vercel/credentials';
const EXCHANGE_URL_ENV_VAR = 'ALGOLIA_VERCEL_CREDENTIALS_URL';
const DEFAULT_REFRESH_MARGIN_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;

export interface ProviderConfig {
  resource: string;
  exchangeUrl: string;
  refreshMarginMs: number;
  timeoutMs: number;
  maxRetries: number;
  getIntegrationToken: GetIntegrationToken;
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function resolveConfig(options: AlgoliaCredentialsProviderOptions): ProviderConfig {
  if (typeof options !== 'object' || options === null) {
    throw new CredentialsConfigurationError('Options must be an object');
  }
  return {
    resource: validResource(options.resource),
    exchangeUrl: resolveExchangeUrl(),
    refreshMarginMs: nonNegativeNumber(options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS, 'refreshMarginSeconds') * 1000,
    timeoutMs: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxRetries: nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries'),
    getIntegrationToken: optionalFunction(options.getIntegrationToken, 'getIntegrationToken') ?? defaultGetIntegrationToken,
    fetch: optionalFunction(options.fetch, 'fetch') ?? defaultFetch,
    now: optionalFunction(options.now, 'now') ?? Date.now,
    sleep: optionalFunction(options.sleep, 'sleep') ?? defaultSleep,
  };
}

function validResource(resource: unknown): string {
  if (typeof resource !== 'string' || !RESOURCE_PATTERN.test(resource)) {
    throw new CredentialsConfigurationError('resource must be a Vercel resource ID like store_… or ir_…');
  }
  return resource;
}

function resolveExchangeUrl(): string {
  const override = process.env[EXCHANGE_URL_ENV_VAR];
  return override ? validExchangeUrlOverride(override) : DEFAULT_EXCHANGE_URL;
}

function validExchangeUrlOverride(value: string): string {
  const url = parseUrl(value);
  if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new CredentialsConfigurationError(`${EXCHANGE_URL_ENV_VAR} must be an https URL without credentials`);
  }
  return url.href;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CredentialsConfigurationError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CredentialsConfigurationError(`${name} must be an integer > 0`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CredentialsConfigurationError(`${name} must be an integer >= 0`);
  }
  return value as number;
}

function optionalFunction<T>(value: T | undefined, name: string): T | undefined {
  if (value !== undefined && typeof value !== 'function') {
    throw new CredentialsConfigurationError(`${name} must be a function`);
  }
  return value;
}

function defaultGetIntegrationToken(resource: string): Promise<string> {
  return vercelGetIntegrationToken(resource);
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function defaultSleep(ms: number): Promise<void> {
  return delay(ms);
}
