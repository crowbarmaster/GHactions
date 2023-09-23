/* eslint-disable @typescript-eslint/no-var-requires */
import {describe, expect, it, vitest as jest, beforeEach, afterEach} from 'vitest';
import {main} from '../src/main';

describe('main handler', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('throws an error when "repo_token" is not supplied', async () => {
    await expect(main()).rejects.toThrow('Input required and not supplied: repo_token');
  });
});
