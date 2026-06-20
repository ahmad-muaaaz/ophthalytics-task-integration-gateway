import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateJobDto } from './create-job.dto';

@Injectable()
export class ParseMetadataPipe implements PipeTransform {
  async transform(value: string) {
    if (!value) {
      throw new BadRequestException({
        error: 'INVALID_METADATA',
        message: 'metadata field is required',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException({
        error: 'INVALID_METADATA',
        message: 'metadata must be valid JSON',
      });
    }

    const dto = plainToInstance(CreateJobDto, parsed);
    const errors = await validate(dto);
    if (errors.length > 0) {
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      throw new BadRequestException({
        error: 'INVALID_METADATA',
        message: messages.join('; '),
      });
    }

    return parsed as CreateJobDto & Record<string, unknown>;
  }
}
