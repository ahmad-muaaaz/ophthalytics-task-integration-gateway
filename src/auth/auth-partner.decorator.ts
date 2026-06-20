import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const AuthPartner = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    return ctx.switchToHttp().getRequest().partner;
  },
);
