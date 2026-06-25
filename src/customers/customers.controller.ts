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
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Customers')
@ApiBearerAuth()
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
  @ApiResponse({ status: 200, description: 'Paginated customer list' })
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
  @ApiResponse({ status: 200, description: 'Customer detail + job history' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
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
  ) {
    return this.customersService.getCustomerDetail(user, id);
  }
}
