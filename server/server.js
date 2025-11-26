const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database connection
let db = pool;

// Middleware
app.use(cors());
app.use(express.json());

// Default settings object
const defaultSettings = {
  siteName: "Park Master Pro",
  pricing: {
    car: { baseHours: 2, baseFee: 50, extraHourFee: 25 },
    bike: { baseHours: 2, baseFee: 20, extraHourFee: 10 },
    rickshaw: { baseHours: 2, baseFee: 30, extraHourFee: 15 }
  },
  credentials: {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin123"
  },
  viewMode: "grid"
};

// --- Database Initialization and Migration ---
async function initializeDatabase() {
  console.log('Connecting to PostgreSQL database...');

  // Create tables if they don't exist (PostgreSQL syntax)
  await db.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      vehicleNumber TEXT NOT NULL,
      vehicleType TEXT NOT NULL,
      entryTime TEXT NOT NULL,
      exitTime TEXT,
      fee REAL
    );

    CREATE TABLE IF NOT EXISTS permanent_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vehicleNumber TEXT NOT NULL,
      contact TEXT NOT NULL,
      paymentStatus TEXT NOT NULL DEFAULT 'unpaid',
      entryTime TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      totalVehicles INTEGER NOT NULL,
      totalRevenue REAL NOT NULL
    );
  `);

  console.log('Database tables created/verified.');

  // Check if settings are initialized
  const settingsResult = await db.query('SELECT value FROM settings WHERE key = $1', ['app_settings']);
  if (settingsResult.rows.length === 0) {
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['app_settings', JSON.stringify(defaultSettings)]);
    console.log('Default settings initialized.');
  }

  // One-time migration from JSON files
  await migrateDataFromJsons();
}

async function migrateDataFromJsons() {
  const DATA_DIR = path.join(__dirname, 'data');
  const filesToMigrate = {
    vehicles: path.join(DATA_DIR, 'vehicles.json'),
    permanent_clients: path.join(DATA_DIR, 'permanent-clients.json'),
    daily_stats: path.join(DATA_DIR, 'daily-stats.json')
  };

  for (const [table, filePath] of Object.entries(filesToMigrate)) {
    try {
      await fs.access(filePath);
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (data.length > 0) {
        console.log(`Migrating data from ${path.basename(filePath)}...`);
        for (const item of data) {
          const keys = Object.keys(item);
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
          const values = Object.values(item);
          await db.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
        }
        await fs.rename(filePath, `${filePath}.migrated`);
        console.log(`Migration successful for ${path.basename(filePath)}.`);
      }
    } catch (error) {
      // File doesn't exist or other error, skip migration for this file
    }
  }
}

// --- PostgreSQL Helper Functions ---
// Convert SQLite-style queries (?) to PostgreSQL-style ($1, $2, etc.)
async function dbGet(query, ...params) {
  let paramIndex = 1;
  const pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
  const result = await db.query(pgQuery, params);
  return result.rows[0] || null;
}

async function dbAll(query, ...params) {
  let paramIndex = 1;
  const pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
  const result = await db.query(pgQuery, params);
  return result.rows;
}

async function dbRun(query, ...params) {
  let paramIndex = 1;
  const pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
  const result = await db.query(pgQuery, params);
  return { changes: result.rowCount };
}

// --- API Routes ---

// Authentication
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const settingsRow = await dbGet('SELECT value FROM settings WHERE key = ?', 'app_settings');
    const settings = JSON.parse(settingsRow.value);
    // Override with environment variables if they are set
    settings.credentials.username = process.env.ADMIN_USERNAME || settings.credentials.username;
    settings.credentials.password = process.env.ADMIN_PASSWORD || settings.credentials.password;

    if (username === settings.credentials.username && password === settings.credentials.password) {
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Vehicles
app.get('/api/vehicles', async (req, res) => {
  try {
    const vehicles = await dbAll('SELECT * FROM vehicles');
    res.json(vehicles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

app.post('/api/vehicles', async (req, res) => {
  try {
    const newVehicle = {
      ...req.body,
      id: Date.now().toString(),
      entryTime: new Date().toISOString()
    };
    await dbRun('INSERT INTO vehicles (id, vehicleNumber, vehicleType, entryTime) VALUES (?, ?, ?, ?)',
      newVehicle.id, newVehicle.vehicleNumber, newVehicle.vehicleType, newVehicle.entryTime);
    res.json(newVehicle);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add vehicle' });
  }
});

app.put('/api/vehicles/:id/exit', async (req, res) => {
  try {
    const { fee } = req.body;
    const exitTime = new Date().toISOString();
    const result = await dbRun('UPDATE vehicles SET exitTime = ?, fee = ? WHERE id = ?', exitTime, fee, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    const updatedVehicle = await dbGet('SELECT * FROM vehicles WHERE id = ?', req.params.id);
    res.json(updatedVehicle);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// Permanent Clients
app.get('/api/permanent-clients', async (req, res) => {
  try {
    const clients = await dbAll('SELECT * FROM permanent_clients');
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch permanent clients' });
  }
});

app.post('/api/permanent-clients', async (req, res) => {
  try {
    const newClient = {
      ...req.body,
      id: Date.now().toString(),
      entryTime: new Date().toISOString(),
      paymentStatus: 'unpaid'
    };
    await dbRun('INSERT INTO permanent_clients (id, name, vehicleNumber, contact, paymentStatus, entryTime) VALUES (?, ?, ?, ?, ?, ?)',
      newClient.id, newClient.name, newClient.vehicleNumber, newClient.contact, newClient.paymentStatus, newClient.entryTime);
    res.json(newClient);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add permanent client' });
  }
});

app.put('/api/permanent-clients/:id', async (req, res) => {
  try {
    const { name, vehicleNumber, contact, paymentStatus } = req.body;
    const result = await dbRun('UPDATE permanent_clients SET name = ?, vehicleNumber = ?, contact = ?, paymentStatus = ? WHERE id = ?',
      name, vehicleNumber, contact, paymentStatus, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const updatedClient = await dbGet('SELECT * FROM permanent_clients WHERE id = ?', req.params.id);
    res.json(updatedClient);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update permanent client' });
  }
});

app.delete('/api/permanent-clients/:id', async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM permanent_clients WHERE id = ?', req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove permanent client' });
  }
});

// Settings
app.get('/api/settings', async (req, res) => {
  try {
    const settingsRow = await dbGet('SELECT value FROM settings WHERE key = ?', 'app_settings');
    res.json(JSON.parse(settingsRow.value));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    await dbRun('UPDATE settings SET value = ? WHERE key = ?', JSON.stringify(req.body), 'app_settings');
    res.json(req.body);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Daily Stats
app.get('/api/daily-stats', async (req, res) => {
  try {
    const stats = await dbAll('SELECT * FROM daily_stats');
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch daily stats' });
  }
});

app.post('/api/daily-stats', async (req, res) => {
  try {
    const { date, totalVehicles, totalRevenue } = req.body;
    await dbRun('INSERT INTO daily_stats (date, totalVehicles, totalRevenue) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET totalVehicles = ?, totalRevenue = ?',
      date, totalVehicles, totalRevenue, totalVehicles, totalRevenue);
    res.json(req.body);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update daily stats' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Backup and Restore
app.post('/api/backup', async (req, res) => {
  try {
    const { vehicles, permanentClients, settings, dailyStats } = req.body;
    await dbRun('BEGIN TRANSACTION');
    await dbRun('DELETE FROM vehicles');
    await dbRun('DELETE FROM permanent_clients');
    await dbRun('DELETE FROM daily_stats');
    for (const v of vehicles) await dbRun('INSERT INTO vehicles VALUES (?,?,?,?,?,?)', v.id, v.vehicleNumber, v.vehicleType, v.entryTime, v.exitTime, v.fee);
    for (const c of permanentClients) await dbRun('INSERT INTO permanent_clients VALUES (?,?,?,?,?,?)', c.id, c.name, c.vehicleNumber, c.contact, c.paymentStatus, c.entryTime);
    for (const s of dailyStats) await dbRun('INSERT INTO daily_stats VALUES (?,?,?)', s.date, s.totalVehicles, s.totalRevenue);
    await dbRun('UPDATE settings SET value = ? WHERE key = ?', JSON.stringify(settings), 'app_settings');
    await dbRun('COMMIT');
    res.json({ success: true, message: 'Restore from backup successful.' });
  } catch (error) {
    await dbRun('ROLLBACK');
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

app.get('/api/backup/download', async (req, res) => {
  try {
    const backupData = {
      vehicles: await dbAll('SELECT * FROM vehicles'),
      permanentClients: await dbAll('SELECT * FROM permanent_clients'),
      settings: JSON.parse((await dbGet('SELECT value FROM settings WHERE key = ?', 'app_settings')).value),
      dailyStats: await dbAll('SELECT * FROM daily_stats')
    };
    const backupFilePath = path.join(__dirname, 'data', 'backup.json');
    await fs.writeFile(backupFilePath, JSON.stringify(backupData, null, 2));
    res.download(backupFilePath, 'backup.json');
  } catch (error) {
    res.status(500).json({ error: 'Failed to create backup for download' });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Park Master Pro Backend Server running on port ${PORT}`);
      console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
      console.log(`💾 Using database file: ${DB_PATH}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
