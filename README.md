# @algolia/vercel-credentials

Short-lived Algolia write credentials for a Vercel Marketplace resource. Server-side only.

The provider mints a Vercel resource token with `@vercel/integrations`, exchanges it for an Algolia application ID and write API key valid for at most five minutes, caches them in memory and renews them before they expire.

## Install

```sh
npm install @algolia/vercel-credentials
```

Requires Node.js 20 or later. ESM only. Node.js runtime only, not the Edge runtime.

## Vercel Marketplace setup

1. Install the Algolia integration from the Vercel Marketplace and create a resource.
2. Connect the resource to your project for every environment that writes to Algolia, including `development`.
3. Copy the resource ID (`store_…` or `ir_…`) from the resource page.
4. For local development, link the project and pull its environment so `@vercel/integrations` can read the OIDC token:

   ```sh
   vercel link
   vercel env pull
   ```

   Re-run `vercel env pull` when the local OIDC token expires (about 12 hours).

## Usage

```ts
import { algoliasearch } from 'algoliasearch';
import { createAlgoliaCredentialsProvider } from '@algolia/vercel-credentials';

const credentials = createAlgoliaCredentialsProvider({
  resource: 'store_abc123',
});

export async function saveProduct(product: Record<string, unknown>) {
  const { applicationId, writeApiKey } = await credentials.get();
  const client = algoliasearch(applicationId, writeApiKey);
  return client.saveObject({ indexName: 'products', body: product });
}
```

- Call `get()` before each write operation. It returns cached credentials until they are about to expire.
- Create the Algolia client from the returned credentials, or recreate it when `writeApiKey` changes. Never keep a client built from an expired key.
- Create one provider per resource at module scope so its cache is reused across requests.
- The returned `applicationId` is the resource's application. If the app also searches with a separate search key, check that it targets the same application.
- Never import this package in browser code and never send `writeApiKey` to the client. Search keeps using a search-only API key.

## Endpoint

The provider calls `https://dashboard.algolia.com/api/1/vercel/credentials`.

For development or staging, set `ALGOLIA_VERCEL_CREDENTIALS_URL` to another exchange URL, such as a tunnel to a local dashboard:

```sh
ALGOLIA_VERCEL_CREDENTIALS_URL=https://<tunnel-host>/api/1/vercel/credentials
```

- Use an `https:` URL without username or password. Anything else throws `CredentialsConfigurationError` when the provider is created.
- Leave it unset or empty in production.
- The variable is read when the provider is created. Restart the process after changing it.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `resource` | required | Vercel resource ID matching `^(store\|ir)_[A-Za-z0-9]+$`. |
| `refreshMarginSeconds` | `30` | Renew this many seconds before `validUntil`. Capped at half the credential lifetime. |
| `timeoutMs` | `10000` | Timeout of each attempt, Vercel token mint and exchange together. At most `2147483647`. |
| `maxRetries` | `2` | Retries of a transient mint or exchange failure. |
| `getIntegrationToken`, `fetch`, `now`, `sleep` | built-ins | Replacements for tests, not covered by semver. |

Invalid options, or an invalid `ALGOLIA_VERCEL_CREDENTIALS_URL`, throw `CredentialsConfigurationError` when the provider is created.

## Errors

Every error extends `AlgoliaCredentialsError` and exposes `code`, `status` (when an HTTP status is known) and `retryable`.

