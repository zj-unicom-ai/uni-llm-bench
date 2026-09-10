import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { userStore } from '../services/userStore';
import { AuthPayload } from '../middleware/auth';
import { getJwtSecret } from '../utils/secrets';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Public router: login only (no auth required)
export const authPublicRouter = Router();

// Protected router: verify, change-password, sse-token (auth required)
export const authProtectedRouter = Router();

// Rate limiter for login
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Public routes ---

authPublicRouter.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const user = await userStore.verifyPassword(username, password);
  if (!user) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const payload: AuthPayload = { sub: user.id, username: user.username };
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);

  res.json({
    token,
    user: { id: user.id, username: user.username },
    expiresIn: JWT_EXPIRES_IN,
    passwordChangeRequired: userStore.isPasswordChangeRequired(user.id),
  });
});

// --- Protected routes ---

authProtectedRouter.get('/verify', (req: Request, res: Response) => {
  const user = req.user as AuthPayload | undefined;
  const passwordChangeRequired = user ? userStore.isPasswordChangeRequired(user.sub) : false;
  res.json({ valid: true, user, passwordChangeRequired });
});

authProtectedRouter.post('/change-password', async (req: Request, res: Response) => {
  const user = req.user as AuthPayload | undefined;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'Current password and new password are required' });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }

  // Verify current password
  const verified = await userStore.verifyPassword(user.username, currentPassword);
  if (!verified) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  // Ensure new password differs from current
  if (currentPassword === newPassword) {
    res.status(400).json({ error: 'New password must be different from current password' });
    return;
  }

  // Update password and clear change-required flag
  const success = await userStore.updatePassword(user.username, newPassword);
  if (!success) {
    res.status(500).json({ error: 'Failed to update password' });
    return;
  }

  userStore.clearPasswordChangeRequired(user.sub);
  res.json({ success: true });
});

// --- One-time token system for SSE and downloads ---

const oneTimeTokens = new Map<string, { userId: string; username: string; expiresAt: number }>();

// Clean up expired tokens every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of oneTimeTokens) {
    if (data.expiresAt < now) {
      oneTimeTokens.delete(token);
    }
  }
}, 60_000);

authProtectedRouter.post('/sse-token', (req: Request, res: Response) => {
  const user = req.user as AuthPayload | undefined;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = jwt.sign({ ott: true }, getJwtSecret(), { expiresIn: '60s' } as jwt.SignOptions);
  oneTimeTokens.set(token, {
    userId: user.sub,
    username: user.username,
    expiresAt: Date.now() + 60_000,
  });

  res.json({ token });
});

/**
 * Validate and consume a one-time token.
 * Returns the user payload if valid, null otherwise.
 */
export function consumeOneTimeToken(token: string): AuthPayload | null {
  const data = oneTimeTokens.get(token);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    oneTimeTokens.delete(token);
    return null;
  }
  // Consume the token (single use)
  oneTimeTokens.delete(token);
  return { sub: data.userId, username: data.username };
}
