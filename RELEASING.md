# Quy trình release

Dự án theo ba chuẩn phổ biến:

- **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)** để đánh số phiên bản.
- **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)** để ghi thay đổi trong [CHANGELOG.md](CHANGELOG.md).
- **[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)** để viết commit message.

GitHub Release được tạo **tự động** khi push tag `vX.Y.Z`. Workflow [`release.yml`](.github/workflows/release.yml) build, chạy test, rồi đăng release với nội dung lấy từ đúng mục của phiên bản đó trong CHANGELOG.

## 1. Đánh số phiên bản

`MAJOR.MINOR.PATCH`. Số phiên bản nằm trong `version` của `package.json` ở thư mục gốc. Các package `@agyhq/*` là nội bộ (`private`) nên không có version riêng.

### Cái gì được coi là "public API"

Thay đổi làm hỏng một trong những thứ sau thì là **breaking change**:

| Bề mặt | Ví dụ |
|---|---|
| CLI `hq` | đổi tên/xoá lệnh hoặc flag, đổi định dạng `--json` |
| Cấu hình | trường trong `agyhq.config.json`, biến môi trường `AGYHQ_*` |
| HTTP API | các route `/v1/admin/*`, `/v1/inbound/webhook/*` và body/response của chúng |
| Định dạng template vai trò | cấu trúc `templates/<role>/` (`template.json`, prompts, skills, rules, evals) |
| Hồ sơ công ty | schema của file `profile.json` (`hq setup company --file`) |
| Dữ liệu người dùng | database SQLite và các file trong `dataDir`: bản mới phải tự migrate, không bắt người dùng xoá dữ liệu |
| Yêu cầu môi trường | nâng phiên bản Node tối thiểu, hoặc yêu cầu phiên bản `agy` mới hơn |

Prompt, giọng văn email, giao diện web hay cấu trúc code nội bộ **không** phải public API. Dù vậy, thay đổi đáng kể ở những phần này vẫn phải ghi vào CHANGELOG.

### Giai đoạn 0.x (hiện tại)

Theo SemVer, `0.y.z` là giai đoạn phát triển ban đầu. Quy ước của dự án:

- **MINOR** (`0.1.0` → `0.2.0`): tính năng mới **hoặc** breaking change. Breaking change bắt buộc có mục hướng dẫn nâng cấp trong CHANGELOG.
- **PATCH** (`0.1.0` → `0.1.1`): chỉ sửa lỗi, vá bảo mật, cập nhật tài liệu. Không breaking, không thêm tính năng.

Lên **1.0.0** khi public API ở bảng trên đã ổn định và có ít nhất một vai trò thứ hai hoàn chỉnh. Từ 1.0.0 trở đi áp dụng SemVer đầy đủ: breaking → MAJOR, tính năng → MINOR, sửa lỗi → PATCH.

### Pre-release

Dùng `vX.Y.Z-rc.N` (ví dụ `v0.2.0-rc.1`) khi cần người dùng thử trước. Workflow tự đánh dấu là *pre-release* trên GitHub và không đặt làm *Latest*.

## 2. Commit message

```
<type>(<scope tuỳ chọn>): <mô tả ngắn, thể mệnh lệnh>

<thân tuỳ chọn>

BREAKING CHANGE: <mô tả + cách nâng cấp>   ← chỉ khi breaking
```

| `type` | Dùng khi | Ảnh hưởng phiên bản |
|---|---|---|
| `feat` | tính năng mới cho người dùng | MINOR |
| `fix` | sửa lỗi | PATCH |
| `perf` | cải thiện hiệu năng | PATCH |
| `docs`, `test`, `refactor`, `style`, `build`, `ci`, `chore` | không đổi hành vi | không cần release |

Breaking change thì thêm `!` sau type (`feat(cli)!: …`) **và** footer `BREAKING CHANGE:`. Scope gợi ý: `sdr`, `setup`, `inbound`, `outbox`, `sender`, `kb`, `cli`, `ui`, `api`, `runner`, `db`, `templates`.

## 3. Ghi CHANGELOG