| Class | `code` | `status` | `retryable` | Meaning |
| --- | --- | --- | --- | --- |
| `CredentialsConfigurationError` | `invalid_configuration` | | no | Invalid provider options or `ALGOLIA_VERCEL_CREDENTIALS_URL`. |
| `VercelTokenError` | `vercel_token_error` | Vercel status | 429/502/503/504, network failure | `getIntegrationToken` failed. `vercelCode` holds Vercel's error code, or `oidc_token_unavailable` when the Vercel OIDC token is missing. |
| `CredentialsHttpError` | `unauthorized` | 401 | no | Vercel resource token is invalid or expired. |
| `CredentialsHttpError` | `not_found` | 404 | no | Resource is not accessible or the exchange is unavailable. |
| `CredentialsHttpError` | `conflict` | 409 | no | Resource is not ready. |
| `CredentialsHttpError` | `service_unavailable` | 503 | yes | Exchange temporarily unavailable. |
| `CredentialsHttpError` | `internal_error` | 500 | no | Exchange failed. |
| `CredentialsHttpError` | `http_error` | any other, none for an opaque redirect | 429/502/503/504 | Unexpected status, redirect or unknown backend code. |
| `InvalidCredentialsResponseError` | `invalid_response` | | no | Malformed or expired credentials, or valid for more than one hour. |
| `CredentialsTimeoutError` | `timeout` | | yes, except a mint timeout | An attempt or the whole call ran out of time. |
| `CredentialsNetworkError` | `network_error` | | yes | The request failed before a response. |

`retryable: yes` errors are surfaced only after the provider's own retries are exhausted.

## Expiry and caching

- `validUntil` is a Unix timestamp in seconds, at most five minutes after issuance. Credentials valid for more than one hour are rejected with `InvalidCredentialsResponseError`.
- Credentials are cached in memory per provider instance. Two providers never share credentials.
- Cached credentials are reused while `validUntil` is later than now plus the refresh margin.
- Concurrent `get()` calls share one refresh. A failed refresh rejects every waiting call, and the next call starts a new one.
- Expired credentials, or credentials inside the refresh margin, are never returned, even when renewal fails.
- Each attempt mints the Vercel token, then exchanges it, within `timeoutMs`.
- Retried with a short backoff, up to `maxRetries` times:
  - a mint failure with Vercel status 429, 502, 503 or 504, or a network failure without a status;
  - an exchange network error, timeout, 429, 502, 503 or 504. `Retry-After` is honored up to 5 seconds.
- Never retried:
  - a missing Vercel OIDC token (`oidc_token_unavailable`), any other mint failure, or an empty token;
  - a mint timeout: `@vercel/integrations` shares its in-flight mint request, so a retry would only wait on the same call;
  - exchange 400, 401, 403, 404, 409, 500, redirects and invalid responses.
- A `get()` takes at most `timeoutMs * (maxRetries + 1) + 5000 * maxRetries` milliseconds, its overall deadline: 40 seconds with the defaults.
- `@vercel/integrations` caches the Vercel token and drops a failed mint, so a retry after a failure mints again. This package adds no second token cache.

## Security

- Use on the server only: Vercel Functions, route handlers, server actions, scripts.
- The exchange uses `POST` with `Authorization: Bearer <token>` and requires HTTPS, including for `ALGOLIA_VERCEL_CREDENTIALS_URL`. Redirects are never followed: any 3xx fails with `http_error`, without retry and without exposing the `Location` header.
- Errors never contain the Vercel token, the write key, the override URL, request headers or response bodies. Only known backend error codes are surfaced.
- Anyone who can set `ALGOLIA_VERCEL_CREDENTIALS_URL` receives the Vercel resource token. Never set it from untrusted input.
- The package never logs.
- `JSON.stringify`, `util.inspect` and `console.log` print the returned `writeApiKey` as `[redacted]`. A copy made with spread or `Object.assign` is not redacted.
- Credentials are kept in memory only, never written to disk.

## Release

First release, `0.1.0` is already the version in `package.json`:

1. Check that `CHANGELOG.md` has the `0.1.0` entry on `main`.
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.

Later releases:

1. Commit the new version's entry in `CHANGELOG.md` on `main`.
2. Bump the version: `npm version <patch|minor|major>`.
3. Push the commit and tag: `git push --follow-tags`.

The `Publish` workflow checks that the tagged commit is on `main` and matches the `package.json` version, builds and tests the package, then publishes the tarball to npm with provenance through npm trusted publishing, from the `npm` environment.
