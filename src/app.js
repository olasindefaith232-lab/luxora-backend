import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { pool, productFromRow } from "./db.js";
import {
  journalSchema,
  messageSchema,
  messageStatusSchema,
  orderSchema,
  orderStatusSchema,
  productSchema,
  subscriberSchema,
} from "./schemas.js";

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const allowedOrigins = [process.env.CLIENT_ORIGIN, process.env.ADMIN_ORIGIN].filter(Boolean);
let adminPasswordHash;

export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "100kb" }));

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const error = new Error(result.error.issues.map((issue) => issue.message).join(", "));
    error.status = 400;
    throw error;
  }
  return result.data;
}

function authenticateAdmin(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !process.env.JWT_SECRET) {
    return res.status(401).json({ error: "Admin authentication required" });
  }
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.get("/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "connected" });
}));

router.get("/products", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM products WHERE active = TRUE ORDER BY id");
  res.json({ products: rows.map(productFromRow) });
}));

router.get("/settings", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT key, value FROM settings ORDER BY key");
  res.json({ settings: Object.fromEntries(rows.map(({ key, value }) => [key, value])) });
}));

router.get("/journal", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, title, category, image, excerpt, content, created_at AS \"createdAt\" FROM journal_posts WHERE published = TRUE ORDER BY created_at DESC",
  );
  res.json({ posts: rows });
}));

router.post("/newsletter", asyncRoute(async (req, res) => {
  const { email } = validate(subscriberSchema, req.body);
  const { rows } = await pool.query(
    "INSERT INTO subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email],
  );
  res.status(rows.length ? 201 : 200).json({ message: "Thanks for subscribing." });
}));

router.post("/contact", asyncRoute(async (req, res) => {
  const message = validate(messageSchema, req.body);
  await pool.query(
    "INSERT INTO messages (name, email, subject, message) VALUES ($1, $2, $3, $4)",
    [message.name, message.email, message.subject, message.message],
  );
  res.status(201).json({ message: "Your note has been sent." });
}));

router.post("/orders", asyncRoute(async (req, res) => {
  const order = validate(orderSchema, req.body);
  const itemQuantities = new Map();
  for (const item of order.items) {
    itemQuantities.set(item.productId, (itemQuantities.get(item.productId) || 0) + item.quantity);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const productIds = [...itemQuantities.keys()];
    const { rows } = await client.query(
      "SELECT * FROM products WHERE id = ANY($1::int[]) AND active = TRUE FOR UPDATE",
      [productIds],
    );
    if (rows.length !== productIds.length) {
      const error = new Error("One or more selected products are no longer available.");
      error.status = 400;
      throw error;
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = [...itemQuantities].map(([productId, quantity]) => {
      const product = byId.get(productId);
      if (product.stock < quantity) {
        const error = new Error(`${product.name} does not have enough stock.`);
        error.status = 409;
        throw error;
      }
      return {
        productId,
        name: product.name,
        price: product.price,
        quantity,
        image: product.image,
      };
    });
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const orderId = crypto.randomUUID();

    for (const item of items) {
      await client.query("UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2", [item.quantity, item.productId]);
    }
    await client.query(
      `INSERT INTO orders (id, customer_name, email, phone, address, items, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, order.customer.name, order.customer.email, order.customer.phone, order.customer.address, JSON.stringify(items), total],
    );
    await client.query("COMMIT");
    res.status(201).json({ order: { id: orderId, total, status: "pending" } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

router.post("/admin/login", authLimiter, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
    return res.status(503).json({ error: "Admin credentials are not configured on the server." });
  }
  adminPasswordHash ||= await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  const passwordMatches = await bcrypt.compare(password, adminPasswordHash);
  if (email !== process.env.ADMIN_EMAIL.trim().toLowerCase() || !passwordMatches) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "8h", algorithm: "HS256" });
  res.json({ token, email });
}));

const admin = express.Router();
admin.use(authenticateAdmin);

admin.get("/overview", asyncRoute(async (_req, res) => {
  const [products, orders, revenue, subscribers, messages, recentOrders] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM products WHERE active = TRUE"),
    pool.query("SELECT COUNT(*)::int AS count FROM orders"),
    pool.query("SELECT COALESCE(SUM(total), 0)::int AS total FROM orders WHERE status != 'cancelled'"),
    pool.query("SELECT COUNT(*)::int AS count FROM subscribers"),
    pool.query("SELECT COUNT(*)::int AS count FROM messages WHERE status = 'unread'"),
    pool.query("SELECT id, customer_name AS \"customerName\", email, total, status, created_at AS \"createdAt\" FROM orders ORDER BY created_at DESC LIMIT 5"),
  ]);
  res.json({
    products: products.rows[0].count,
    orders: orders.rows[0].count,
    revenue: revenue.rows[0].total,
    subscribers: subscribers.rows[0].count,
    unreadMessages: messages.rows[0].count,
    recentOrders: recentOrders.rows,
  });
}));

admin.get("/products", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
  res.json({ products: rows.map(productFromRow) });
}));

admin.post("/products", asyncRoute(async (req, res) => {
  const product = validate(productSchema, req.body);
  const { rows } = await pool.query(
    `INSERT INTO products (name, category, price, old_price, rating, badge, image, detail, color, stock, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [product.name, product.category, product.price, product.oldPrice ?? null, product.rating, product.badge, product.image, product.detail, product.color, product.stock, product.active],
  );
  res.status(201).json({ product: productFromRow(rows[0]) });
}));

admin.put("/products/:id", asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid product id." });
  const product = validate(productSchema, req.body);
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, category=$2, price=$3, old_price=$4, rating=$5, badge=$6,
     image=$7, detail=$8, color=$9, stock=$10, active=$11, updated_at=NOW()
     WHERE id=$12 RETURNING *`,
    [product.name, product.category, product.price, product.oldPrice ?? null, product.rating, product.badge, product.image, product.detail, product.color, product.stock, product.active, id],
  );
  if (!rows.length) return res.status(404).json({ error: "Product not found." });
  res.json({ product: productFromRow(rows[0]) });
}));

admin.delete("/products/:id", asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid product id." });
  const { rowCount } = await pool.query("DELETE FROM products WHERE id=$1", [id]);
  if (!rowCount) return res.status(404).json({ error: "Product not found." });
  res.status(204).end();
}));

admin.get("/orders", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, customer_name AS "customerName", email, phone, address, items, total, status,
     created_at AS "createdAt" FROM orders ORDER BY created_at DESC`,
  );
  res.json({ orders: rows });
}));

