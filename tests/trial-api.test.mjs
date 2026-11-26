import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../_worker.js";

const SCHEMA = `
CREATE TABLE customers (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'skilldrop_email_form', status TEXT NOT NULL DEFAULT 'lead',
  email_verified INTEGER NOT NULL DEFAULT 0, marketing_opt_in INTEGER NOT NULL DEFAULT 0, marketing_opt_in_at TEXT, interest_slug TEXT);
CREATE TABLE customer_events (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL, page_path TEXT NOT NULL, marketing_opt_in INTEGER NOT NULL);
`;

function makeEnv({ broken = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  sqlite.exec(readFileSync(new URL("../database/trial.sql", import.meta.url), "utf8"));
  const wrap = (sql) => {
    let args = [];
    const o = {
      bind(...a) { args = a; return o; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
    };
    return o;
  };
  const DB = {
    prepare: wrap,
    async batch(list) { return Promise.all(list.map((s) => s.run())); },
  };
  return {
    sqlite,
    env: {
      CUSTOMERS_DB: broken ? { prepare() { throw new Error("D1 lỗi"); }, batch() { throw new Error("D1 lỗi"); } } : DB,
      ASSETS: { fetch: async () => new Response("tinh", { status: 200 }) },
    },
  };
}

const call = (env, body, { origin = "https://app.test", type = "application/json", method = "POST", path = "/api/trial" } = {}) =>
  worker.fetch(new Request("https://app.test" + path, {
    method, headers: { origin, "content-type": type }, body: method === "POST" ? JSON.stringify(body) : undefined,
  }), env);

test("khách mới bắt đầu dùng thử 7 ngày và email được lưu vào kho khách hàng", async () => {
  const { env, sqlite } = makeEnv();
  const r = await call(env, { email: "  Khach@Example.com ", create: true, marketingOptIn: true });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.status, "trial");
  assert.equal(j.days_left, 7);
  const c = sqlite.prepare("SELECT * FROM customers").get();
  assert.equal(c.email, "khach@example.com");
  assert.equal(c.source, "xuong_anh_trial");
  assert.equal(c.marketing_opt_in, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_events WHERE event_type='trial_started'").get().n, 1);
});

test("gửi lại cùng email không cấp thêm 7 ngày và không nhân đôi hồ sơ", async () => {
  const { env, sqlite } = makeEnv();
  await call(env, { email: "a@b.vn", create: true });
  sqlite.prepare("UPDATE app_trials SET started_at=?, expires_at=?").run("2020-01-01T00:00:00.000Z", "2020-01-08T00:00:00.000Z");
  const j = await (await call(env, { email: "A@B.vn", create: true })).json();
  assert.equal(j.status, "expired");
  assert.equal(j.days_left, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customers").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM app_trials").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_events").get().n, 1);
});

test("hết hạn rồi mà chị mở khoá thì thành paid, khoá lại thì expired", async () => {
  const { env, sqlite } = makeEnv();
  await call(env, { email: "a@b.vn", create: true });
  sqlite.prepare("UPDATE app_trials SET expires_at='2020-01-08T00:00:00.000Z'").run();
  sqlite.prepare("UPDATE app_trials SET paid_until=?").run(new Date(Date.now() + 30 * 86400000).toISOString());
  const paid = await (await call(env, { email: "a@b.vn", create: false })).json();
  assert.equal(paid.status, "paid");
  assert.ok(paid.days_left >= 29);
  sqlite.prepare("UPDATE app_trials SET paid_until=NULL").run();
  assert.equal((await (await call(env, { email: "a@b.vn", create: false })).json()).status, "expired");
});

test("chỉ kiểm tra (không tạo) thì email lạ trả về none và không ghi gì", async () => {
  const { env, sqlite } = makeEnv();
  const j = await (await call(env, { email: "la@x.vn", create: false })).json();
  assert.equal(j.status, "none");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customers").get().n, 0);
});

test("chặn dữ liệu lỗi, nguồn ngoài, sai kiểu, quá dài; bỏ qua ô bẫy robot", async () => {
  const { env, sqlite } = makeEnv();
  assert.equal((await call(env, { email: "khong-phai-email", create: true })).status, 400);
  assert.equal((await call(env, { email: "a@b.vn", create: true }, { origin: "https://evil.test" })).status, 403);
  assert.equal((await call(env, { email: "a@b.vn" }, { type: "text/plain" })).status, 415);
  assert.equal((await call(env, { email: "a".repeat(300) + "@b.vn", create: true })).status, 400);
  assert.equal((await call(env, { email: "a@b.vn", pad: "x".repeat(3000) })).status, 413);
  assert.equal((await call(env, {}, { method: "GET" })).status, 405);
  const bot = await call(env, { email: "bot@b.vn", create: true, website: "spam.vn" });
  assert.equal((await bot.json()).status, "none");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customers").get().n, 0);
});

test("kho lỗi thì báo 503, không báo thành công", async () => {
  const { env } = makeEnv({ broken: true });
  const r = await call(env, { email: "a@b.vn", create: true });
  assert.equal(r.status, 503);
});

test("đường dẫn khác chuyển cho tệp tĩnh; không có API đọc danh sách khách", async () => {
  const { env } = makeEnv();
  const r = await call(env, null, { method: "GET", path: "/index.html" });
  assert.equal(await r.text(), "tinh");
  const list = await call(env, null, { method: "GET", path: "/api/customers" });
  assert.equal(await list.text(), "tinh");
});
