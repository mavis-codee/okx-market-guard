export class ValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class OkxApiError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly hint?: string;
  constructor(params: { code: string; msg: string; httpStatus?: number; hint?: string }) {
    const hint = params.hint ?? hintFor(params.code, params.httpStatus);
    const parts = [`OKX error ${params.code}: ${params.msg || 'unknown'}`];
    if (hint) parts.push(`Hint: ${hint}`);
    super(parts.join('. '));
    this.name = 'OkxApiError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.hint = hint;
  }
}

export class SafetyError extends Error {
  readonly code = 'SAFETY';
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

function hintFor(code: string, httpStatus?: number): string | undefined {
  if (httpStatus === 429 || code === '50008') {
    return 'OKX rate limit hit. This client already throttles; wait a moment and retry.';
  }
  if (httpStatus === 404 || code === '404') {
    return 'Endpoint or instrument not found. Check instId (SPOT uses BTC-USDT; perpetuals use BTC-USDT-SWAP).';
  }
  switch (code) {
    case '50001':
      return 'Operation not supported. This tool only calls public read-only market endpoints.';
    case '50004':
    case '50017':
      return 'Request timed out. Retry with a smaller limit or later.';
    case '50011':
      return 'User does not exist. Public market data does not need a user; check the request path.';
    case '50013':
      return 'OKX system busy. Retry shortly.';
    case '51001':
      return 'instId is empty. Provide an instrument ID such as BTC-USDT.';
    case '51002':
      return 'instId is invalid for this endpoint. SPOT example: BTC-USDT. SWAP example: BTC-USDT-SWAP.';
    case '51006':
      return 'Size/limit parameter is invalid. Check the allowed range.';
    default:
      return undefined;
  }
}
