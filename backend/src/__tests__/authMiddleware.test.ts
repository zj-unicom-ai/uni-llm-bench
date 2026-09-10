import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/secrets';

// Test the auth middleware logic by simulating Express req/res/next
function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('Auth Middleware', () => {
  const secret = getJwtSecret();

  describe('JWT token validation', () => {
    it('should verify a valid JWT token', () => {
      const token = jwt.sign({ sub: 'user-1', username: 'admin' }, secret, { expiresIn: '1h' });
      const decoded = jwt.verify(token, secret) as { sub: string; username: string };
      expect(decoded.sub).toBe('user-1');
      expect(decoded.username).toBe('admin');
    });

    it('should reject an expired token', () => {
      const token = jwt.sign({ sub: 'user-1', username: 'admin' }, secret, { expiresIn: '-1s' });
      expect(() => jwt.verify(token, secret)).toThrow();
    });

    it('should reject a token signed with wrong secret', () => {
      const token = jwt.sign({ sub: 'user-1', username: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
      expect(() => jwt.verify(token, secret)).toThrow();
    });

    it('should reject a malformed token', () => {
      expect(() => jwt.verify('not-a-token', secret)).toThrow();
    });
  });

  describe('Auth middleware function', () => {
    // Import the middleware after mocks are set up
    let authMiddleware: typeof import('../middleware/auth').authMiddleware;

    beforeEach(async () => {
      authMiddleware = (await import('../middleware/auth')).authMiddleware;
    });

    it('should call next() for valid Bearer token', () => {
      const token = jwt.sign({ sub: 'user-1', username: 'admin' }, secret, { expiresIn: '1h' });
      const req: any = { headers: { authorization: `Bearer ${token}` }, query: {} };
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user!.sub).toBe('user-1');
    });

    it('should return 401 when no token is provided', () => {
      const req: any = { headers: {}, query: {} };
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for invalid token', () => {
      const req: any = { headers: { authorization: 'Bearer invalid-token' }, query: {} };
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });
});
