# Ảnh demo cho README

`npm run demo:screenshots` dựng lại 7 ảnh trong [`docs/images/`](../../docs/images/) bằng dữ liệu hư cấu:

1. Seed một `dataDir` tạm ở `.demo/` (đã gitignore) với công ty BookNhanh và các khách hàng giả, mọi email đều dùng đuôi `.example`.
2. Chạy một daemon riêng ở port `7318`, không đụng daemon hay dữ liệu thật của bạn.
3. Nạp hồ sơ công ty và kiến thức của SDR, Account Manager, Chánh văn phòng từ `fixtures/`, bật outbound.
4. Chụp UI bằng Playwright (1440px, độ phân giải 2x), rồi tắt daemon.

## Dữ liệu được seed

Mọi thứ ghi thẳng vào DB, không gọi model: daemon demo không có việc nào ở trạng thái `queued`, nên không có gì chạy `agy` thật.

- **Mai** (SDR, `autonomous`): 3 ảnh gốc (inbound, email đã gửi, dòng thời gian của chị Hà), cộng khách Pilates Sen Vàng đi hết đường từ chào hàng tới chốt gói.
- **Bàn giao SDR → Account Manager**: Mai gọi `handoffContact` cho chị Châu (Pilates Sen Vàng); contact thành `customer`, chủ sở hữu là **Linh**, có lịch sử bàn giao và task onboarding kèm bản nháp chào mừng đang chờ duyệt.
- **Linh** (Account Manager, `shadow`): 4 khách đang dùng, 15 tin nhắn hỗ trợ, 4 check-in (đã duyệt, sửa, từ chối, chờ duyệt) và một yêu cầu hoàn tiền đang chờ chủ quyết định.
- **Nam** (SDR thứ hai, `shadow`): 5 email chào hàng, mới 4 bản được duyệt nên kết luận là "chưa đủ dữ liệu".
- **Phúc** (Chánh văn phòng, `autonomous`): 3 thư lạ được phân loại (2 giao cho Mai, 1 thư prompt injection chuyển cho chủ) và 3 bản tin hằng ngày. Bản tin hôm nay viết từ snapshot tính bằng chính hàm của daemon (`buildDigestSnapshot`), nên số liệu khớp với Dashboard và trang Shadow run.
- **Shadow run**: ngày 7/14 cho Linh và Nam.
- KPI "Median first response" của Linh hiện "—" vì Linh ở shadow, chưa gửi thư nào.

Seed tắt giờ yên lặng (`quietHours: null`) để nhãn "quiet hours" không xuất hiện nếu bạn chụp vào buổi tối.

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
| `-- --only sent` | chỉ chụp một ảnh: `inbound`, `sent`, `contact`, `handoff`, `kpis`, `briefing` hoặc `shadow` |
| `-- --keep` | giữ daemon demo chạy để xem quanh UI (token nằm ở `.demo/data/admin-token`) |
| `DEMO_PORT=7400` | đổi port nếu `7318` đang bận |
| `DEMO_CHROMIUM_PATH=...` | dùng một Chromium có sẵn thay vì bản Playwright tải về |

## Sửa nội dung

| Muốn đổi | Sửa ở |
|---|---|
| Khách hàng, email, task, thời gian | [`seed.ts`](seed.ts). Thời gian tính tương đối so với lúc chạy (`at(phútTrước)`). |
| Hồ sơ công ty BookNhanh, bảng giá | [`fixtures/company-profile.json`](fixtures/company-profile.json) |
| Kiến thức riêng của SDR | [`fixtures/role-kb.json`](fixtures/role-kb.json) |
| Kiến thức của Account Manager, Chánh văn phòng | [`fixtures/role-kb-am.json`](fixtures/role-kb-am.json), [`fixtures/role-kb-cos.json`](fixtures/role-kb-cos.json). Cần có, vì readiness từ chối bật outbound khi KB của một vai trò còn chữ TODO. |
| Trang nào được chụp, cắt bao nhiêu | bảng `SHOTS` trong [`screenshots.ts`](screenshots.ts) |

Thêm ảnh mới: thêm một mục vào `SHOTS` (tên file, cách đưa trang về đúng trạng thái, cách cắt: `clipHeight` hoặc `clipTo` là một selector; `viewportHeight` nếu trang dài, vì app cuộn bên trong layout của nó), rồi chèn ảnh vào README.

Giữ nguyên quy ước: chỉ dùng tên và công ty hư cấu, email đuôi `.example`, và ghi rõ dưới ảnh trong README rằng đó là dữ liệu minh hoạ.