- Mỗi PR có thay đổi người dùng nhìn thấy được **phải** thêm một dòng vào mục `## [Unreleased]`, đúng nhóm: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Viết cho **người dùng**, không phải cho người review code: nói họ được gì hoặc phải làm gì, không chép commit message.
- CHANGELOG viết bằng tiếng Anh, vì đây cũng là nội dung của GitHub Release.
- Breaking change đặt đầu nhóm `Changed`/`Removed`, in đậm **BREAKING**, kèm cách nâng cấp.
- Ghi phiên bản `agy` đã kiểm thử nếu có thay đổi, vì `agy` tự cập nhật và có thể đổi hành vi.

## 4. Trước khi release

- [ ] `main` xanh trên CI.
- [ ] `npm ci && npm run build && npm run typecheck && npm test` pass ở máy.
- [ ] Với release có thay đổi runner, inbound hay sender: chạy các test e2e với `agy` thật (tốn quota):
      `AGYHQ_REAL_AGY=1 npx vitest run packages/server/test/real-e2e.test.ts packages/server/test/real-e2e-phase2.test.ts`
- [ ] Database migration (nếu có) đã thử trên một `dataDir` của phiên bản trước.
- [ ] Mục `[Unreleased]` đầy đủ; README và `docs/TECHNICAL.md` đã cập nhật nếu lệnh hay cấu hình thay đổi.

## 5. Các bước release

Ví dụ cho `0.2.0`:

1. Cập nhật `main`:

   ```bash
   git switch main && git pull --ff-only
   ```

2. Sửa `CHANGELOG.md`:
   - đổi `## [Unreleased]` thành `## [0.2.0] - YYYY-MM-DD` (ngày phát hành, định dạng ISO 8601);
   - thêm một mục `## [Unreleased]` trống ở trên cùng;
   - cập nhật link so sánh ở cuối file:

   ```
   [Unreleased]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.2.0...HEAD
   [0.2.0]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.1.0...v0.2.0
   ```

3. Nâng version trong `package.json` và `package-lock.json`:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

4. Xem trước release notes. Script này cũng kiểm tra version khớp với CHANGELOG:

   ```bash
   npm run release:notes -- v0.2.0
   ```

5. Commit, rồi tạo **annotated tag**:

   ```bash
   git commit -am "chore(release): v0.2.0"
   ```

   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   ```

6. Push commit trước, tag sau:

   ```bash
   git push origin main && git push origin v0.2.0
   ```

7. Theo dõi workflow **Release** trong tab Actions. Khi xong, release xuất hiện ở trang Releases với nội dung lấy từ CHANGELOG.

Nếu workflow fail (test đỏ, version lệch), release **chưa** được tạo. Xoá tag, sửa lỗi, rồi tag lại cùng số:

```bash
git push origin :refs/tags/v0.2.0 && git tag -d v0.2.0
```

## 6. Quy tắc bất biến

- **Không bao giờ sửa, di chuyển hay xoá một tag đã có GitHub Release.** Phát hiện lỗi sau khi release thì ra bản PATCH mới.
- Mọi release đều được tag từ một commit trên `main`. Workflow từ chối tag nằm ngoài `main`.
- Không force-push lên `main`.
- Một phiên bản lỗi nghiêm trọng (mất dữ liệu, gửi email ngoài ý muốn) thì sửa phần mô tả GitHub Release, thêm cảnh báo ở đầu, và ra bản vá ngay. Không xoá release đó.

## 7. Hotfix

Sửa trên `main` (commit `fix: …`), thêm dòng vào `Fixed` (hoặc `Security`), rồi làm theo mục 5 với số PATCH tiếp theo. Dự án chỉ hỗ trợ phiên bản mới nhất, không backport về các nhánh cũ.

## 8. Lỗ hổng bảo mật

Đừng báo lỗ hổng qua issue công khai. Dùng **Security → Report a vulnerability** (GitHub private vulnerability reporting) của repo. Bản vá được ghi vào nhóm `Security` của CHANGELOG sau khi đã phát hành.
