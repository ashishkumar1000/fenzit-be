import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { ImportValidateService } from './import-validate.service';
import { ImportCommitService } from './import-commit.service';
import { ValidateImportRowsDto } from './dto/validate-import-rows.dto';
import { CommitImportRowsDto } from './dto/commit-import-rows.dto';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/interfaces/request-user.interface';
import { Can } from '../../common/decorators/can.decorator';

/**
 * Staff-only bulk customer import (SPEC-owner-bulk-customer-import).
 * `@Can('user.manage')` is platform-only, so company owners and employees
 * get 403. Do not add a company permission here: multiple @Can permissions
 * are OR, and a company admin would pass the company one.
 */
@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers/import')
export class ImportController {
  constructor(
    private readonly importValidate: ImportValidateService,
    private readonly importCommit: ImportCommitService,
  ) {}

  @Post('validate')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Validate a staff import sheet (stateless, never writes): per-row values, reasons and duplicate flags',
  })
  @ApiResponse({ status: 200, description: 'Per-row status and summary' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up (no X-Company-Id)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — staff only' })
  @ApiResponse({
    status: 422,
    description:
      'Empty sheet, more than 500 rows, or unsupported defaultCountryCode',
  })
  validate(
    @CurrentUser() user: RequestUser,
    @Body() dto: ValidateImportRowsDto,
  ) {
    return this.importValidate.validate(user, dto);
  }

  @Post('commit')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Commit a staff import sheet: insert new customers, update the customer matched by phone (filled fields only), report failed rows. Replays with the same X-Idempotency-Key return the first answer.',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description:
      '1 to 128 characters with no spaces. Reuse it only to retry the same import.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Batch id, per-row status (created, updated or failed) and summary',
  })
  @ApiResponse({
    status: 400,
    description: 'Company not set up (no X-Company-Id)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — staff only' })
  @ApiResponse({
    status: 422,
    description:
      'Missing or invalid X-Idempotency-Key, empty sheet, more than 500 rows, or unsupported defaultCountryCode',
  })
  @ApiResponse({ status: 500, description: 'Writes or import record failed' })
  commit(
    @CurrentUser() user: RequestUser,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CommitImportRowsDto,
  ) {
    return this.importCommit.commit(
      user,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  /** Missing or malformed key is a 422 with no writes. */
  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !/^\S{1,128}$/.test(value)) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message:
            'This request has no valid request ID. Update the app and try again.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return value;
  }
}
