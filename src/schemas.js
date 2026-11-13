import { z } from "zod";

const text = (max = 500) => z.string().trim().min(1).max(max);

export const productSchema = z.object({
  name: text(160),
  category: text(80),
  price: z.coerce.number().int().min(0).max(100000000),
  oldPrice: z.union([z.coerce.number().int().min(0).max(100000000), z.null()]).optional(),
  rating: z.string().trim().regex(/^\d(?:\.\d)?$/).default("5.0"),
  badge: z.string().trim().max(40).default(""),
  image: z.string().trim().url().max(2000),
  detail: z.string().trim().max(3000).default(""),
  color: z.string().trim().max(100).default(""),
  stock: z.coerce.number().int().min(0).max(1000000).default(0),
  active: z.boolean().default(true),
});

export const orderSchema = z.object({
  customer: z.object({
    name: text(120),
    email: z.string().trim().email().max(254),
    phone: text(40),
    address: text(500),
  }),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().min(1).max(99),
  })).min(1).max(50),
});

export const messageSchema = z.object({
  name: text(120),
  email: z.string().trim().email().max(254),
  subject: text(160),
  message: text(5000),
});

export const subscriberSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
});

export const orderStatusSchema = z.object({
  status: z.enum(["pending", "processing", "shipped", "completed", "cancelled"]),
});

export const messageStatusSchema = z.object({
  status: z.enum(["unread", "read", "replied"]),
});

export const journalSchema = z.object({
  title: text(180),
  category: z.string().trim().max(100).default(""),
  image: z.union([z.string().trim().url().max(2000), z.literal("")]).default(""),
  excerpt: z.string().trim().max(500).default(""),
  content: z.string().trim().max(12000).default(""),
  published: z.boolean().default(false),
});
