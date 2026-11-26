// Máy chủ nhỏ của Xưởng Ảnh Thương Hiệu trên Cloudflare Pages.
// Chỉ làm một việc: nhận email, ghi vào kho khách hàng và cho biết khách còn bao nhiêu ngày dùng thử.
// Mọi đường dẫn khác chuyển thẳng cho các tệp của trang.
const APP = "xuong-anh";
const TRIAL_DAYS = 7;
const DAY = 86400000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function trangThai(row, now) {
  if (!row) return { status: "none" };
  const t = now.getTime();
  const paid = row.paid_until && Date.parse(row.paid_until) > t;
  const trial = Date.parse(row.expires_at) > t;
  const until = paid ? row.paid_until : row.expires_at;
  return {
    status: paid ? "paid" : trial ? "trial" : "expired",
    started_at: row.started_at,
    expires_at: row.expires_at,
    paid_until: row.paid_until ?? null,
    days_left: paid || trial ? Math.max(1, Math.ceil((Date.parse(until) - t) / DAY)) : 0,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/trial") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (request.headers.get("origin") !== url.origin) return json({ error: "Yêu cầu không hợp lệ." }, 403);
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Dữ liệu không hợp lệ." }, 415);
    let data;
    try {
      const text = await request.text();
      if (text.length > 2048) return json({ error: "Dữ liệu quá dài." }, 413);
      data = JSON.parse(text);
    } catch {
      return json({ error: "Dữ liệu không hợp lệ." }, 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Dữ liệu không hợp lệ." }, 400);
    if (data.website) return json({ ok: true, status: "none" });
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Bạn kiểm tra lại địa chỉ email nhé." }, 400);
    if (!env.CUSTOMERS_DB) return json({ error: "Hệ thống đang kết nối kho dữ liệu. Bạn thử lại sau nhé." }, 503);

    const db = env.CUSTOMERS_DB;
    const now = new Date();
    const iso = now.toISOString();
    const create = data.create === true;
    const consent = data.marketingOptIn === true ? 1 : 0;
    try {
      if (create) {
        const expires = new Date(now.getTime() + TRIAL_DAYS * DAY).toISOString();
        const res = await db.batch([
          db.prepare(`INSERT INTO customers (id,email,created_at,last_seen_at,source,marketing_opt_in,marketing_opt_in_at)
            VALUES (?,?,?,?,'xuong_anh_trial',?,?)
            ON CONFLICT(email) DO UPDATE SET
              last_seen_at=excluded.last_seen_at,
              marketing_opt_in=CASE WHEN excluded.marketing_opt_in=1 THEN 1 ELSE customers.marketing_opt_in END,
              marketing_opt_in_at=CASE WHEN excluded.marketing_opt_in=1 THEN excluded.marketing_opt_in_at ELSE customers.marketing_opt_in_at END`)
            .bind(crypto.randomUUID(), email, iso, iso, consent, consent ? iso : null),
          db.prepare("INSERT OR IGNORE INTO app_trials (app,email,started_at,expires_at) VALUES (?,?,?,?)").bind(APP, email, iso, expires),
        ]);
        if ((res[1]?.meta?.changes ?? 0) > 0) {
          await db.prepare(`INSERT INTO customer_events (id,customer_id,event_type,occurred_at,page_path,marketing_opt_in)
            SELECT ?,id,'trial_started',?,'/xuong-anh',marketing_opt_in FROM customers WHERE email=?`)
            .bind(crypto.randomUUID(), iso, email).run();
        }
      }
      const row = await db.prepare("SELECT started_at,expires_at,paid_until FROM app_trials WHERE app=? AND email=?").bind(APP, email).first();
      return json({ ok: true, ...trangThai(row, now) });
    } catch {
      // Không ghi email hay dữ liệu khách vào nhật ký công khai.
      return json({ error: "Chưa lưu được. Bạn thử lại sau nhé." }, 503);
    }
  },
};
