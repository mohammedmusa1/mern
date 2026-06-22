require('dotenv').config();

// Global uncaught exception and unhandled rejection handlers (must be first)
process.on('uncaughtException', err => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const seedDB = require('./seed/productSeeds');
const syncPinecone = require('./sync/syncPinecone');
const productRoutes = require('./routes/products');
const checkoutRoutes = require('./routes/checkout');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');
const searchRoutes = require('./routes/search');
const { swaggerUi, swaggerSpec, setupSwaggerUi, setupSwaggerJson } = require('./docs/swagger');

// Validate required environment variables
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8000;
const CLIENT_URL = process.env.CLIENT_URL || '*';
let server;

// ── Security Middleware ─────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // Swagger UI needs inline styles
  })
);

// ── CORS ────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: CLIENT_URL === '*' ? '*' : CLIENT_URL.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: CLIENT_URL !== '*',
};
app.use(cors(corsOptions));

// ── Compression & Parsing ───────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Request Logging ─────────────────────────────────────────────────────────
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat));

// ── Rate Limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { status: 'error', message: 'Too many authentication attempts, please try again later.' },
});
app.use('/api/auth/', authLimiter);

// ── Health Endpoints (before routes) ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/readyz', (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  if (mongoReady) {
    res.status(200).json({ status: 'ready', mongo: 'connected' });
  } else {
    res.status(503).json({ status: 'not ready', mongo: 'disconnected' });
  }
});

// ── Swagger Docs ─────────────────────────────────────────────────────────────
setupSwaggerJson(app);
setupSwaggerUi(app);

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/products', productRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/auth', authRoutes);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.method} ${req.path} not found` });
});

// ── Centralized Error Handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  console.error(`[ERROR] ${req.method} ${req.path} → ${status}: ${message}`, err.stack);
  res.status(status).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' && status === 500 ? 'Internal Server Error' : message,
  });
});

module.exports = app;

// ── Database Connection + Startup ─────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('[DB] MongoDB Connected');

    const skipSeed = process.env.SKIP_SEED_ON_START === 'true';
    if (!skipSeed) {
      try {
        const forceSeed = process.env.FORCE_SEED_ON_START === 'true';
        const result = await seedDB({ force: forceSeed, skipIfExists: !forceSeed });
        if (result?.seeded) {
          console.log('[DB] Database seeded');
        } else if (result?.skipped) {
          console.log('[DB] Seed skipped (existing products retained)');
        }
      } catch (err) {
        console.error('[DB] Seeding error:', err.message);
      }
    } else {
      console.log('[DB] SKIP_SEED_ON_START enabled — seed skipped');
    }

    try {
      await syncPinecone();
      console.log('[Pinecone] Sync complete');
    } catch (err) {
      console.warn('[Pinecone] Sync failed (continuing with fallbacks):', err.message);
    }

    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] Ready on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  })
  .catch(err => {
    console.error('[DB] MongoDB connection error:', err.message);
    process.exit(1);
  });

// ── Graceful Shutdown ──────────────────────────────────────────────────────────
const shutdown = signal => {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed');
      mongoose.connection.close(false).then(() => {
        console.log('[DB] MongoDB connection closed');
        process.exit(0);
      });
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
