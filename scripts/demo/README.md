# Ảnh demo cho README

`npm run demo:screenshots` dựng lại 3 ảnh trong [`docs/images/`](../../docs/images/) bằng dữ liệu hư cấu:

1. Seed một `dataDir` tạm ở `.demo/` (đã gitignore) với công ty BookNhanh và các khách hàng giả, mọi email đều dùng đuôi `.example`.
2. Chạy một daemon riêng ở port `7318`, không đụng daemon hay dữ liệu thật của bạn.
3. Nạp hồ sơ công ty và kiến thức SDR từ `fixtures/`, bật outbound.
4. Chụp UI bằng Playwright (1440px, độ phân giải 2x), rồi tắt daemon.

## Chạy

Cần build UI trước (`npm run build`). Lần đầu, tải Chromium cho Playwright:

```bash
npx playwright install chromium
```

```bash
npm run demo:screenshots
```

Tuỳ chọn:

| | |
|---|---|
| `-- --only sent` | chỉ chụp một ảnh: `inbound`, `sent` hoặc `contact` |
| `-- --keep` | giữ daemon demo chạy để xem quanh UI (token nằm ở `.demo/data/admin-token`) |
| `DEMO_PORT=7400` | đổi port nếu `7318` đang bận |
| `DEMO_CHROMIUM_PATH=...` | dùng một Chromium có sẵn thay vì bản Playwright tải về |

## Sửa nội dung

| Muốn đổi | Sửa ở |
|---|---|
| Khách hàng, email, task, thời gian | [`seed.ts`](seed.ts). Thời gian tính tương đối so với lúc chạy (`at(phútTrước)`). |
| Hồ sơ công ty BookNhanh, bảng giá | [`fixtures/company-profile.json`](fixtures/company-profile.json) |
| Kiến thức riêng của SDR | [`fixtures/role-kb.json`](fixtures/role-kb.json) |
| Trang nào được chụp, cắt bao nhiêu | bảng `SHOTS` trong [`screenshots.ts`](screenshots.ts) |

Thêm ảnh mới: thêm một mục vào `SHOTS` (tên file, cách đưa trang về đúng trạng thái, chiều cao cắt nếu cần), rồi chèn ảnh vào README.

Giữ nguyên quy ước: chỉ dùng tên và công ty hư cấu, email đuôi `.example`, và ghi rõ dưới ảnh trong README rằng đó là dữ liệu minh hoạ.
