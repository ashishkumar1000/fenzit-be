import { BadRequestException, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ReportDefinition } from './report-definition';
import { technicianJobActivityDefinition } from './technician-job-activity.definition';

/**
 * The report-type registry (FR9). Definitions register here; the API layer
 * resolves `reportType` → definition for params validation, and the generation
 * engine (story 12-3) resolves the same registry to fetch data and build the
 * document. Adding a report type = one definition file + one entry in the
 * constructor below — zero engine/API changes (NFR6).
 */
@Injectable()
export class ReportRegistry {
  private readonly definitions = new Map<string, ReportDefinition>();

  constructor() {
    this.register(technicianJobActivityDefinition);
  }

  register(definition: ReportDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Report type '${definition.type}' is already registered`);
    }
    this.definitions.set(definition.type, definition);
  }

  get(type: string): ReportDefinition | undefined {
    return this.definitions.get(type);
  }

  list(): ReportDefinition[] {
    return [...this.definitions.values()];
  }

  /** Resolves a requested type, rejecting unknown ids with a 400. */
  getOrThrow(type: string): ReportDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: `Unknown report type '${type}'`,
      });
    }
    return definition;
  }
}
