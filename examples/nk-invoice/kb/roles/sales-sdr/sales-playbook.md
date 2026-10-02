# Cẩm nang bán hàng — NK Invoice

Nguồn: https://tracuuhddt.com, https://tracuuhddt.com/pricing. Chỉ dùng thông tin
trong tài liệu này và các tài liệu công ty (company KB); không suy diễn thêm.

## Tóm tắt sản phẩm

- **Công cụ miễn phí (tracuuhddt.com):** *Tải XML từ PDF* — đọc mã tra cứu in trên
  PDF và tải XML gốc có chữ ký số từ cổng của nhà cung cấp; *Đọc XML hóa đơn* — hiển
  thị bên bán, bên mua, số hóa đơn, tiền trước thuế, VAT, tổng thanh toán. Chạy trên
  trình duyệt, không cần cài đặt hay đăng ký, 5 file/ngày/công cụ, không lưu hóa đơn.
- **NK Collect:** nhận hóa đơn qua email, lấy PDF/XML, chống trùng, lưu evidence,
  tập trung hồ sơ trước khi chuyển sang kế toán.
- **NK Risk AI:** mọi tính năng của Collect + AI đánh giá rủi ro công ty bán, giải
  thích kết quả và khuyến nghị xử lý cho từng hóa đơn.

## Bảng giá niêm yết (chỉ báo đúng các con số dưới đây, luôn kèm "chưa gồm VAT")

Gói 12 tháng — thanh toán một lần, quota dùng chung 12 tháng:

| Gói | Quota | NK Collect | NK Risk AI | Số MST |
|---|---|---|---|---|
| SME | 2.000 hóa đơn | 600.000đ (300đ/hóa đơn) | 1.200.000đ (600đ/hóa đơn) | 1 |
| Growth | 6.000 hóa đơn | 1.650.000đ (275đ/hóa đơn) | 3.300.000đ (550đ/hóa đơn) | tối đa 3 |
| Agency | 20.000 hóa đơn | 5.000.000đ (250đ/hóa đơn) | 10.000.000đ (500đ/hóa đơn) | tối đa 10 |

Gói 6 tháng:

| Gói | Quota | NK Collect | NK Risk AI |
|---|---|---|---|
| SME | 1.000 hóa đơn | 350.000đ | 700.000đ |
| Growth | 3.000 hóa đơn | 900.000đ | 1.800.000đ |
| Agency | 10.000 hóa đơn | 2.750.000đ | 5.500.000đ |

Cách tính quota: 1 hóa đơn hợp lệ trừ 1 lượt; email có nhiều hóa đơn tính theo số
hóa đơn thực tế; hóa đơn trùng, email không có hóa đơn, retry do lỗi hệ thống và
lần đánh giá AI không ra kết quả **không** trừ quota. Quota không reset hằng tháng.
Không giới hạn người dùng nội bộ. Hết quota: nâng gói hoặc mua thêm theo block (giữ
đơn giá gói đang dùng, cùng ngày hết hạn). NK Invoice báo khi quota còn 20%.

## Thông điệp giá trị được duyệt

1. **Có PDF mà thiếu XML?** Lấy đúng file XML gốc có chữ ký số từ cổng của nhà cung
   cấp — thử miễn phí ngay tại https://tracuuhddt.com/tai-xml-tu-pdf.
2. **Không phải mở từng email:** NK Collect tự gom PDF/XML từ hộp thư, chống trùng,
   tập trung hồ sơ trước khi vào kế toán.
3. **Lọc rủi ro công ty bán trước khi hạch toán:** NK Risk AI đánh giá, giải thích và
   khuyến nghị xử lý từng hóa đơn — kế toán vẫn là người quyết định.
4. **Giá theo hóa đơn thực tế, không phí ẩn:** quota dùng chung cả kỳ, không tính trùng
   hay lỗi hệ thống, không tính theo người dùng.

## Cách tiếp cận

- **Lần chạm đầu:** nêu đúng một nỗi đau phù hợp với khách (thiếu XML, mở từng email,
  rủi ro công ty bán), mời thử công cụ miễn phí với chính hóa đơn của họ hoặc hỏi một
  câu về cách họ đang nhận hóa đơn đầu vào. Ngắn gọn, một lời kêu gọi hành động.
- **Câu hỏi khám phá tốt:** Mỗi tháng công ty nhận khoảng bao nhiêu hóa đơn đầu vào?
  Hóa đơn đến qua email nào, từ những nhà cung cấp hóa đơn nào? Đang lấy XML bằng cách
  nào? Có bao nhiêu MST / khách hàng (với đại lý)?
- **Bước tiếp theo:** khách quan tâm gói trả phí → mời "Đăng ký tư vấn" trên trang
  bảng giá để được tư vấn quota trước khi kích hoạt; chuyển người phụ trách
  (needs_human) khi khách hỏi giá riêng, hợp đồng, thanh toán.

## Giai đoạn SDR phụ trách

new → researching → (qualified | disqualified | nurture). `contacted` và `replied`
do hệ thống tự ghi khi email thực sự được gửi / khi khách trả lời. SDR bàn giao cho
người phụ trách khi khách muốn tư vấn gói, báo giá riêng hoặc hợp đồng.

## Định vị so với cách làm khác

Trang web không nêu tên đối thủ; không tự so sánh với sản phẩm cụ thể nào. So sánh
được phép:
- **So với làm thủ công:** mở từng email, vào từng cổng tra cứu của từng nhà cung cấp
  để lấy XML, gõ tay vào phần mềm kế toán.
- **So với chỉ lưu PDF:** XML mới là căn cứ khi PDF và XML lệch nhau; hồ sơ lưu trữ
  phải giữ nguyên XML đã ký số tối thiểu 10 năm.

## Chính sách giảm giá

Không có giảm giá, khuyến mãi hay dùng thử gói trả phí do SDR đề xuất. Mọi yêu cầu
giá riêng/chiết khấu → chuyển người phụ trách.

## Liên hệ

CÔNG TY TNHH NGUYÊN KHAI TECH — MST 0319208806 — 99 Cộng Hoà, Phường Tân Sơn Nhất,
TP. Hồ Chí Minh — contact@nguyen-khai.com.
