import 'reflect-metadata';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UpdateEmploymentDto } from '../src/members/dto/update-employment.dto';

/**
 * Writes the employment form's contract for the FE: just the
 * UpdateEmploymentDto schema from the same decorators the API validates with.
 * A minimal module, so this needs no database, no server and no auth — the
 * DTO is the source of truth, and the FE generator reads the JSON.
 *
 * Run from the repo root: `bun run contract:employment`.
 */
@Controller('contract')
class ContractController {
  @Post('employment')
  save(@Body() body: UpdateEmploymentDto): UpdateEmploymentDto {
    return body;
  }
}

@Module({ controllers: [ContractController] })
class ContractModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ContractModule,
    new FastifyAdapter(),
    { logger: false },
  );
  const config = new DocumentBuilder()
    .setTitle('Fenzit contract')
    .setDescription('Generated for the FE employment form; not a served API.')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const schema = document.components?.schemas?.['UpdateEmploymentDto'];
  if (schema === undefined) {
    throw new Error(
      'UpdateEmploymentDto is missing from the Swagger document.',
    );
  }
  const directory = join(process.cwd(), 'contracts');
  mkdirSync(directory, { recursive: true });
  const out = join(directory, 'employment.schema.json');
  writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
  await app.close();
  console.log(`Wrote ${out}`);
}

void main();
