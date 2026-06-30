import { describe, it, expect } from 'bun:test';
import {
  retryWithBackoff,
  extractHttpStatus,
  isRetryableHttpStatus,
} from '../../src/core/llm-client/retry.js';
import { LlmError } from '../../src/core/llm-client/client.js';

describe('retryWithBackoff', () => {
  it('succeeds on first try', async () => {
    let calls = 0;
    const result = await retryWithBackoff(() => {
      calls++;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on transient http errors', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) throw LlmError.Http('Service unavailable');
        return 'ok';
      },
      5,
      { signal: new AbortController().signal },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry on non-transient errors', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw LlmError.Api('Bad input');
        },
        3,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('Bad input');
    expect(calls).toBe(1);
  });

  it('does not retry on cancelled errors', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw LlmError.Cancelled('cancelled');
        },
        3,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('throws original error after exhausting retries', async () => {
    await expect(
      retryWithBackoff(
        () => Promise.reject(LlmError.Http('fail')),
        3,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('fail');
  });

  it('throws immediately when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryWithBackoff(
        () => Promise.resolve('ok'),
        3,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('honours cancellation during delay', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retryWithBackoff(
      () => {
        calls++;
        if (calls === 1) {
          setTimeout(() => controller.abort(), 10);
          throw LlmError.Http('fail');
        }
        return 'ok';
      },
      3,
      { signal: controller.signal },
    );
    await expect(promise).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('limits retries when count specified', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw LlmError.Http('fail');
        },
        2,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe('extractHttpStatus', () => {
  it('extracts status code from HTTP error message', () => {
    expect(extractHttpStatus('HTTP 500 (body: Internal Server Error)')).toBe(
      500,
    );
    expect(extractHttpStatus('HTTP 429 (body: Too Many Requests)')).toBe(429);
    expect(extractHttpStatus('HTTP 200')).toBe(200);
  });

  it('returns null for non-HTTP messages', () => {
    expect(extractHttpStatus('Bad input')).toBeNull();
    expect(extractHttpStatus('Timeout')).toBeNull();
    expect(extractHttpStatus('')).toBeNull();
  });
});

describe('isRetryableHttpStatus', () => {
  it('retries on 5xx server errors', () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it('retries on 429 rate limiting', () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it('retries on 3xx redirects', () => {
    expect(isRetryableHttpStatus(301)).toBe(true);
    expect(isRetryableHttpStatus(302)).toBe(true);
    expect(isRetryableHttpStatus(399)).toBe(true);
  });

  it('does not retry on 4xx client errors', () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('does not retry on 2xx or 1xx', () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(201)).toBe(false);
  });
});

describe('retryWithBackoff - HTTP status retry', () => {
  it('retries on retryable HTTP status codes via LlmError.Api', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3)
          throw LlmError.Api('HTTP 500 (body: Internal Server Error)');
        return 'ok';
      },
      5,
      { signal: new AbortController().signal },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry on non-retryable HTTP status codes', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw LlmError.Api('HTTP 400 (body: Bad Request)');
        },
        3,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('exhausts retries and throws', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw LlmError.Http('fail');
        },
        2,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('fail');
    expect(calls).toBe(2);
  });
});
