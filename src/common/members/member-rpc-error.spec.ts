import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { memberRpcException } from './member-rpc-error';

describe('memberRpcException', () => {
  it('maps the staff-number refusal to 400 with its own code', () => {
    const err = memberRpcException({
      code: 'PT400',
      hint: 'PLATFORM_STAFF_NOT_MEMBER',
    });
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err?.getResponse()).toMatchObject({
      error_code: 'PLATFORM_STAFF_NOT_MEMBER',
    });
  });

  it('maps any other 400 to a generic validation error', () => {
    const err = memberRpcException({ code: 'PT400', hint: 'SOMETHING_NEW' });
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err?.getResponse()).toMatchObject({ error_code: 'VALIDATION_ERROR' });
  });

  it('maps a 400 with no hint to a validation error, never a staff refusal', () => {
    const err = memberRpcException({ code: 'PT400', hint: null });
    expect(err?.getResponse()).toMatchObject({ error_code: 'VALIDATION_ERROR' });
  });

  it('maps 403 to forbidden', () => {
    const err = memberRpcException({ code: 'PT403', hint: 'FORBIDDEN' });
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err?.getResponse()).toMatchObject({ error_code: 'FORBIDDEN' });
  });

  it('maps 404 to resource not found', () => {
    const err = memberRpcException({ code: 'PT404', hint: 'RESOURCE_NOT_FOUND' });
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err?.getResponse()).toMatchObject({
      error_code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('maps a last-admin refusal to 409 with its own code', () => {
    const err = memberRpcException({ code: 'PT409', hint: 'LAST_ADMIN' });
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.getResponse()).toMatchObject({ error_code: 'LAST_ADMIN' });
  });

  it('maps an already-in-your-team clash to 409 with its own code', () => {
    const err = memberRpcException({ code: 'PT409', hint: 'ALREADY_IN_TEAM' });
    expect(err?.getResponse()).toMatchObject({ error_code: 'ALREADY_IN_TEAM' });
  });

  it('maps any other 409 (a person already in another company) to a duplicate error', () => {
    const err = memberRpcException({ code: 'PT409', hint: 'DUPLICATE_RESOURCE' });
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.getResponse()).toMatchObject({
      error_code: 'DUPLICATE_RESOURCE',
    });
  });

  it('maps a 409 with no hint to a duplicate error, not to last-admin', () => {
    const err = memberRpcException({ code: 'PT409', hint: null });
    expect(err?.getResponse()).toMatchObject({
      error_code: 'DUPLICATE_RESOURCE',
    });
  });

  it.each([
    ['a plain database error', { code: '23505', hint: null }],
    ['a database error with no code', { hint: 'LAST_ADMIN' }],
    ['an unknown PT status', { code: 'PT500', hint: null }],
  ])(
    'returns null for %s, so the caller answers 500 and does not leak it',
    (_name, error) => {
      expect(memberRpcException(error)).toBeNull();
    },
  );
});
