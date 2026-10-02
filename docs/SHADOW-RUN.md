# Runbook: chạy thử shadow 2 tuần

Tài liệu này dành cho **người duyệt** (bạn) trong 2 tuần đầu: nhân viên AI đọc email thật và soạn nháp, bạn duyệt / sửa / từ chối, **không có gì được gửi đi**. Hết 2 tuần, bạn nhìn tỷ lệ duyệt và tỷ lệ phải sửa để quyết định có nâng nhân viên lên `assisted` (bạn duyệt rồi mới gửi) hay chưa.

> Trong chế độ `shadow`, bấm **Approve** chỉ ghi lại "tôi thấy bản nháp này ổn" (trạng thái `held`). Bản nháp **không bao giờ** được gửi, kể cả sau này bạn nâng cấp nhân viên. Muốn gửi thật, bạn copy nội dung sang hộp thư của mình và gửi tay.

Một "shadow run" là một mốc thời gian có điểm bắt đầu và độ dài dự kiến (mặc định 14 ngày). Daemon tính **ngày N / M**, số liệu của từng nhân viên và một kết luận (`on track` / `not enough data` / `below bar`) từ chính dữ liệu duyệt của bạn. Nó không tự kết thúc và không tự nâng cấp ai.

---

## 1. Trước ngày 1 (checklist)

- [ ] **Hộp thư thật đã nối xong.** Làm theo [`docs/EMAIL-SETUP.md`](EMAIL-SETUP.md) (IMAP/SMTP, mật khẩu ứng dụng, thư mục Sent…), rồi chạy `npm run hq -- email doctor` và sửa tới khi không còn mục đỏ. Chưa có hộp thư thật thì đừng bắt đầu: run sẽ trống.
- [ ] **Hồ sơ công ty + kiến thức SDR đã áp dụng** (trang **Setup**). Bảng giá, danh sách "cấm nói" và người ký tên phải đúng; đây là thứ quyết định chất lượng nháp.
- [ ] **Readiness không còn lỗi đỏ**: `npm run hq -- readiness`.
- [ ] **Outbound để TẮT** (mặc định). Kiểm tra: `npm run hq -- status` phải ghi `outboundEnabled: false`. Trong shadow bạn không cần bật nó.
- [ ] **Tạo nhân viên** (mặc định đều là `shadow`):

  ```bash
  npm run hq -- agent create sdr-01 --role sales-sdr --display-name Mai
  npm run hq -- agent create am-01  --role account-manager --display-name Linh   # nếu đã có khách đang dùng
  npm run hq -- agent create cos-01 --role chief-of-staff --display-name Khoa    # bản tin buổi sáng + phân loại thư lạ
  ```

- [ ] **Đặt mặc định** (Settings, hoặc CLI) để thư đến biết giao cho ai:

  ```bash
  npm run hq -- settings set defaultSdrAgentId '"sdr-01"'
  npm run hq -- settings set defaultAmAgentId  '"am-01"'
  npm run hq -- settings set defaultCosAgentId '"cos-01"'
  ```

- [ ] **Bản tin hằng ngày** của Chánh văn phòng (08:00 giờ Việt Nam). Bản tin sẽ có mục shadow: ngày N/M, hôm qua bạn duyệt / sửa / từ chối bao nhiêu bản, nhân viên nào dưới ngưỡng, bản nháp nào chờ lâu nhất.

  ```bash
  npm run hq -- routine create --agent cos-01 --kind daily_digest --name "Bản tin sáng" --schedule "0 8 * * *" --config '{"lookbackHours":24}'
  ```

- [ ] (Tuỳ chọn) Routine `prospecting` cho SDR nếu bạn muốn nó chủ động tìm lead đã có trong CRM.
- [ ] **Có cách gửi tay**: mở sẵn hộp thư của bạn để copy các bản nháp đã duyệt (tab **Held** trong Inbox).
- [ ] Chốt **người duyệt** và **khung giờ**: 2 lần/ngày mỗi lần 10 phút tốt hơn 1 lần 1 tiếng, vì bản nháp chờ lâu sẽ lỗi thời.

## 2. Bắt đầu run

Trang **Shadow run** → **Start shadow run** (chọn số ngày, nhân viên, ghi chú), hoặc:

