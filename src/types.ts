/**
 * Short-lived Algolia write credentials returned by the exchange endpoint. Frozen. `JSON.stringify`,
 * `util.inspect` and `console.log` print `writeApiKey` as `[redacted]`.
 */
export interface AlgoliaCredentials {
  readonly applicationId: string;
  readonly writeApiKey: string;
  /** Unix timestamp in seconds after which `writeApiKey` stops working. */
  readonly validUntil: number;
}

/** Obtains and renews credentials for one Vercel Marketplace resource. */
export interface AlgoliaCredentialsProvider {
  /** Returns cached credentials, or exchanges a new Vercel resource token when they are about to expire. */
  get(): Promise<AlgoliaCredentials>;
}

export type GetIntegrationToken = (resource: string) => Promise<string>;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Options for {@link createAlgoliaCredentialsProvider}. */
export interface AlgoliaCredentialsProviderOptions {
  /** Vercel resource ID, `store_…` or `ir_…`. */
  resource: string;
  /** Seconds before `validUntil` at which credentials are renewed. Defaults to 30. */
  refreshMarginSeconds?: number;
  /**
   * Timeout of each attempt, Vercel token mint and exchange together, in milliseconds. Defaults to 10000.
   * At most 2147483647.
   */
  timeoutMs?: number;
  /** Retries of a transient mint or exchange failure. Defaults to 2. */
  maxRetries?: number;
  /** Replaces `getIntegrationToken` from `@vercel/integrations`. For tests, not covered by semver. */
  getIntegrationToken?: GetIntegrationToken;
  /** Replaces the global `fetch`. For tests, not covered by semver. */
  fetch?: Fetch;
  /** Replaces `Date.now`, in milliseconds. For tests, not covered by semver. */
  now?: () => number;
  /** Replaces the delay between retries. For tests, not covered by semver. */
  sleep?: (ms: number) => Promise<void>;
}
