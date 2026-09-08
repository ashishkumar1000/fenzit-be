import {
  Controller,
  Post,
  Get,
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
  getSchemaPath,
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { GetCustomerDetailQueryDto } from './dto/get-customer-detail-query.dto';
import { CustomerDetailResponseDto } from './dto/customer-detail-response.dto';
import { CustomerListItemDto } from './dto/customer-list-item.dto';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Customers')
@ApiBearerAuth()
@ApiExtraModels(PaginatedResponse, CustomerListItemDto)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a customer for the owner's tenant" })
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
  @Roles(Role.OWNER)
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

  // NOTE: `:id` must stay below the parameterless `@Get()` list route above —
  // it is a catch-all that would otherwise shadow `GET /customers`.
  @Get(':id')
  @Roles(Role.OWNER)
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
}
