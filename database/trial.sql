-- Bảng dùng thử cho Xưởng Ảnh Thương Hiệu. Dùng chung kho `skilldrop-customers` (bảng customers, customer_events đã có).
-- Chạy một lần trong D1 Console. Không đụng dữ liệu cũ.
CREATE TABLE IF NOT EXISTS app_trials (
  app TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_until TEXT,
  note TEXT,
  PRIMARY KEY (app, email)
);

-- Mở khoá cho khách đã trả phí (đổi email và ngày):
-- UPDATE app_trials SET paid_until='2027-11-26T23:59:59.000Z', note='đã chuyển khoản' WHERE app='xuong-anh' AND email='khach@example.com';
-- Khoá lại: UPDATE app_trials SET paid_until=NULL WHERE app='xuong-anh' AND email='khach@example.com';