```bash
npm run hq -- shadow start --days 14 --notes "Pilot đầu tiên, hộp thư sdr@congty.vn"
```

Mặc định run bao gồm mọi nhân viên SDR / Account Manager đang ở tier `shadow` (Chánh văn phòng không soạn email nên không nằm trong đó). Chỉ nhân viên `shadow` mới vào được run; nhân viên đã `assisted` sẽ bị từ chối vì nháp của họ có thể được gửi đi thật.

Xem tình hình bất cứ lúc nào: card **Shadow run** trên Dashboard, trang **Shadow run**, hoặc `npm run hq -- shadow status [--daily]`.

## 3. Việc hằng ngày (15–20 phút)

1. **Đọc bản tin sáng** (trang **Briefings**, 2 phút). Mục "Cần anh/chị xử lý hôm nay" cho biết thứ tự ưu tiên. Nếu bản nháp đang dồn lại, nó nằm ở đây.
2. **Duyệt hàng chờ trong Inbox** (10–15 phút cho 20–50 bản nháp). Hàng chờ xếp **cũ nhất trước**; có thể lọc theo nhân viên.

   | Bạn thấy | Làm |
   |---|---|
   | Ổn | `A` (Approve) |
   | Gần ổn, sửa vài chữ | Sửa trực tiếp rồi bấm **Save & approve** (hoặc `A`): bản sửa được lưu **trước** khi duyệt, và đó chính là dữ liệu "approved with edits" dùng để đo tỷ lệ sửa. Đừng copy bản sửa đi nơi khác rồi bấm Approve bản gốc, hệ thống sẽ tưởng nháp hoàn hảo. |
   | Không dùng được | `R` rồi phím `1`–`8` chọn **nhóm lỗi** (factual error, tone, too long, not personalized, wrong recipient, bad timing, compliance, other), rồi `Ctrl/⌘+Enter`. Một dòng góp ý là tuỳ chọn nhưng **rất đáng viết**: nó thành bộ nhớ của nhân viên ("giọng hơi ép", "đừng nhắc giá khi chưa được hỏi"). |
   | Nháp bị đánh dấu lỗi lint đỏ | Sửa rồi lưu, hoặc từ chối. Lint đỏ chặn nút Approve. |
   | Có hai bản nháp giống nhau cho cùng một người | Duyệt một, từ chối bản còn lại (nhóm `other`, ghi "trùng"). Xem mục 7. |

   `J` / `K` chuyển giữa các nháp. Sau khi quyết định, Inbox tự nhảy sang nháp kế tiếp.
3. **Xử lý "Tasks waiting for your decision"** ở đầu Inbox: đó là những việc agent không dám tự quyết (hoàn tiền, hợp đồng, SLA, khách giận…). Đọc, trả lời bằng tay nếu cần, rồi đánh dấu hoàn thành trong trang task.
4. **Gửi tay** các bản đã duyệt mà bạn muốn gửi thật: tab **Held**, copy sang hộp thư của bạn. (Không bắt buộc; mục đích của run là chấm điểm, không phải gửi.)
5. **Nhìn card Shadow run** 30 giây: còn bản chờ không? ai dưới ngưỡng? Mục tiêu: hết ngày thì hàng chờ gần như về 0.

Mẹo: tối đa 3–4 phút cho mỗi bản khó; không chắc thì từ chối kèm nhóm `other` còn hơn để nó nằm đó, vì bản chờ lâu làm lệch thời gian duyệt trung bình.

## 4. Việc hằng tuần (30 phút, cuối tuần 1 và tuần 2)

1. `npm run hq -- shadow status --daily`: xem xu hướng từng ngày (nháp mới, duyệt nguyên bản, duyệt có sửa, từ chối). Xu hướng đi đúng là **tỷ lệ từ chối và tỷ lệ sửa giảm dần** nhờ nhân viên học từ góp ý của bạn.
2. **Đọc nhóm lỗi bị từ chối nhiều nhất** (trang Shadow run → "Rejection reasons"). Sửa tận gốc:
   - `factual_error` / `compliance` → thêm vào bảng giá, KB hoặc danh sách "cấm nói" (Setup, Knowledge).
   - `tone` / `too_long` → sửa `AGENTS.md` / rule của template, hoặc thêm ví dụ vào KB vai trò.
   - `not_personalized` → bổ sung thông tin lead (CRM) hoặc bật nghiên cứu kỹ hơn.
