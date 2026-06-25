import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ErrorCode } from '../enums/error-code.enum';

const mockReply = {
  status: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
};

const createMockHost = (reply = mockReply) => ({
  switchToHttp: () => ({
    getResponse: () => reply,
  }),
});

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.clearAllMocks();
  });

  it('returns correct shape for UnauthorizedException', () => {
    const exception = new UnauthorizedException({
      error_code: ErrorCode.UNAUTHORIZED,
      message: 'Missing token',
    });

    filter.catch(exception, createMockHost() as never);

    expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.UNAUTHORIZED,
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Missing token',
      }),
    );
  });

  it('returns correct shape for ForbiddenException', () => {
    const exception = new ForbiddenException({
      error_code: ErrorCode.FORBIDDEN,
      message: 'Insufficient permissions',
    });

    filter.catch(exception, createMockHost() as never);

    expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.FORBIDDEN,
        error_code: ErrorCode.FORBIDDEN,
      }),
    );
  });

  it('returns correct shape for NotFoundException (maps to RESOURCE_NOT_FOUND)', () => {
    const exception = new NotFoundException('Resource not found');

    filter.catch(exception, createMockHost() as never);

    expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
      }),
    );
  });

  it('returns 500 with INTERNAL_SERVER_ERROR for unexpected errors', () => {
    const exception = new Error('Something broke');

    filter.catch(exception, createMockHost() as never);

    expect(mockReply.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      }),
    );
  });

  it('forwards extra structured fields (e.g. currentStep) into the response body', () => {
    const exception = new HttpException(
      {
        error_code: ErrorCode.INVALID_WORKFLOW_STEP,
        message: 'Invalid workflow step transition',
        currentStep: 'on_my_way',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );

    filter.catch(exception, createMockHost() as never);

    expect(mockReply.status).toHaveBeenCalledWith(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error_code: ErrorCode.INVALID_WORKFLOW_STEP,
        message: 'Invalid workflow step transition',
        currentStep: 'on_my_way',
      }),
    );
  });

  it('does not add extra keys for ordinary error_code/message exceptions', () => {
    const exception = new ForbiddenException({
      error_code: ErrorCode.FORBIDDEN,
      message: 'Forbidden',
    });

    filter.catch(exception, createMockHost() as never);

    const sentBody = mockReply.send.mock.calls[0][0] as Record<string, unknown>;
    // Only the canonical keys (plus the dev-only stack) — no business-field
    // leakage from the passthrough.
    const keys = Object.keys(sentBody).filter((k) => k !== 'stack');
    expect(keys.sort()).toEqual(['error_code', 'message', 'statusCode'].sort());
  });

  it("strips Nest's default 'error' label (e.g. ValidationPipe) from the body", () => {
    // ValidationPipe throws with { statusCode, message: string[], error: '...' }.
    const exception = new HttpException(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: ['step must be a valid enum value'],
        error: 'Unprocessable Entity',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );

    filter.catch(exception, createMockHost() as never);

    const sentBody = mockReply.send.mock.calls[0][0] as Record<string, unknown>;
    // The default 'error' label must NOT leak into our canonical envelope.
    expect(sentBody['error']).toBeUndefined();
    expect(sentBody).toEqual(
      expect.objectContaining({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error_code: ErrorCode.VALIDATION_ERROR,
      }),
    );
  });

  it('never exposes stack trace in production', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';

    const exception = new Error('Something broke');
    filter.catch(exception, createMockHost() as never);

    const sentBody = mockReply.send.mock.calls[0][0] as Record<string, unknown>;
    expect(sentBody['stack']).toBeUndefined();

    process.env['NODE_ENV'] = originalEnv;
  });
});
