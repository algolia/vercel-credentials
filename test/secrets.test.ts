import { inspect } from 'node:util';
import { IntegrationTokenError } from '@vercel/integrations';
import { describe, expect, it } from 'vitest';
import { AlgoliaCredentialsError } from '../src/index.js';
import { APP_ID, errorResponse, jsonResponse, rejection, setup, START_MS } from './helpers.js';

const SECRET_TOKEN = 'eyJSECRET.vercel-token-7f3a9c';
const SECRET_KEY = 'SECRET-write-key-0d81e2';
const SECRET_BODY = 'SECRET-body-detail-c4b6aa';
const SECRETS = [SECRET_TOKEN, SECRET_KEY, SECRET_BODY];

function exposedText(error: unknown): string {
  const record = error as { message?: unknown; cause?: unknown };
  return [
    String(error),
    String(record.message),
    JSON.stringify(error),
    inspect(error, { depth: 10 }),
    String(record.cause),
    inspect(record.cause, { depth: 10 }),
  ].join('\n');
}

type Scenario = (context: ReturnType<typeof setup>) => void;

const scenarios: Record<string, Scenario> = {
  'expired credentials': ({ fetch }) => {
    fetch.mockImplementation(async () =>
      jsonResponse({ applicationId: APP_ID, writeApiKey: SECRET_KEY, validUntil: START_MS / 1000 - 1 }),
    );
  },
  'invalid validUntil': ({ fetch }) => {
    fetch.mockImplementation(async () =>
      jsonResponse({ applicationId: APP_ID, writeApiKey: SECRET_KEY, validUntil: SECRET_BODY }),
    );
  },
  'non-JSON success body': ({ fetch }) => {
    fetch.mockImplementation(async () => new Response(`${SECRET_KEY} ${SECRET_BODY}`, { status: 200 }));
  },
  '401 with secret message': ({ fetch }) => {
    fetch.mockImplementation(async () => errorResponse(401, 'unauthorized', `${SECRET_TOKEN} ${SECRET_BODY}`));
  },
  '404 with secret code': ({ fetch }) => {
    fetch.mockImplementation(async () => errorResponse(404, SECRET_BODY, SECRET_KEY));
  },
  '503 with secret body after retries': ({ fetch }) => {
    fetch.mockImplementation(async () =>
      jsonResponse({ error: { code: 'service_unavailable', message: SECRET_BODY, token: SECRET_TOKEN } }, 503),
    );
  },
  '500 with non-JSON body': ({ fetch }) => {
    fetch.mockImplementation(async () => new Response(`${SECRET_BODY} ${SECRET_TOKEN}`, { status: 500 }));
  },
  '302 with secret Location and body': ({ fetch }) => {
    fetch.mockImplementation(
      async () =>
        new Response(SECRET_BODY, { status: 302, headers: { location: `https://example.test/?t=${SECRET_TOKEN}` } }),
    );
  },
  'network error mentioning the token': ({ fetch }) => {
    fetch.mockRejectedValue(new TypeError(`fetch failed: Bearer ${SECRET_TOKEN}`, { cause: SECRET_BODY }));
  },
  'Vercel mint failure': ({ getIntegrationToken }) => {
    getIntegrationToken.mockRejectedValue(
      new IntegrationTokenError({
        status: 403,
        code: 'forbidden',
        message: `${SECRET_TOKEN} ${SECRET_BODY}`,
        metadata: { token: SECRET_TOKEN },
      }),
    );
  },
};

describe('secret leakage', () => {
  it.each(Object.entries(scenarios))('exposes no secret on %s', async (_name, arrange) => {
    const context = setup();
    context.getIntegrationToken.mockResolvedValue(SECRET_TOKEN);
    arrange(context);

    const error = await rejection(context.provider.get());

    expect(error).toBeInstanceOf(AlgoliaCredentialsError);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const text = exposedText(error);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('sends the token only in the Authorization header', async () => {
    const context = setup();
    context.getIntegrationToken.mockResolvedValue(SECRET_TOKEN);

    await context.provider.get();

    const [url, init] = context.fetch.mock.calls[0]!;
    expect(url).not.toContain(SECRET_TOKEN);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET_TOKEN}` });
  });
});