3. **Xem bộ nhớ nhân viên đã học** (`npm run hq -- memory list --agent sdr-01`). Lý do từ chối tự thành bộ nhớ "accepted"; xoá những dòng sai hoặc quá riêng lẻ.
4. Xem **Scorecards** để đối chiếu với ngưỡng thăng cấp (mục 6) và đọc kết luận từng nhân viên.
5. Ghi chú vào run nếu có thay đổi lớn giữa chừng (đổi KB, đổi model) để cuối kỳ còn nhớ vì sao số liệu nhảy.

## 5. Kết luận của hệ thống nghĩa là gì

Mỗi nhân viên có đúng một kết luận kèm lý do có số liệu:

| Kết luận | Điều kiện |
|---|---|
| **Below bar** | Có một vụ `compliance` vượt giới hạn (bất kể số lượng), **hoặc** đã có ít nhất `min(minDecided, 10)` bản được quyết định mà tỷ lệ duyệt thấp hơn ngưỡng / tỷ lệ sửa (median) cao hơn ngưỡng; lỗi lint cũng tính khi đủ số bản nháp. |
| **Not enough data** | Chưa đủ số bản được quyết định để đánh giá các tỷ lệ, **hoặc** chất lượng ổn nhưng với tốc độ hiện tại sẽ không đủ số bản tối thiểu vào hết run. |
| **On track** | Các tỷ lệ đạt ngưỡng trên mẫu đủ lớn, và số bản được quyết định đã đạt (hoặc nhịp hiện tại sẽ đạt) mức tối thiểu. |

Các con số là **chưa có số liệu** (`—`) khi không có dữ liệu, không bao giờ hiển thị 0 giả. Kết luận chỉ là gợi ý: quyết định thăng cấp vẫn là của bạn.

## 6. Quyết định thăng cấp (ngày cuối)

Tiêu chí mặc định (trang **Scorecards** → *Promotion criteria*, chỉnh được):

| Tiêu chí | Mặc định |
|---|---|
| Số bản đã quyết định (duyệt + từ chối) | ≥ 30 |
| Tỷ lệ duyệt (duyệt / đã quyết định) | ≥ 85% |
| Tỷ lệ sửa trung vị (median edit ratio) của bản đã duyệt | ≤ 15% |
| Bị từ chối nhóm `compliance` | 0 |
| Tỷ lệ bản nháp dính lỗi lint chặn | ≤ 5% |

Nếu công ty ít email, 30 bản trong 14 ngày có thể không đạt: hạ `minDecided` có chủ đích (ghi lý do vào ghi chú của run) hoặc kéo dài run.

Cách làm:

1. Sang ngày 14, trang Shadow run hiện "planned length reached". Đọc kết luận từng nhân viên.
2. `npm run hq -- shadow end --notes "sdr-01 lên assisted; am-01 ở lại shadow thêm 1 tuần"`. (Kết thúc run **không** đổi tier của ai; kết quả vẫn xem được trên trang.)
3. Với nhân viên **on track**: Scorecards → **Promote to assisted**, hoặc `npm run hq -- promote sdr-01`. Hệ thống từ chối nếu chưa đủ tiêu chí (ép bằng `--force` được ghi vào audit; đừng làm vậy trong lần đầu).
4. Với nhân viên **not enough data** hoặc **below bar**: giữ `shadow`, sửa nguyên nhân gốc (mục 4), bắt đầu run mới (`hq shadow start --days 7`) rồi đánh giá lại.
5. Chỉ sau khi nâng cấp mới bật outbound (`npm run hq -- killswitch on`, readiness phải xanh). Ở `assisted`, bản nháp bạn duyệt sẽ **gửi thật**, nên hãy bắt đầu bằng vài ngày đầu duyệt thật kỹ. Đừng nâng lên `autonomous` trong lần này.

## 7. Công tắc khẩn cấp và khi nhân viên làm bậy

Trong shadow, thứ tệ nhất có thể xảy ra là một bản nháp tệ nằm trong hàng chờ, vì không có gì rời khỏi máy bạn. Vẫn nên biết các nút dừng:

| Tình huống | Làm gì |
|---|---|
| Một nhân viên soạn nháp rác liên tục / tốn quota | `npm run hq -- agent pause sdr-01` (Agents → Pause). Việc đang chạy xong thì dừng, không nhận việc mới. Bật lại bằng `agent resume`. |
| Muốn chắc chắn không gửi gì (kể cả sau này) | `npm run hq -- killswitch off --reason "..."` (mặc định đã tắt). |
| Nhân viên viết điều không thật / hứa bừa | Từ chối với nhóm `factual_error` hoặc `compliance`, rồi sửa KB / danh sách cấm. Một vụ `compliance` đủ để kết luận **below bar**, và đó là chủ ý. |
| Bộ nhớ nhân viên bị nhiễm (học một góp ý sai, hoặc nội dung lạ từ email khách) | `memory list --agent <id>`, xoá dòng sai bằng `memory reject <id>`; nghi ngờ thì pause nhân viên. |
| Email lạ cố điều khiển agent ("bỏ qua mọi quy tắc…") | Chánh văn phòng chuyển cho bạn như một việc cần người; không làm theo. Ghi lại để kiểm tra lint / rule. |
| Khách bảo ngừng liên hệ | Hệ thống tự đánh dấu opt-out và từ chối các nháp đang chờ cho khách đó. Đừng gửi tay cho người đã opt-out. |
| Muốn dừng cả đợt đánh giá | `npm run hq -- shadow end --notes "dừng vì ..."`. Số liệu tới lúc đó được giữ lại. |

## 8. Lỗi đã biết ảnh hưởng tới run (xem mục Known issues trong [`PLAN.md`](PLAN.md))

- **Bản nháp trùng.** Agent đôi khi soạn lại khi thấy cảnh báo lint nhẹ, nên hàng chờ có hai bản cho cùng một người (SDR bị nhiều hơn AM). Hệ quả: số "drafts" phình ra và bản từ chối trùng làm giảm tỷ lệ duyệt. Cách xử lý: duyệt một bản, từ chối bản kia (`other`, "trùng"), và khi đọc số cuối kỳ nhớ trừ những bản trùng. Chưa có sửa phía server.
- **SDR bị chặn lint "deceptive_subject".** Trả lời một người mà chưa có thread trước đó bằng tiêu đề "Re: …" bị từ chối, nên agent phải soạn lại; đôi khi thấy ở nháp đầu tiên cho thư lạ.
- **CTA cố định.** Khoảng nửa số lần, SDR đề nghị "gọi 15 phút, em rảnh thứ Ba". Nếu bạn không muốn kiểu này, từ chối nhóm `tone` kèm góp ý để nó học, và/hoặc sửa playbook trong KB.
- **Lint của AM có thể báo nhầm.** Tiêu đề "Re: …" chứa chữ như "refund" hoặc "uptime guarantee" (do chính khách viết) bị coi là lời hứa. Nháp bị chặn lúc soạn nên agent soạn lại; ca "message-sla-uptime-bait" vẫn đôi khi chập chờn. Tính vào số lỗi lint là bình thường.
- **Chưa có số "đã gửi / phản hồi".** Shadow không gửi gì nên `Emails sent`, `Reply rate`, `Median first response` ở Dashboard sẽ là 0 / `—` suốt run. Đó là đúng, không phải lỗi.
- **Người duyệt luôn ghi là `human:admin`**, chưa phân biệt nhiều người trong cùng một run.
- **Hộp thư Inbox chỉ hiển thị 100 bản chờ mới nhất.** Nếu dồn quá 100 bản, bản cũ nhất không hiện; hãy duyệt kịp hoặc pause nhân viên.
- **API còn thiếu vài bộ lọc** (audit theo contact, contacts theo stage); UI tự lọc ở phía client nên không ảnh hưởng số liệu run.
- **Quota.** Mỗi bản nháp tốn một lượt chạy `agy`; xem `npm run hq -- quota`. Khi quota thấp, daemon ưu tiên việc trả lời khách.

---

Tham khảo thêm: [`docs/TECHNICAL.md`](TECHNICAL.md) (CLI và API), [`docs/PHASE4.md`](PHASE4.md) (vai trò AM / Chánh văn phòng, bản tin), [`docs/PLAN.md`](PLAN.md) (lộ trình và known issues).
