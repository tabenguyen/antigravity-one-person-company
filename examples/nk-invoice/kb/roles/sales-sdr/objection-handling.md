# Xử lý từ chối — NK Invoice

Chỉ dùng thông tin đã công bố trên tracuuhddt.com. Không thắng tranh luận; mục tiêu
là hiểu đúng tình huống của khách và đề xuất một bước nhỏ tiếp theo.

## "Đắt quá" / "Không có ngân sách"

- Giá tính theo số hóa đơn thực tế, quota dùng chung cả kỳ (không mất quota tháng ít
  hóa đơn), không tính hóa đơn trùng hay lỗi hệ thống, không tính theo người dùng.
- Gói 12 tháng thấp nhất: SME NK Collect 600.000đ cho 2.000 hóa đơn (chưa gồm VAT).
- Nếu nhu cầu nhỏ: công cụ miễn phí trên tracuuhddt.com (5 file/ngày) có thể đã đủ —
  nói thật điều đó.
- Không đưa giảm giá. Hỏi giá riêng → chuyển người phụ trách.

## "Chúng tôi tự lấy XML được rồi" / "Đã có quy trình riêng"

- Hỏi họ đang làm thế nào và mất bao lâu mỗi kỳ; nhiều nhà cung cấp hóa đơn nghĩa là
  nhiều cổng tra cứu, mỗi hãng để mã tra cứu một chỗ khác nhau.
- Đề xuất so sánh trực tiếp: thả vài PDF thật vào https://tracuuhddt.com/tai-xml-tu-pdf.
- Nếu quy trình hiện tại đã ổn, ghi nhận và chuyển `nurture`, không ép.

## "Chúng tôi dùng MISA / VNPT / Viettel… rồi"

- Đó là các nhà cung cấp phát hành hóa đơn; NK Invoice xử lý hóa đơn **đầu vào** nhận
  từ nhiều nhà cung cấp khác nhau và có hướng dẫn riêng cho MISA meInvoice, VNPT
  Invoice, Viettel SInvoice, BKAV eHoadon, EasyInvoice, M-Invoice, Einvoice, iPOS.
- Không nói xấu và không so sánh tính năng với sản phẩm khác.

## "Chưa phải lúc"

- Hỏi thời điểm phù hợp (ví dụ trước mùa quyết toán) → `nurture` + tạo follow-up đúng
  mốc khách nêu.
- Quota trả trước dùng được cả kỳ 6/12 tháng nên khách có thể dùng nhiều vào mùa
  quyết toán mà không mất quota.

## "Để tôi hỏi sếp / nhóm"

- Đề nghị gửi một tóm tắt ngắn (công cụ miễn phí + bảng giá công khai
  https://tracuuhddt.com/pricing) để họ chuyển tiếp.
- Hỏi ai là người quyết định và có nên kết nối trực tiếp không.

## Bảo mật / dữ liệu hóa đơn

- Công cụ miễn phí **không lưu hóa đơn**: file chỉ tồn tại trong lúc xử lý và bị xóa
  ngay khi trả kết quả, không ghi vào cơ sở dữ liệu, không dùng cho mục đích khác.
- Với gói trả phí (NK Collect / NK Risk AI): chưa có tài liệu bảo mật được xác nhận
  trong knowledge base — **không tự nêu chi tiết** (mã hóa, nơi lưu, thời hạn lưu).
  Ghi nhận câu hỏi và chuyển người phụ trách (needs_human).

## "AI đánh giá rủi ro có chắc không?"

- NK Risk AI hỗ trợ lọc và giải thích rủi ro công ty bán, đưa khuyến nghị xử lý; kế
  toán vẫn là người quyết định. Không hứa tránh được rủi ro hay bị xuất toán.

## "Không quan tâm"

- Cảm ơn, hỏi một lần duy nhất xem có nên liên hệ người khác phụ trách kế toán không.
  Nếu không → `disqualified` hoặc `nurture` theo lý do; không gửi thêm.
- Khách yêu cầu ngừng liên hệ → dừng ngay, ghi nhận opt-out.
