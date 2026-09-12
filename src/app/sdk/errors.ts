export interface VentureApiErrorDetails {
  status: number | null;
  code: string;
  message: string;
  trace?: unknown;
}

export class VentureApiError extends Error {
  public readonly status: number | null;
  public readonly code: string;
  public readonly trace?: unknown;

  constructor(details: VentureApiErrorDetails) {
    super(details.message);
    this.name = 'VentureApiError';
    this.status = details.status;
    this.code = details.code;
    this.trace = details.trace;
    Object.setPrototypeOf(this, VentureApiError.prototype);
  }
}

