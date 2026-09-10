import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env from project root (works in dev, production, and Docker)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import benchmarkRoutes from './routes/benchmarks';
import workflowRoutes from './routes/workflows';
import providerRoutes from './routes/providers';
import playgroundRoutes from './routes/playground';
import templateRoutes from './routes/templates';
import identityRoutes from './routes/identity';
import qualityRoutes from './routes/quality';
import { authPublicRouter, authProtectedRouter } from './routes/auth';
import { authMiddleware } from './middleware/auth';
import { userStore } from './services/userStore';
import { store } from './services/store';
import { qualityRunStore } from './services/qualityRunStore';
import { needsEncryptionMigration, markEncryptionMigrated } from './utils/secrets';
import { decryptWithOldKey, encrypt } from './utils/encryption';

// Initialize user store (creates table + seeds admin)
void userStore;

// Run encryption migration synchronously before server starts
if (needsEncryptionMigration()) {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '../../data/benchmarks.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath);
      const rows = db
        .prepare('SELECT id, api_key_encrypted FROM providers WHERE api_key_encrypted IS NOT NULL')
        .all() as Array<{
        id: string;
        api_key_encrypted: string;
      }>;

      if (rows.length > 0) {
        console.log(`Migrating ${rows.length} provider API keys to new encryption...`);
        const updateStmt = db.prepare('UPDATE providers SET api_key_encrypted = ? WHERE id = ?');
        const migrate = db.transaction(() => {
          let migrated = 0;
          for (const row of rows) {
            try {
              const plaintext = decryptWithOldKey(row.api_key_encrypted);
              const reEncrypted = encrypt(plaintext);
              updateStmt.run(reEncrypted, row.id);
              migrated++;
            } catch {
              console.error(`Failed to migrate API key for provider ${row.id}`);
            }
          }
          return migrated;
        });
        const count = migrate();
        console.log(`Successfully migrated ${count}/${rows.length} API keys`);
      }
      db.close();
    }
    markEncryptionMigrated();
  } catch (err) {
    console.error('Encryption migration failed:', err);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Behind a reverse proxy, X-Forwarded-For must be trusted or every request
// looks like it came from the proxy (which breaks login rate limiting).
app.set('trust proxy', 1);

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
      },
    },
  }),
);

// CORS: restrict to configured origin, default same-origin only
const corsOrigin = process.env.CORS_ORIGIN || false;
app.use(cors({ origin: corsOrigin, credentials: true }));

app.use(express.json({ limit: '10mb' }));

// Public routes (no auth required)
app.use('/api/auth', authPublicRouter);
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected routes (auth required)
app.use('/api/auth', authMiddleware, authProtectedRouter);
app.use('/api/benchmarks', authMiddleware, benchmarkRoutes);
app.use('/api/workflows', authMiddleware, workflowRoutes);
app.use('/api/providers', authMiddleware, providerRoutes);
app.use('/api/playground', authMiddleware, playgroundRoutes);
app.use('/api/templates', authMiddleware, templateRoutes);
app.use('/api/identity', authMiddleware, identityRoutes);
app.use('/api/quality', authMiddleware, qualityRoutes);

// Unknown API paths must return JSON, not the SPA shell. Without this the
// catch-all below answers /api/does-not-exist with index.html and the client
// fails parsing HTML as JSON.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// SPA fallback — serve static frontend in production, otherwise index.html
app.use(express.static(path.join(__dirname, '../../frontend/dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

// Central error handler. Without it, a rejected promise inside a route leaves
// the request hanging and produces an HTML error page.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : 0;
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('[Server] Unhandled route error:', err);
  if (!res.headersSent) {
    res.status(status >= 400 && status <= 599 ? status : 500).json({ error: message });
  }
});

// A previous process may have been killed mid-run. Those runs can never finish,
// so surface them as interrupted instead of leaving the UI spinning forever.
store.reconcileOrphans();
qualityRunStore.reconcileOrphans();

const server = app.listen(PORT, () => {
  console.log(`🚀 Uni LLM Bench running on http://localhost:${PORT}`);

  console.log(`📊 API endpoints:`);
  console.log(`   POST   /api/auth/login            - Login`);
  console.log(`   GET    /api/auth/verify            - Verify token`);
  console.log(`   POST   /api/auth/change-password   - Change password`);
  console.log(`   POST   /api/auth/sse-token         - Get one-time SSE token`);
  console.log(`   POST   /api/benchmarks             - Start benchmark`);
  console.log(`   GET    /api/benchmarks             - List benchmarks`);
  console.log(`   GET    /api/benchmarks/:id         - Get benchmark`);
  console.log(`   GET    /api/benchmarks/:id/stream  - SSE stream`);
  console.log(`   GET    /api/benchmarks/:id/export  - Export results`);
  console.log(`   POST   /api/workflows              - Create workflow`);
  console.log(`   GET    /api/workflows              - List workflows`);
  console.log(`   GET    /api/workflows/templates     - Get templates`);
  console.log(`   GET    /api/templates               - List templates (built-in + custom)`);
  console.log(`   POST   /api/templates               - Create custom template`);
  console.log(`   PUT    /api/templates/:id           - Update custom template`);
  console.log(`   DELETE /api/templates/:id           - Delete custom template`);
  console.log(`   GET    /api/workflows/:id          - Get workflow`);
  console.log(`   GET    /api/workflows/:id/stream   - SSE stream`);
  console.log(`   POST   /api/workflows/:id/cancel   - Cancel workflow`);
  console.log(`   GET    /api/workflows/:id/export   - Export results`);
  console.log(`   GET    /api/providers              - List providers`);
  console.log(`   POST   /api/providers              - Create provider`);
  console.log(`   PUT    /api/providers/:id          - Update provider`);
  console.log(`   DELETE /api/providers/:id          - Delete provider`);
  console.log(`   POST   /api/providers/:id/test     - Test connection`);
  console.log(`   GET    /api/identity/probes        - Identity probe catalog`);
  console.log(`   GET    /api/identity/baselines     - List fingerprint baselines`);
  console.log(`   POST   /api/identity/baselines     - Capture fingerprint baseline`);
  console.log(`   DELETE /api/identity/baselines/:id - Delete baseline`);
  console.log(`   POST   /api/identity/verify        - Verify model identity`);
  console.log(`   GET    /api/identity/runs          - List verification runs`);
  console.log(`   GET    /api/quality/graders        - Quality grader catalog`);
  console.log(`   GET    /api/quality/datasets       - List quality datasets`);
  console.log(`   POST   /api/quality/datasets/import - Import JSONL/CSV dataset`);
  console.log(`   POST   /api/quality/estimate       - Estimate evaluation cost`);
  console.log(`   POST   /api/quality/runs           - Start quality evaluation`);
  console.log(`   GET    /api/quality/runs           - List quality runs`);
  console.log(`   GET    /api/quality/runs/:id/stream - SSE stream`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use`);
  } else {
    console.error('[Server] Failed to start:', err);
  }
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Container stops send SIGTERM. Without handlers the process dies immediately,
// leaving runs stuck in `running` and SQLite without a clean checkpoint.
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received — shutting down gracefully`);

  // In-flight runs cannot resume in a new process; mark them interrupted.
  for (const id of store.runningIds()) {
    store.markInterrupted(id);
  }
  qualityRunStore.reconcileOrphans();

  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });

  // Do not let a lingering keep-alive connection block shutdown forever.
  setTimeout(() => {
    console.warn('[Server] Shutdown timed out — forcing exit');
    process.exit(0);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

export default app;
