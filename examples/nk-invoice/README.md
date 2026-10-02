# Ví dụ thật: NK Invoice

Cấu hình nhân viên Sales SDR cho [NK Invoice](https://tracuuhddt.com) — SaaS thu thập hoá đơn điện tử đầu vào cho SME và đại lý kế toán ở Việt Nam.

| File | Là gì |
|---|---|
| `profile.json` | Hồ sơ công ty (sản phẩm, khách hàng mục tiêu, nỗi đau, khác biệt, chính sách giá, bằng chứng, danh sách "cấm nói") |
| `kb/company/*.md` | Kiến thức công ty mà hồ sơ trên sinh ra |
| `kb/roles/sales-sdr/*.md` | ICP, playbook bán hàng, cách xử lý từ chối riêng cho SDR |

Để ý cách hồ sơ này **giới hạn AI**: chỉ được báo giá theo bảng, luôn kèm "chưa gồm VAT", không được trích dẫn khách hàng chưa xác nhận, không hứa "không bị xuất toán". Phần đó quan trọng không kém phần mô tả sản phẩm.

Dùng thử (daemon đang chạy):

```bash
npm run hq -- setup company --file examples/nk-invoice/profile.json
mkdir -p kb && cp -R examples/nk-invoice/kb/roles kb/
npm run hq -- kb sync
```

Lệnh đầu lưu hồ sơ công ty (tự sinh lại `kb/company/*.md`); hai lệnh sau đưa kiến thức riêng của vai trò SDR vào `kb/roles/`, nơi nó được ưu tiên hơn kiến thức mặc định trong `templates/sales-sdr/kb/`.

Thông tin trong thư mục này thuộc về NK Invoice; nó được chia sẻ làm ví dụ tham khảo, không phải để sao chép cho sản phẩm khác.
