# Cấu hình hộp thư thật cho agy-hq (IMAP/SMTP)

Tài liệu này dành cho người chạy **shadow run** đầu tiên trên hộp thư thật. Quy trình vận hành 2 tuần xem
[SHADOW-RUN.md](SHADOW-RUN.md). Phần kỹ thuật chung: [TECHNICAL.md](TECHNICAL.md) ("Configure email").

## 1. Những gì agy-hq làm (và không làm) với hộp thư của bạn

- **Chỉ đọc.** Hộp thư được mở bằng `EXAMINE` (read-only) và thư được tải bằng `BODY.PEEK[]`: thư **không bị đánh dấu
  đã đọc**, không bị di chuyển, xóa, gắn cờ. Không dùng IDLE. Lệnh ghi duy nhất có thể xảy ra là `APPEND` bản sao thư *do
  chính agy-hq gửi* vào `sentFolder`, và chỉ khi bạn đặt `sentFolder` (mặc định là `null`).
- **Không gửi gì trong shadow.** Agent ở tier `shadow`: người duyệt bấm "Approve" thì bản nháp chuyển sang `held` (trạng
  thái cuối, không bao giờ gửi). Ngoài ra: kill switch `outboundEnabled` mặc định tắt; Sender từ chối mọi thư của agent
  đang ở tier shadow (kể cả khi agent bị hạ tier sau khi đã approve); thư bị đánh dấu "superseded" cũng bị chặn.
- **Lần đồng bộ đầu tiên không nuốt lịch sử.** Mặc định (`initialSyncDays: 0`) chỉ xử lý thư **đến sau lúc kết nối lần
  đầu**; vài nghìn thư cũ trong hộp thư không bao giờ bị đụng tới. Muốn xử lý N ngày gần nhất: đặt `initialSyncDays`
  (tối đa 90; giới hạn cứng `initialSyncMaxMessages`, mặc định 200, lấy thư mới nhất trước).
- **Đồng bộ thư mục Sent (tùy chọn, mặc định tắt).** Trong shadow, người thật vẫn trả lời khách từ Gmail/Outlook, agent
  không biết. Bật `syncSent: true` để agy-hq đọc thư mục Sent và: ghi lại thư người đó gửi vào lịch sử hội thoại (agent
  thấy trong `threadSummary`: "A teammate replied from their own mail client ..."), hủy các task follow-up đang chờ của
  thread đó, hủy task trả lời chưa chạy cho đúng thư vừa được trả lời, chuyển contact `new/researching/qualified` sang
  `contacted`, tính là một "lần chạm" trong pipeline review, và đánh dấu các bản nháp pending/approved/held viết **trước**
  thư của người thật là `superseded: ...` (xem ở trang Inbox, cột trạng thái). Bản nháp đã `approved` mà bị superseded
  sẽ bị Sender chặn; nếu bạn Approve lại một bản nháp pending bị superseded thì đó là quyết định có chủ đích và dấu bị gỡ.
  **Quyền riêng tư:** chỉ lưu thư liên quan (tiếp nối một thread đã biết, hoặc gửi cho contact đã có trong CRM). Thư cá
  nhân/không liên quan trong Sent **không được lưu**.
- Thư lỗi định dạng (tiếng Việt UTF-8, RFC 2047, quoted-printable, base64, windows-1258, HTML-only, file đính kèm) đều đã
  được kiểm thử với server IMAP/SMTP thật chạy cục bộ.

Cấu hình (`agyhq.config.json`, hoặc trang Setup; mật khẩu đặt bằng biến môi trường `AGYHQ_IMAP_PASS`, `AGYHQ_SMTP_PASS`):

```jsonc
"email": {
  "kind": "imap-smtp",
  "address": "sales@congty.vn",
  "displayName": "Mai",
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "sales@congty.vn", "pass": "" },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "sales@congty.vn", "pass": "" },
  "mailbox": "INBOX",
  "sentFolder": null,          // chỉ đặt nếu nhà cung cấp KHÔNG tự lưu thư gửi qua SMTP (xem bảng dưới)
  "syncSent": true,            // đọc thư mục Sent (tự nhận diện: \Sent, "[Gmail]/Sent Mail", "Sent Items", "Sent", ...)
  "initialSyncDays": 0,        // 0 = chỉ thư đến từ bây giờ; N = thêm N ngày gần nhất
  "initialSyncMaxMessages": 200,
  "pollIntervalMs": 60000
}
```

