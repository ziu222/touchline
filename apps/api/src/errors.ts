import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}

const codeByStatus: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

type JsonResponse = { status(code: number): { json(body: unknown): void } };

// Every error leaves as { error: { code, message, details? } } (spec mục 8)
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<JsonResponse>();
    if (err instanceof AppError) {
      res.status(err.getStatus()).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      res.status(status).json({ error: { code: codeByStatus[status] ?? `HTTP_${status}`, message: err.message } });
      return;
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  }
}

type SafeParser<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

export function parse<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid request', result.error.issues);
  return result.data;
}

export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
