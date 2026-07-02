import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DEV_USER_EMAIL, DEV_USER_ID } from '../constants';

// Temporary stand-in for real authentication. Attaches a fixed dev user to
// every request so downstream code can already depend on req.user being
// present. Replace with a real auth guard/strategy later.
@Injectable()
export class DevUserMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    req.user = { id: DEV_USER_ID, email: DEV_USER_EMAIL };
    next();
  }
}
