import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiQuery,
  getSchemaPath,
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { CustomersPageQueryDto } from './dto/customers-page-query.dto';
import { GetCustomerDetailQueryDto } from './dto/get-customer-detail-query.dto';
import { CustomerDetailResponseDto } from './dto/customer-detail-response.dto';
import { CustomerListItemDto } from './dto/customer-list-item.dto';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';

@ApiTags('Customers')
@ApiBearerAuth()
@ApiExtraModels(PaginatedResponse, CustomerListItemDto)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @Can('customer.write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a customer for the company' })
  @ApiResponse({ status: 201, description: 'Customer created' })
  @ApiResponse({ status: 400, description: 'Company not set up' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 409, description: 'Duplicate phone number' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  createCustomer(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customersService.createCustomer(user, dto);
  }

  @Get()
  @Can('customer.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "List & search the owner's customers (cursor-paginated, page size 50)",
  })
  // PaginatedResponse<T> is generic and there is no swagger CLI plugin, so the
  // item type can't go in `type:` — the allOf composition below documents the
  // envelope with `data` items typed as CustomerListItemDto (structured-address
  // fields + jobCount/lastJobDate).
  @ApiResponse({
    status: 200,
    description: 'Paginated customer list',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponse) },
        {
          properties: {
            data: {
              type: 'array',
              items: { $ref: getSchemaPath(CustomerListItemDto) },
            },
          },
        },
      ],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed cursor',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  listCustomers(
    @CurrentUser() user: RequestUser,
    @Query() query: ListCustomersQueryDto,
  ) {
    return this.customersService.listCustomers(user, query);
  }

  // NOTE: this route and `:id` below it must stay below the parameterless
  // `@Get()` list route above — `:id` is a catch-all that would otherwise
  // shadow `GET /customers` (and would swallow `/page` too).
  @Get('page')
  @Can('customer.read')
  @HttpCode(HttpStatus.OK)
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 10 })
  @ApiQuery({ name: 'search', required: false, example: 'priya' })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: ['all', 'new', 'single', 'repeat'],
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: [
      'created_new',
      'created_old',
      'name_az',
      'name_za',
      'recent_activity',
    ],
  })
  @ApiOperation({
    summary:
      "One page of the company's customers, filtered and sorted over the customers_overview view. `total` follows the filters; `stats` counts the whole company regardless of them (disjoint buckets: new = 0 jobs, single = 1, repeat = 2+). A page past the end answers empty rows with the honest total — it does NOT clamp to the last page the way /members/page does; the console's pager never asks for one.",
  })
  listPaged(
    @CurrentUser() user: RequestUser,
    @Query() query: CustomersPageQueryDto,
  ) {
    return this.customersService.getCustomersPage(user, query);
  }

  // NOTE: `:id` must stay below the parameterless `@Get()` list route above —
  // it is a catch-all that would otherwise shadow `GET /customers`.
  @Get(':id')
  @Can('customer.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a customer profile with paginated job history',
  })
  @ApiResponse({
    status: 200,
    description: 'Customer detail + job history',
    type: CustomerDetailResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Company not set up, malformed id, or malformed/foreign cursor',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'Customer not found (or other tenant)',
  })
  getCustomerDetail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GetCustomerDetailQueryDto,
  ) {
    return this.customersService.getCustomerDetail(user, id, query.cursor);
  }

  // Mirrors the GET ':id' shape above (ParseUUIDPipe at the edge, permission-gated).
  @Patch(':id')
  @Can('customer.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update the mutable fields of a customer (phone/country code immutable)',
  })
  @ApiResponse({ status: 200, description: 'Customer updated' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up, malformed id, or nothing to update',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'Customer not found (or other tenant)',
  })
  @ApiResponse({ status: 422, description: 'Validation error' })
  updateCustomer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.updateCustomer(user, id, dto);
  }
}
