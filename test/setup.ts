import { beforeEach, vi } from 'vitest';
import { ENDPOINT_ENV_VAR } from './helpers.js';

beforeEach(() => {
  vi.stubEnv(ENDPOINT_ENV_VAR, undefined);
});
