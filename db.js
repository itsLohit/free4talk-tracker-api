const { Pool } = require('pg');
require('dotenv').config();

// Parse DATABASE_URL
function parseDatabaseUrl(url) {
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  const [baseUrl] = url.split('?');
  const match = baseUrl.match(/postgres:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  
  if (match) {
    return {
      user: match[1],
      password: match[2],
      host: match[3],
      port: parseInt(match[4]),
      database: match[5],
      ssl: { rejectUnauthorized: false }
    };
  }

  throw new Error('Invalid DATABASE_URL format');
}

// Create connection pool
const pool = new Pool({
  ...parseDatabaseUrl(process.env.DATABASE_URL),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err);
});

module.exports = pool;
