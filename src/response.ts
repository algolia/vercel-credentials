import {
  BACKEND_ERROR_CODES,
  CredentialsHttpError,
  InvalidCredentialsResponseError,
  type BackendErrorCode,
} from './errors.js';
import type { AlgoliaCredentials } from './types.js';

export function parseCredentials(body: string, nowMs: number): AlgoliaCredentials {
  const data = parseJson(body);
  if (!isRecord(data)) throw new InvalidCredentialsResponseError('Credentials response is not a JSON object');
  const credentials = {
    applicationId: requiredString(data, 'applicationId'),
    writeApiKey: requiredString(data, 'writeApiKey'),
    validUntil: requiredTimestamp(data, 'validUntil'),
  };
  if (credentials.validUntil * 1000 <= nowMs) {
    throw new InvalidCredentialsResponseError('Credentials response is already expired');
  }
  return Object.freeze(credentials);
}

export function httpError(status: number, body: string, retryAfter: string | null, nowMs: number): CredentialsHttpError {
  return new CredentialsHttpError(status, backendErrorCode(body), parseRetryAfter(retryAfter, nowMs));
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

function backendErrorCode(body: string): BackendErrorCode | undefined {
  const data = parseJsonOrUndefined(body);
  const code = isRecord(data) && isRecord(data.error) ? data.error.code : undefined;
  return BACKEND_ERROR_CODES.find((known) => known === code);
}

function requiredString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidCredentialsResponseError(`Credentials response has an invalid ${field}`);
  }
  return value;
}

function requiredTimestamp(data: Record<string, unknown>, field: string): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidCredentialsResponseError(`Credentials response has an invalid ${field}`);
  }
  return value;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidCredentialsResponseError('Credentials response is not valid JSON');
  }
}

function parseJsonOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
