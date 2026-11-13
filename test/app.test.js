import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app } from "../src/app.js";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("API rejects invalid public payloads before database access", async () => {
  const invalidOrder = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customer: {}, items: [] }),
  });
  assert.equal(invalidOrder.status, 400);
  assert.match((await invalidOrder.json()).error, /expected|invalid|required/i);

  const invalidMessage = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Customer", email: "not-an-email", subject: "", message: "" }),
  });
  assert.equal(invalidMessage.status, 400);
});

test("admin data endpoints require a bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/admin/products`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Admin authentication required");
});

test("unknown API routes return a JSON 404", async () => {
  const response = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Route not found/);
});
