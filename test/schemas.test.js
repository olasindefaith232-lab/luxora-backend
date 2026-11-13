import test from "node:test";
import assert from "node:assert/strict";
import {
  messageSchema,
  orderSchema,
  productSchema,
  subscriberSchema,
} from "../src/schemas.js";

test("product schema accepts valid catalog data and normalizes optional fields", () => {
  const result = productSchema.parse({
    name: "Daily tote",
    category: "Bags",
    price: "25000",
    image: "https://example.com/tote.jpg",
  });
  assert.equal(result.price, 25000);
  assert.equal(result.oldPrice, undefined);
  assert.equal(result.stock, 0);
  assert.equal(result.active, true);
});

test("product schema rejects invalid image URLs and negative inventory", () => {
  assert.equal(productSchema.safeParse({
    name: "Tote",
    category: "Bags",
    price: 1,
    image: "not-a-url",
    stock: -1,
  }).success, false);
});

test("order schema requires customer details and at least one valid item", () => {
  assert.equal(orderSchema.safeParse({
    customer: { name: "A Customer", email: "hello@example.com", phone: "123", address: "Somewhere" },
    items: [{ productId: "2", quantity: "3" }],
  }).success, true);
  assert.equal(orderSchema.safeParse({
    customer: { name: "A Customer", email: "wrong", phone: "123", address: "Somewhere" },
    items: [],
  }).success, false);
});

test("newsletter addresses are trimmed, lowercased, and validated", () => {
  assert.equal(subscriberSchema.parse({ email: "  HELLO@example.com " }).email, "hello@example.com");
  assert.equal(subscriberSchema.safeParse({ email: "nope" }).success, false);
});

test("contact messages require a valid email and bounded content", () => {
  assert.equal(messageSchema.safeParse({
    name: "A Customer",
    email: "hello@example.com",
    subject: "A question",
    message: "Could you help?",
  }).success, true);
  assert.equal(messageSchema.safeParse({
    name: "A Customer",
    email: "bad",
    subject: "A question",
    message: "Could you help?",
  }).success, false);
});