`sentFolder` đặt tường minh cũng được dùng làm thư mục Sent để đồng bộ. Nếu tự nhận diện sai, đặt tên chính xác (xem
danh sách thư mục thật bằng `hq email doctor`).

## 2. `hq email doctor` — kiểm tra trước khi chạy

```sh
npm run hq -- email doctor                       # daemon đang chạy: dùng cấu hình đã lưu (kể cả trang Setup)
npm run hq -- email doctor --local               # không cần daemon: đọc agyhq.config.json + AGYHQ_*_PASS
npm run hq -- email doctor --sample 20           # phân tích 20 thư mới nhất
npm run hq -- email doctor --send-test you@gmail.com   # CHỈ khi bạn truyền cờ này mới gửi đúng 1 thư thử
npm run hq -- email doctor --json
```

Tương đương qua API: `POST /v1/admin/email/doctor {"sample":10,"sendTest":"..."}`.

Nó kiểm tra (chỉ đọc, không tạo/gửi gì, không in mật khẩu): đăng nhập IMAP; mở hộp thư read-only; tìm thư mục Sent;
dự báo lần đồng bộ đầu sẽ nhận bao nhiêu thư (và số thư 1/3/7/14/30 ngày gần đây để bạn chọn `initialSyncDays`); tải và
parse N thư mới nhất, cho biết **phân loại** (reply / new_lead / auto_reply / bounce / unsubscribe / spam) và
**sẽ chuyển cho agent nào, task gì** (dry-run, không tạo gì); xác thực SMTP **không gửi**; và an toàn shadow (kill switch,
tier của các agent). Mã thoát 1 nếu có check lỗi.

Đọc kỹ cảnh báo `routing.dry_run`: nếu phần lớn thư mẫu là newsletter/thông báo, mỗi thư sẽ thành một *lead mới* và một
task research. Nên dùng một địa chỉ riêng cho sales thay vì hộp thư chung.

## 3. Ghi chú theo nhà cung cấp

Chung: dùng **mật khẩu ứng dụng (app password)** hoặc mật khẩu IMAP/SMTP riêng, không dùng mật khẩu đăng nhập thường;
cổng IMAP 993 + `secure: true`, SMTP 465 + `secure: true` (hoặc 587 + `secure: false`, STARTTLS). Sai tổ hợp cổng/secure
sẽ báo "TLS handshake failed". Sai mật khẩu agy-hq **không thử lại** (tránh bị khóa tài khoản) và báo gợi ý rõ ràng.

| | Gmail / Google Workspace | Microsoft 365 / Outlook | Zoho Mail |
|---|---|---|---|
| IMAP | `imap.gmail.com:993` | `outlook.office365.com:993` | `imap.zoho.com:993` (EU: `imap.zoho.eu`, VN/IN: `.in`, theo vùng dữ liệu) |
| SMTP | `smtp.gmail.com:465` | `smtp.office365.com:587` (`secure:false`, STARTTLS) | `smtp.zoho.com:465` |
| Mật khẩu | App password (cần bật xác minh 2 bước). Workspace: admin phải cho phép. | Basic auth bị tắt mặc định ở nhiều tenant: admin bật **Authenticated SMTP** cho mailbox; IMAP basic auth có thể bị chặn hoàn toàn (OAuth chưa được hỗ trợ) | App-Specific Password (khi bật 2FA) |
| Bật IMAP | Settings > Forwarding and POP/IMAP > Enable IMAP (tài khoản Workspace: admin có thể tắt) | Exchange admin center > Mailbox > Manage email apps: bật IMAP | Settings > Mail Accounts > IMAP Access |
| Thư mục Sent | `[Gmail]/Sent Mail` (có cờ `\Sent`; tên theo ngôn ngữ giao diện nhưng cờ vẫn đúng) | `Sent Items` (cờ `\Sent`) | `Sent` (cờ `\Sent`) |
| `sentFolder` (append bản sao thư agy-hq gửi) | `null`: Gmail tự lưu thư gửi qua SMTP, append sẽ bị trùng | `null`: Exchange tự lưu | Đặt `"Sent"` nếu thư gửi không thấy trong Sent |
| Giới hạn | ~500 thư/ngày (Gmail thường), ~2.000/ngày (Workspace); giới hạn băng thông IMAP ~2,5 GB/ngày tải xuống; quá sẽ bị khóa tạm | 30 thư/phút, 10.000 người nhận/ngày; IMAP bị throttle khi mở quá nhiều kết nối | ~50 người nhận/thư, giới hạn ngày theo gói (~500 gói free) |
| Lưu ý | Gmail "nhãn" ≠ thư mục: INBOX chỉ chứa thư có nhãn Inbox. Mỗi thư chỉ có 1 UID trong mỗi thư mục. | Dùng shared mailbox cần `user` dạng `mailbox\user`/quyền Full Access; kết nối dài có thể bị ngắt sau ~30 phút (agy-hq tự kết nối lại) | Tên thư mục tiếng Việt hiển thị có thể khác; dùng cờ `\Sent` |