admin.patch("/orders/:id", asyncRoute(async (req, res) => {
  const { status } = validate(orderStatusSchema, req.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT items, status FROM orders WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found." });
    }
    if (current.rows[0].status === "cancelled" && status !== "cancelled") {
      const error = new Error("Cancelled orders cannot be reopened.");
      error.status = 409;
      throw error;
    }
    if (status === "cancelled" && current.rows[0].status !== "cancelled") {
      for (const item of current.rows[0].items) {
        await client.query(
          "UPDATE products SET stock=stock+$1, updated_at=NOW() WHERE id=$2",
          [item.quantity, item.productId],
        );
      }
    }
    const { rows } = await client.query(
      "UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id, status",
      [status, req.params.id],
    );
    await client.query("COMMIT");
    res.json({ order: rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

admin.get("/subscribers", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT id, email, created_at AS \"createdAt\" FROM subscribers ORDER BY created_at DESC");
  res.json({ subscribers: rows });
}));

admin.delete("/subscribers/:id", asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid subscriber id." });
  const { rowCount } = await pool.query("DELETE FROM subscribers WHERE id=$1", [id]);
  if (!rowCount) return res.status(404).json({ error: "Subscriber not found." });
  res.status(204).end();
}));

admin.get("/messages", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, subject, message, status, created_at AS \"createdAt\" FROM messages ORDER BY created_at DESC",
  );
  res.json({ messages: rows });
}));

admin.patch("/messages/:id", asyncRoute(async (req, res) => {
  const { status } = validate(messageStatusSchema, req.body);
  const { rows } = await pool.query(
    "UPDATE messages SET status=$1 WHERE id=$2 RETURNING id, status",
    [status, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: "Message not found." });
  res.json({ message: rows[0] });
}));

admin.get("/settings", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT key, value, updated_at AS \"updatedAt\" FROM settings ORDER BY key");
  res.json({ settings: Object.fromEntries(rows.map(({ key, value, updatedAt }) => [key, { value, updatedAt }])) });
}));

admin.put("/settings", asyncRoute(async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Settings must be a key/value object." });
  }
  const entries = Object.entries(req.body);
  if (entries.length > 50 || entries.some(([key]) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key))) {
    return res.status(400).json({ error: "Settings contain an invalid key or too many entries." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of entries) {
      if (JSON.stringify(value).length > 5000) {
        const error = new Error(`Setting "${key}" is too large.`);
        error.status = 400;
        throw error;
      }
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
        [key, JSON.stringify(value)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.json({ message: "Settings saved." });
}));

admin.get("/journal", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, title, category, image, excerpt, content, published, created_at AS \"createdAt\" FROM journal_posts ORDER BY created_at DESC",
  );
  res.json({ posts: rows });
}));

admin.post("/journal", asyncRoute(async (req, res) => {
  const post = validate(journalSchema, req.body);
  const { rows } = await pool.query(
    `INSERT INTO journal_posts (id, title, category, image, excerpt, content, published)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, title, category, image, excerpt, content, published, created_at AS "createdAt"`,
    [crypto.randomUUID(), post.title, post.category, post.image, post.excerpt, post.content, post.published],
  );
  res.status(201).json({ post: rows[0] });
}));

admin.put("/journal/:id", asyncRoute(async (req, res) => {
  const post = validate(journalSchema, req.body);
  const { rows } = await pool.query(
    `UPDATE journal_posts SET title=$1, category=$2, image=$3, excerpt=$4, content=$5,
     published=$6, updated_at=NOW() WHERE id=$7
     RETURNING id, title, category, image, excerpt, content, published, created_at AS "createdAt"`,
    [post.title, post.category, post.image, post.excerpt, post.content, post.published, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: "Journal post not found." });
  res.json({ post: rows[0] });
}));

admin.delete("/journal/:id", asyncRoute(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM journal_posts WHERE id=$1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Journal post not found." });
  res.status(204).end();
}));

router.use("/admin", admin);
app.use("/api", router);

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "An unexpected server error occurred." : error.message });
});
