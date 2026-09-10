import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/secrets';
import { consumeOneTimeToken } from '../routes/auth';

export interface AuthPayload {
  sub: string;
  username: string;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Try Authorization header first
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (token) {
    // Standard JWT auth via header
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as AuthPayload;
      req.user = decoded;
      next();
      return;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }

  // Try one-time token via query parameter (for SSE and downloads)
  if (req.query.token && typeof req.query.token === 'string') {
    const ottPayload = consumeOneTimeToken(req.query.token);
    if (ottPayload) {
      req.user = ottPayload;
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  res.status(401).json({ error: 'Authentication required' });
}