Con số giới hạn thay đổi theo gói/thời điểm; hãy xem trang chính thức của nhà cung cấp trước khi bật gửi thật. Trong
shadow run bạn không gửi gì nên chỉ cần quan tâm giới hạn IMAP (agy-hq thăm dò mỗi 60 giây, mỗi lần ~vài lệnh).

## 4. Việc người vận hành phải làm trước khi bắt đầu shadow run

1. Tạo mật khẩu ứng dụng / bật IMAP (bảng trên); đặt `AGYHQ_IMAP_PASS`, `AGYHQ_SMTP_PASS` trong môi trường chạy daemon.
2. Chạy `hq email doctor --sample 20` (không cần daemon: thêm `--local`). Mọi dòng phải là ✓; đọc các dòng `!`.
3. Xác nhận thư mục Sent được tìm đúng (dòng `imap.sent_folder`); nếu bật `syncSent`, kiểm tra tên thư mục.
4. Chọn `initialSyncDays` dựa trên số thư doctor báo; để mặc định `0` nếu không chắc.
5. Chạy `hq email doctor --send-test <địa chỉ của bạn>` **một lần** để chắc rằng SMTP gửi được và thư tới nơi.
6. Xác nhận mọi agent ở tier `shadow` và kill switch `outboundEnabled` đang tắt (dòng `safety.shadow` phải ✓).
7. Nên dùng địa chỉ sales riêng (không phải hộp thư chung đầy newsletter); mỗi thư lạ sẽ thành lead + task research.
8. Sau khi daemon chạy vài phút: gửi một thư thử từ địa chỉ khác vào hộp thư, kiểm tra nó xuất hiện ở trang Inbound
   (và thư gốc vẫn **chưa đọc** trong hộp thư); nếu bật `syncSent`, trả lời thử từ Gmail và kiểm tra thread có dòng
   "A teammate replied ..." ở task kế tiếp.
9. Tắt cập nhật tự động, đặt hẹn sao lưu `data/` (chứa agyhq.db, secret.key, admin-token).

## 5. Test bed (cho người phát triển)

`packages/channels/test/support/mail-servers.ts` khởi động trong tiến trình một server IMAP thật
([hoodiecrow-imap](https://github.com/andris9/hoodiecrow), lưu trong bộ nhớ, có SPECIAL-USE) và một server SMTP thật
([smtp-server](https://nodemailer.com/extras/smtp-server/)) trên 127.0.0.1, để ImapFlow và nodemailer chạy đúng giao
thức như với Gmail. Không giả lập được: nhãn/`X-GM-*` của Gmail, giới hạn tốc độ, TLS/chứng chỉ, OAuth, đẩy IDLE.
`hoodiecrow-imap` ít được bảo trì (2022) nhưng ổn định cho IMAP4rev1; nếu sau này cần giả lập chính xác hơn, thay thế
chỉ cần đổi file support này. Chạy: `npx vitest run packages/channels packages/server/test/email-*.test.ts`.
Test opt-in với hộp thư thật: `packages/channels/test/real-email.test.ts` (`AGYHQ_EMAIL_TEST=1`).
