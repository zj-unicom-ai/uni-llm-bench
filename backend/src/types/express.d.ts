import { AuthPayload } from '../middleware/auth';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload;
  }
}
