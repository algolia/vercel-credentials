import { vi } from 'vitest';
import { createAlgoliaCredentialsProvider, type AlgoliaCredentialsProviderOptions, type Fetch } from '../src/index.js';

export const RESOURCE = 'store_abc123';
export const DEFAULT_ENDPOINT = 'https://dashboard.algolia.com/api/1/vercel/credentials';
export const ENDPOINT_ENV_VAR = 'ALGOLIA_VERCEL_CREDENTIALS_URL';
export const TOKEN = 'vercel-resource-token';
export const APP_ID = 'APPID123';
export const WRITE_KEY = 'write-api-key';
export const START_MS = 1_700_000_000_000;

export class VercelOidcTokenError extends Error {
  override name = 'VercelOidcTokenError';

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function errorResponse(status: number, code: string, message = 'error', headers: Record<string, string> = {}) {
  return jsonResponse({ error: { code, message } }, status, headers);
}

export function setup(options: Partial<AlgoliaCredentialsProviderOptions> = {}) {
  const clock = { ms: START_MS };
  const now = () => clock.ms;
  const sleep = vi.fn(async (ms: number) => {
    clock.ms += ms;
  });
  const getIntegrationToken = vi.fn(async (_resource: string) => TOKEN);
  const fetch = vi.fn<Fetch>(async () => credentialsResponse(clock.ms));
  const provider = createAlgoliaCredentialsProvider({
    resource: RESOURCE,
    getIntegrationToken,
    fetch,
    now,
    sleep,
    ...options,
  });
  return { provider, clock, sleep, getIntegrationToken, fetch };
}

export function credentialsResponse(nowMs: number, lifetimeSeconds = 300, overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    applicationId: APP_ID,
    writeApiKey: WRITE_KEY,
    validUntil: Math.floor(nowMs / 1000) + lifetimeSeconds,
    ...overrides,
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}
