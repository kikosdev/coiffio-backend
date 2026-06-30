import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { PosUser } from '../guards/pos-scope.guard';

export const CurrentPosUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): PosUser | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { posUser?: PosUser }>();
    return req.posUser;
  },
);
