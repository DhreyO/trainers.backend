require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const app = express();

// Allow the frontend (S3/Amplify/other origin) to call this API.
// Set CORS_ORIGIN to your frontend URL in production, e.g. http://my-site.s3-website.eu-west-2.amazonaws.com
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// RDS (MySQL) connection — set these on EC2, never in the frontend
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'trainers-db1',
  connectionLimit: 10
});

// Seed data — images are served directly from S3, the DB stores their URLs
const S3 = process.env.S3_BASE_URL || 'https://dhrey-store-v3.s3.eu-west-2.amazonaws.com';
const seedProducts = [
  { name: "Nike Air Jordan 1 Low", price: 140, image: `${S3}/Nike+Air+Jordan+1+Low.png`, sizes: [7,8,9,10,11], stock: 12 },
  { name: "Adidas  22", price: 160, image: `${S3}/Adidas+22.png`, sizes: [6,7,8,9,10], stock: 8 },
  { name: "Nike Air Jordan Dub Zero", price: 110, image: `${S3}/Nike+Air+Jordan+Dub+Zero.png`, sizes: [7,8,9,10,12], stock: 20 },
  { name: "Nike Air Jordan 1 High", price: 130, image: `${S3}/Nike+Air+Jordan+1+Low.png`, sizes: [7,8,9,10,11], stock: 10 },
  { name: "Adidas strip", price: 100, image: `${S3}/Adidas+Strip.png`, sizes: [6,7,8,9,10], stock: 15 },
  { name: "Jordan 1 Retro High", price: 180, image: `${S3}/Jordan+1+Retro+High.png`, sizes: [7,8,9,10,11], stock: 5 },
  { name: "Nike Air Trainer", price: 120, image: `${S3}/Nike+Air+Trainer.png`, sizes: [6,7,8,9,10], stock: 9 },
  { name: "Yeezy Boost 350 V2", price: 220, image: `${S3}/Yeezy+Boost+350.png`, sizes: [7,8,9,10], stock: 4 }
];

// Create tables on first run and seed products if the table is empty
async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    image VARCHAR(500),
    sizes JSON,
    stock INT NOT NULL DEFAULT 0
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    items JSON NOT NULL,
    total DECIMAL(10,2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM products');
  if (count === 0) {
    for (const p of seedProducts) {
      await db.query('INSERT INTO products (name, price, image, sizes, stock) VALUES (?, ?, ?, ?, ?)',
        [p.name, p.price, p.image, JSON.stringify(p.sizes), p.stock]);
    }
    console.log(`Seeded ${seedProducts.length} trainers`);
  }
}

// sizes may be a JSON column, a JSON string or plain "7,8,9" text
const parseSizes = sizes => {
  if (Array.isArray(sizes)) return sizes;
  if (!sizes) return [];
  try { return JSON.parse(sizes); } catch { return String(sizes).split(',').map(Number); }
};

// mysql2 returns DECIMAL as string; fall back to image_url if image is empty
const toProduct = ({ image_url, ...row }) => ({
  ...row,
  price: Number(row.price),
  image: row.image || image_url || null,
  sizes: parseSizes(row.sizes)
});

// Health check for EC2 / load balancer (also checks RDS)
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: err.message });
  }
});

// GET all trainers
app.get('/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products ORDER BY id');
    res.json(rows.map(toProduct));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load trainers" });
  }
});

// GET one trainer
app.get('/products/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [parseInt(req.params.id)]);
    if (rows.length === 0) return res.status(404).json({ message: "Trainer not found" });
    res.json(toProduct(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load trainer" });
  }
});

// POST new trainer
app.post('/products', async (req, res) => {
  const { name, price, image, sizes, stock } = req.body;
  try {
    const [result] = await db.query('INSERT INTO products (name, price, image, sizes, stock) VALUES (?, ?, ?, ?, ?)',
      [name, price, image || null, JSON.stringify(sizes || []), stock || 0]);
    res.status(201).json({ id: result.insertId, name, price, image, sizes, stock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not add trainer" });
  }
});

// POST simulated checkout/order
app.post('/orders', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Cart is empty" });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    let total = 0;
    for (const item of items) {
      const qty = parseInt(item.quantity) || 1;
      const [rows] = await conn.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [parseInt(item.id)]);
      const product = rows[0];
      if (!product) {
        await conn.rollback();
        return res.status(404).json({ message: `Trainer ${item.id} not found` });
      }
      if (product.stock < qty) {
        await conn.rollback();
        return res.status(400).json({ message: `Not enough stock for ${product.name}` });
      }
      await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, product.id]);
      total += Number(product.price) * qty;
    }
    const [result] = await conn.query('INSERT INTO orders (items, total) VALUES (?, ?)', [JSON.stringify(items), total]);
    await conn.commit();
    res.status(201).json({ id: result.insertId, items, total, status: "confirmed", createdAt: new Date().toISOString() });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Checkout failed" });
  } finally {
    conn.release();
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('Could not connect to RDS:', err.message);
    process.exit(1);
  });
