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

// --- AI viết câu theo ảnh (Gemini). Khoá Gemini chỉ nằm ở đây (biến bí mật GEMINI_API_KEY của Cloudflare), không bao giờ gửi xuống trình duyệt.
const AI_LIMIT_PER_DAY = 15;
const AI_MAX_IMAGE = 600000; // ký tự base64, tương đương ~450 KB ảnh đã thu nhỏ
const AI_MODEL = "gemini-flash-latest";
// Nơi AI dự phòng (Kyma, cùng kiểu OpenAI). Dùng khi chưa có khoá Gemini hoặc đặt AI_PROVIDER=kyma. Tên mô hình có hình ảnh cần thử bằng khoá thật.
const KYMA_MODEL = "gemma-4-31b";
const KYMA_THU = ["gemma-4-31b", "qwen3.7-flash", "nemotron-3.5-super-vl", "step-3.7-flash", "gpt-6-luna", "gpt-5.6-luna", "minimax-m3.1-flash"];

function aiPrompt(nhom) {
  return `Bạn là biên tập viên viết câu chữ chèn lên ảnh cho thương hiệu cá nhân người Việt.
Hãy nhìn bức ảnh (không nói về ngoại hình hay danh tính người trong ảnh) và lĩnh vực "${nhom}".
Viết 4 câu tiêu đề tiếng Việt có dấu, mỗi câu 5 đến 10 từ, hợp không khí bức ảnh, thu hút ngay từ cái nhìn đầu và giúp định hình phong cách thương hiệu.
Mỗi câu bọc ĐÚNG MỘT cụm 2 đến 4 từ quan trọng nhất bằng hai dấu sao đôi, ví dụ: Gương mặt thật tạo **niềm tin thật**.
Không dùng emoji, không hứa kết quả, không bịa số liệu.
Chỉ trả về một mảng JSON gồm 4 chuỗi, không thêm chữ nào khác.`;
}

function loc(cau) {
  if (!Array.isArray(cau)) return [];
  const ra = [];
  for (const c of cau) {
    if (typeof c !== "string") continue;
    const t = c.trim().replace(/\s+/g, " ");
    const words = t.replace(/\*\*/g, "").split(" ").filter(Boolean).length;
    if (t.length > 120 || (t.match(/\*\*/g) || []).length !== 2 || words < 5 || words > 10) continue;
    if (!ra.includes(t)) ra.push(t);
  }
  return ra.slice(0, 4);
}

async function aiCau(db, env, email, data, now) {
  if (!env.GEMINI_API_KEY && !env.KYMA_API_KEY) return json({ error: "Tính năng AI chưa được bật. Bạn dùng câu mẫu hoặc tự viết nhé." }, 503);
  const nhom = typeof data.nhom === "string" ? data.nhom.replace(/[^\p{L}\p{N} &,-]/gu, "").slice(0, 40) : "";
  const image = typeof data.image === "string" ? data.image : "";
  if (!nhom || !/^[A-Za-z0-9+/=]{200,}$/.test(image) || image.length > AI_MAX_IMAGE) return json({ error: "Ảnh hoặc lĩnh vực chưa hợp lệ." }, 400);
  try {
    const row = await db.prepare("SELECT started_at,expires_at,paid_until FROM app_trials WHERE app=? AND email=?").bind(APP, email).first();
    const st = trangThai(row, now).status;
    if (st !== "trial" && st !== "paid") return json({ error: "Bạn cần đang dùng thử hoặc đã kích hoạt để dùng AI." }, 403);
    await db.prepare("CREATE TABLE IF NOT EXISTS ai_usage (email TEXT NOT NULL COLLATE NOCASE, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (email, day))").run();
    const day = now.toISOString().slice(0, 10);
    // Giữ chỗ trước khi gọi AI để không ai bấm dồn nhiều lần cùng lúc cho vượt giới hạn.
    await db.prepare("INSERT OR IGNORE INTO ai_usage (email,day,n) VALUES (?,?,0)").bind(email, day).run();
    const up = await db.prepare("UPDATE ai_usage SET n=n+1 WHERE email=? AND day=? AND n<?").bind(email, day, AI_LIMIT_PER_DAY).run();
    if ((up?.meta?.changes ?? 0) === 0) return json({ error: "Hôm nay bạn đã dùng hết " + AI_LIMIT_PER_DAY + " lượt AI. Mai dùng tiếp nhé." }, 429);
    const dungKyma = env.AI_PROVIDER === "kyma" || !env.GEMINI_API_KEY;
    let res;
    try {
      if (dungKyma) {
        const mac_dinh = /^[A-Za-z0-9._/-]{3,80}$/.test(env.KYMA_MODEL || "") ? env.KYMA_MODEL : KYMA_MODEL;
        const kmodel = KYMA_THU.includes(data.model) ? data.model : mac_dinh; // cho phép chọn thử trong danh sách đã duyệt để đo tốc độ
        res = await fetch("https://kymaapi.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${String(env.KYMA_API_KEY).trim()}` },
          body: JSON.stringify({
            model: kmodel,
            temperature: 0.9,
            max_tokens: 1500,
            messages: [{ role: "user", content: [{ type: "text", text: aiPrompt(nhom) }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }],
          }),
        });
      } else {
        const model = /^[a-z0-9.-]{3,60}$/.test(env.GEMINI_MODEL || "") ? env.GEMINI_MODEL : AI_MODEL;
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": String(env.GEMINI_API_KEY).trim() },
          body: JSON.stringify({
            contents: [{ parts: [{ text: aiPrompt(nhom) }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
            generationConfig: { temperature: 0.9, responseMimeType: "application/json" },
          }),
        });
      }
    } catch {
      return json({ error: "AI đang bận. Bạn thử lại sau nhé." }, 502);
    }
    if (!res.ok) return json({ error: "AI đang bận. Bạn thử lại sau nhé.", ma: (dungKyma ? "kyma-" : "gemini-") + res.status }, 502);
    let cau = [];
    try {
      const out = await res.json();
      const text = dungKyma
        ? out?.choices?.[0]?.message?.content ?? ""
        : out?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
      cau = loc(JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")));
    } catch {
      cau = [];
    }
    if (!cau.length) return json({ error: "AI chưa viết được câu phù hợp. Bạn bấm thử lại nhé.", ma: "khong-ra-cau" }, 502);
    return json({ ok: true, cau });
  } catch {
    return json({ error: "Chưa dùng được AI. Bạn thử lại sau nhé." }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAi = url.pathname === "/api/ai-cau";
    if (url.pathname !== "/api/trial" && !isAi) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (request.headers.get("origin") !== url.origin) return json({ error: "Yêu cầu không hợp lệ." }, 403);
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Dữ liệu không hợp lệ." }, 415);
    let data;
    try {
      const text = await request.text();
      if (text.length > (isAi ? AI_MAX_IMAGE + 2048 : 2048)) return json({ error: "Dữ liệu quá dài." }, 413);
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
    if (isAi) return aiCau(db, env, email, data, now);
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
