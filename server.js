const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.json());

// Health check endpoint (required for Render)
// Note: Does NOT query database to allow Neon auto-suspend
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Landing page with analytics beacon injected
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    // Inject the slug into the HTML
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Hello from Polsia Instance!' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
