# Demo

Ảnh chụp giao diện agy-ui với dữ liệu hư cấu (công ty BookNhanh). Quay lại [README](../README.md).

## 1. Mai làm việc một mình

Khách trả lời email chào hàng lúc 10:14. Chưa tới 5 phút sau, khách đã nhận được câu trả lời đúng sản phẩm, đúng bảng giá, kèm link đặt lịch demo. Chủ công ty không phải chạm tay vào.

**1. Email khách gửi tới được phân loại và giao việc tự động.** Trả lời, hủy đăng ký, thư tự động, email lỗi, lead mới từ form: mỗi loại một đường xử lý, và chỉ những email cần suy nghĩ mới tốn quota AI.

![Inbound: email của khách được phân loại và chuyển thành việc cho Mai](images/demo-1-inbound.png)

**2. Mai soạn câu trả lời theo kho kiến thức và bảng giá, rồi tự gửi** (`policy:autonomous`). Lý do của agent được lưu lại để bạn kiểm tra bất cứ lúc nào.

![Inbox: câu trả lời Mai đã tự gửi cho khách, kèm lý do và ngữ cảnh khách hàng](images/demo-2-auto-reply-sent.png)

**3. Toàn bộ lịch sử với khách nằm trong CRM**: nghiên cứu → chào hàng → khách trả lời → AI trả lời → cập nhật giai đoạn bán hàng.

![Contact: dòng thời gian với khách hàng Trần Thu Hà](images/demo-3-contact-timeline.png)

> Ảnh dùng dữ liệu minh hoạ: BookNhanh và các khách hàng đều là hư cấu. Chế độ tự gửi chỉ chạy khi bạn nâng nhân viên lên `autonomous`, và chỉ với khách đã từng nhận một email do bạn duyệt. Mặc định, mọi email đều chờ bạn bấm duyệt.

## 2. Cả đội phối hợp

Từ v0.2.0, Mai không làm một mình: **Linh** (Account Manager) chăm khách sau khi chốt, **Phúc** (Chánh văn phòng) phân loại thư lạ và viết bản tin sáng cho bạn. Cùng công ty BookNhanh, cùng dữ liệu hư cấu:

**4. Mai chốt được khách thì bàn giao cho Linh.** Khách chuyển sang `customer`, Linh trở thành chủ sở hữu, lịch sử bàn giao và việc onboarding nằm ngay trong dòng thời gian. Email chào mừng của Linh vẫn chờ bạn duyệt.

![Contact: Lý Minh Châu sau khi Mai bàn giao cho Linh, có lịch sử bàn giao và việc onboarding](images/demo-4-handoff-account-manager.png)

**5. KPI theo vai trò** ngay trên Dashboard (7 hoặc 30 ngày). Chỉ số chưa có dữ liệu hiện "—", không bao giờ là số 0 bịa ra.

![Dashboard: KPI theo vai trò cho SDR, Account Manager và Chánh văn phòng](images/demo-5-kpis-by-role.png)

**6. Bản tin sáng của Phúc**: việc cần bạn xử lý hôm nay đứng đầu (thư đáng ngờ, yêu cầu hoàn tiền, bản nháp chờ duyệt), rồi tới chuyện đã diễn ra. Mọi con số lấy từ chính dữ liệu trong hệ thống.

![Briefings: bản tin hằng ngày của Chánh văn phòng bằng tiếng Việt](images/demo-6-chief-of-staff-briefing.png)

**7. Chạy thử shadow 2 tuần trên hộp thư thật**: nhân viên chỉ soạn nháp, bạn duyệt, sửa hoặc từ chối, không có gì được gửi đi. Mỗi nhân viên có kết luận riêng (đang đúng hướng, chưa đủ dữ liệu, dưới ngưỡng) cùng xu hướng theo ngày. Runbook: [docs/SHADOW-RUN.md](SHADOW-RUN.md).

![Shadow run: ngày 7/14, kết luận cho Linh và Nam, xu hướng duyệt theo ngày](images/demo-7-shadow-run.png)

> Ảnh dùng dữ liệu minh hoạ: BookNhanh, Linh, Phúc, Nam và các khách hàng đều là hư cấu. Linh và Nam đang ở chế độ shadow nên chưa gửi email nào. Dựng lại bằng `npm run demo:screenshots` (xem [scripts/demo](../scripts/demo/README.md)).
