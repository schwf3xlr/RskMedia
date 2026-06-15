const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const initDatabase = require('./scripts/init-db');
const { authenticateToken } = require('./middleware/auth');
const { requireAdmin } = require('./middleware/admin');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy only when enabled
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
}

// Security middleware
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  mediaSrc: ["'self'", "https:"],
  connectSrc: ["'self'"],
  frameSrc: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  upgradeInsecureRequests: [],
};

if (process.env.NODE_ENV === 'development') {
  delete cspDirectives.upgradeInsecureRequests;
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: cspDirectives,
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  credentials: true,
}));

app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cookieParser(process.env.COOKIE_SECRET || process.env.JWT_SECRET));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

// Unregister old service workers and prevent cross-origin fetch interception
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    self.addEventListener('install', e => {
      e.waitUntil(self.skipWaiting());
    });
    self.addEventListener('activate', e => {
      e.waitUntil(
        Promise.all([
          self.clients.claim(),
          self.registration.unregister()
        ])
      );
    });
    self.addEventListener('fetch', e => {
      // Don't intercept cross-origin requests
      if (new URL(e.request.url).origin !== self.location.origin) {
        return;
      }
      e.respondWith(fetch(e.request));
    });
  `);
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/media', authenticateToken, require('./routes/media'));
app.use('/api/categories', authenticateToken, require('./routes/categories'));
app.use('/api/favorites', authenticateToken, require('./routes/favorites'));
app.use('/api/admin', authenticateToken, requireAdmin, require('./routes/admin'));

// Page routes
app.get('/login', (req, res) => {
  res.render('login', { title: 'Login', user: null });
});

app.get('/', authenticateToken, (req, res) => {
  res.render('main', { title: 'RskMedia - Галерея', user: req.user });
});

app.get('/favorites', authenticateToken, (req, res) => {
  res.render('favorites', { title: 'Избранное - RskMedia', user: req.user });
});

app.get('/admin', authenticateToken, requireAdmin, (req, res) => {
  res.render('admin', { title: 'Админ - RskMedia', user: req.user });
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.status(404).render('login', { title: 'Страница не найдена', user: null });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message;

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }

  res.status(status).render('login', { title: 'Ошибка', user: null, error: message });
});

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET is not set or too weak. Set a strong JWT_SECRET in .env');
    process.exit(1);
  }
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
