import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PartnersService } from './partners.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private partners: PartnersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException({
        error: 'MISSING_API_KEY',
        message: 'x-api-key header is required',
      });
    }

    const partner = await this.partners.findByApiKey(apiKey);
    if (!partner) {
      throw new UnauthorizedException({
        error: 'INVALID_API_KEY',
        message: 'API key not recognized',
      });
    }

    req.partner = partner;
    return true;
  }
}