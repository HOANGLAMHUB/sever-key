# KeyServer

Server key **độc lập, dùng chung được cho nhiều hub/script** (SIKE_HUB, SIKEMOD_HUB, hay bất kỳ script Lua nào sau này) — không dính vào 1 project cụ thể nữa. Đã gắn sẵn **database free thật (Upstash Redis)** thay vì file JSON hay mất dữ liệu.

Luồng hoạt động: `Script Lua → /api/getlink → user vượt link Link4m → getkey.html → /api/redeem (cấp key) → Script Lua gọi /api/verify mỗi lần chạy`.

## Vì sao chọn Upstash Redis làm database free

| Tiêu chí | Upstash Redis |
|---|---|
| Giá | Free vĩnh viễn, **không cần thẻ ngân hàng** |
| Giới hạn free | 10.000 lệnh/ngày, 256MB — dư sức cho vài trăm-nghìn key |
| Cách gọi | REST API qua HTTPS (không cần giữ kết nối) → hợp hoàn toàn với Render free (hay sleep/restart) |
| Độ bền | Dữ liệu **không mất** khi Render redeploy/restart (khác với file JSON cũ) |

## Bước 1 — Tạo database free (Upstash)

1. Vào **upstash.com** → Sign up (dùng GitHub cho nhanh) → miễn phí, không cần thẻ.
2. Bấm **Create Database** → đặt tên tuỳ ý → chọn **Region** gần Render nhất (ví dụ Singapore/Mumbai nếu Render deploy ở đó) → Create.
3. Vào database vừa tạo → tab **REST API** → copy 2 giá trị:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

Giữ lại 2 giá trị này, dùng ở bước 3.

## Bước 2 — Lấy API token Link4m

Đăng nhập **link4m.co** → phần API → copy token (dùng cho biến `LINK4M_API`).

## Bước 3 — Deploy server lên Render (free)

1. Đưa toàn bộ project này lên 1 repo GitHub mới.
2. Bật **GitHub Pages** cho thư mục `docs/`: Settings → Pages → Source: branch `main` / folder `/docs` → có link dạng `https://tenban.github.io/reponame`.
3. Trên Render: **New → Blueprint** → chọn repo này (đã có sẵn `render.yaml` nên Render tự nhận cấu hình) — hoặc **New → Web Service** thủ công với Root Directory = `server`, Build = `npm install`, Start = `npm start`.
4. Điền Environment Variables:

| Biến | Bắt buộc? | Giá trị |
|---|---|---|
| `LINK4M_API` | Có | token lấy ở Bước 2 |
| `SITE_URL` | Có | link GitHub Pages ở bước 2 (không có `/` cuối) |
| `KEY_TTL_HOURS` | Không | mặc định `48` |
| `UPSTASH_REDIS_REST_URL` | **Nên có** | lấy ở Bước 1 (không điền → tự fallback về file, mất dữ liệu khi redeploy) |
| `UPSTASH_REDIS_REST_TOKEN` | **Nên có** | lấy ở Bước 1 |
| `ADMIN_KEY` | Không | tự đặt chuỗi bí mật dài, để mở khoá `admin.html` |
| `DISCORD_WEBHOOK` | Không | bật thông báo Discord khi có key mới |

5. Deploy → có link server `https://xxx.onrender.com`. Gọi thử `GET /` → thấy `"storage":"upstash-redis"` là đã cắm DB free thành công (nếu ghi `"local-file"` nghĩa là chưa điền đúng 2 biến Upstash).

## Bước 4 — Sửa link server trong các file tĩnh

Mở và sửa dòng `const SERVER_URL = "..."` thành link Render thật ở 2 file:
- `docs/getkey.html`
- `docs/admin.html`

Commit + push, GitHub Pages tự cập nhật sau ~1 phút.

## Dùng chung 1 server cho nhiều script Lua

Bất kỳ script nào (SIKE_HUB, SIKEMOD_HUB, script mới sau này...) chỉ cần gọi đúng 2 API sau, không cần server riêng cho từng script:

```lua
local SERVER = "https://xxx.onrender.com" -- doi thanh link server that
local HWID = game:GetService("RbxAnalyticsService"):GetClientId()

-- kiem tra key da luu (vd doc tu writefile) truoc, neu chua co thi:
local link = game:HttpGet(SERVER.."/api/getlink?hwid="..HWID)
-- huong dan nguoi dung mo link, vuot Link4m, nhan key ben trang getkey.html

-- moi lan script chay, kiem tra key:
local res = game:HttpGet(SERVER.."/api/verify?key="..KEY.."&hwid="..HWID)
-- parse JSON, neu valid=false thi khoa tinh nang / bat nhap key lai
```

> Tui chỉ hỗ trợ phần **gọi API key-check** này (đoạn trên) cho các script — không chỉnh sửa/thêm tính năng cheat bên trong bản thân từng script.

## Admin Dashboard

Mở `docs/admin.html` (đã sửa `SERVER_URL`) → nhập `ADMIN_KEY` → quản lý:
- Xem thống kê (key active, sắp hết hạn, tổng đã cấp)
- Tìm / **Revoke** / **Gia hạn** key
- **Cấp key thủ công** (VIP, không cần vượt link) — nhập HWID + số giờ

## API tham khảo

| Endpoint | Gọi bởi | Chức năng |
|---|---|---|
| `GET /` | test | health check, cho biết đang dùng `upstash-redis` hay `local-file` |
| `GET /api/getlink?hwid=...` | script | tạo token 1 lần + link Link4m |
| `GET /api/redeem?hwid=...&token=...` | getkey.html | cấp key theo `KEY_TTL_HOURS`, gắn HWID |
| `GET /api/verify?key=...&hwid=...` | script | kiểm tra key: đúng máy + còn hạn |
| `GET /api/admin/stats?admin=...` | admin.html | thống kê tổng quan |
| `GET /api/admin/keys?admin=...&q=...` | admin.html | danh sách key (lọc theo key/HWID) |
| `GET /api/admin/revoke?admin=...&key=...` | admin.html | thu hồi key |
| `GET /api/admin/extend?admin=...&key=...&hours=24` | admin.html | gia hạn key |
| `GET /api/admin/create?admin=...&hwid=...&hours=48` | admin.html | cấp key thủ công (VIP) |

## Rate limit sẵn có

- `/api/getlink`: 60s/lần/HWID + tối đa 10 request/phút/IP
- `/api/verify`: tối đa 60 request/phút/IP
