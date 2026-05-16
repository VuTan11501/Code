# 🚀 Toàn bộ chức năng của GitHub Copilot CLI

GitHub Copilot CLI đưa trợ lý AI lập trình trực tiếp vào terminal. Dưới đây là tổng hợp các chức năng:

---

## 🔑 Xác thực & Khởi động

| Lệnh | Mô tả |
|---|---|
| `/login` | Đăng nhập tài khoản GitHub |
| `/logout` | Đăng xuất |
| `copilot` | Khởi chạy CLI |
| `copilot --banner` | Khởi chạy kèm banner hoạt hình |

---

## 💬 Tương tác cơ bản

| Phím/Ký hiệu | Chức năng |
|---|---|
| `@` | Nhắc đến file trong prompt (ví dụ: `@src/main.py`) |
| `#` | Nhắc đến issue/PR (ví dụ: `#42`) |
| `!` | Chạy lệnh shell trực tiếp (ví dụ: `!npm test`) |
| `Shift+Tab` | Chuyển đổi chế độ (Normal → Plan → Autopilot) |
| `Ctrl+S` | Chạy lệnh nhưng giữ nguyên input |
| `Ctrl+T` | Bật/tắt hiển thị reasoning của AI |
| `Ctrl+O/E` | Mở rộng toàn bộ timeline |
| `Ctrl+C` | Hủy thao tác hiện tại |
| `Ctrl+C×2` | Thoát CLI |
| `Esc` | Hủy |
| `Ctrl+D` | Tắt CLI |
| `Ctrl+L` | Xóa màn hình |
| `Ctrl+X → B` | Chuyển tác vụ hiện tại sang nền |
| `Ctrl+X → O` | Mở link gần nhất |

---

## ✏️ Chỉnh sửa Input

| Phím | Chức năng |
|---|---|
| `Ctrl+A` | Về đầu dòng |
| `Ctrl+E` | Về cuối dòng |
| `Ctrl+H` | Xóa ký tự trước |
| `Ctrl+W` | Xóa từ trước |
| `Ctrl+U` | Xóa từ con trỏ đến đầu dòng |
| `Ctrl+K` | Xóa từ con trỏ đến cuối dòng |
| `Meta+←/→` | Di chuyển con trỏ theo từ |
| `Ctrl+G` | Mở prompt trong `$EDITOR` |

---

## 🤖 Khả năng Agentic (Tác nhân AI)

- **Viết, sửa, debug, refactor code** bằng ngôn ngữ tự nhiên
- **Lập kế hoạch & thực thi** các tác vụ phức tạp nhiều bước
- **Xem trước mọi thay đổi** trước khi áp dụng — không làm gì mà không có sự đồng ý

| Lệnh | Mô tả |
|---|---|
| `/model` | Chọn model AI (Claude Sonnet 4.5, GPT-5, v.v.) |
| `/plan` | Tạo kế hoạch triển khai trước khi code |
| `/autopilot` | Chế độ tự động — AI làm liên tục đến khi xong |
| `/delegate` | Gửi session lên GitHub để Copilot tạo PR tự động |
| `/fleet` | Bật chế độ fleet — chạy nhiều sub-agent song song |
| `/tasks` | Xem và quản lý các tác vụ con đang chạy |
| `/sidekicks` | Xem các sidekick agent đang chạy |

---

## 📂 Quản lý Code & Review

| Lệnh | Mô tả |
|---|---|
| `/diff` | Xem các thay đổi đã thực hiện trong thư mục hiện tại |
| `/pr` | Thao tác với PR của nhánh hiện tại |
| `/review` | Chạy agent review code để phân tích thay đổi |
| `/lsp` | Quản lý Language Server (hỗ trợ go-to-definition, hover, diagnostics) |
| `/ide` | Kết nối với IDE workspace |

---

## 🔌 Mở rộng (Extensibility)

| Lệnh | Mô tả |
|---|---|
| `/mcp` | Quản lý MCP server — mở rộng khả năng bằng các công cụ bên ngoài |
| `/skills` | Quản lý skills cho các khả năng nâng cao |
| `/plugin` | Quản lý plugin và marketplace |
| `/agent` | Duyệt và chọn agent khả dụng |

---

## 🔐 Quyền truy cập

| Lệnh | Mô tả |
|---|---|
| `/allow-all` | Bật tất cả quyền (tools, paths, URLs) |
| `/add-dir` | Thêm thư mục vào danh sách cho phép truy cập |
| `/list-dirs` | Hiển thị danh sách thư mục được phép |
| `/cwd` | Đổi hoặc xem thư mục làm việc hiện tại |
| `/reset-allowed-tools` | Reset danh sách tools được phép |

---

## 📋 Quản lý Session

| Lệnh | Mô tả |
|---|---|
| `/resume` | Chuyển sang session khác (theo ID hoặc tên) |
| `/rename` | Đổi tên session hiện tại |
| `/compact` | Tóm tắt lịch sử hội thoại để giảm context window |
| `/context` | Xem mức sử dụng token của context window |
| `/usage` | Hiển thị thống kê sử dụng session |
| `/share` | Chia sẻ session ra markdown, HTML, hoặc GitHub Gist |
| `/rewind` / `/undo` | Quay lại bước trước và hoàn tác thay đổi file |
| `/copy` | Copy phản hồi cuối vào clipboard |
| `/clear` | Bỏ session hiện tại, bắt đầu mới |
| `/new` | Bắt đầu cuộc hội thoại mới |

---

## 🔍 Nghiên cứu & Tìm kiếm

| Lệnh | Mô tả |
|---|---|
| `/research` | Chạy nghiên cứu chuyên sâu bằng GitHub search và web |
| `/search` | Tìm kiếm trong timeline hội thoại |
| `/ask` | Hỏi nhanh một câu phụ mà không thêm vào lịch sử |
| `/chronicle` | Xem lịch sử và insights của session |

---

## ⏰ Lập lịch & Tự động hóa

| Lệnh | Mô tả |
|---|---|
| `/after 30s <prompt>` | Lên lịch chạy prompt một lần sau khoảng thời gian |
| `/every 5m <prompt>` | Lên lịch chạy prompt lặp lại định kỳ |
| `/keep-alive` | Giữ máy không sleep |
| `/remote` | Điều khiển từ xa qua GitHub web/mobile |

---

## ⚙️ Cấu hình & Tiện ích

| Lệnh | Mô tả |
|---|---|
| `/init` | Khởi tạo file hướng dẫn Copilot cho repo |
| `/instructions` | Xem và bật/tắt file custom instructions |
| `/theme` | Đổi giao diện màu |
| `/statusline` / `/footer` | Cấu hình thanh trạng thái |
| `/terminal-setup` | Cấu hình terminal hỗ trợ multiline (Shift+Enter) |
| `/streamer-mode` | Ẩn tên model và quota khi streaming |
| `/env` | Xem chi tiết môi trường (instructions, MCP, skills, LSP...) |
| `/update` | Cập nhật CLI lên phiên bản mới nhất |
| `/version` | Xem phiên bản và kiểm tra cập nhật |
| `/changelog` | Xem changelog, thêm `summarize` để AI tóm tắt |
| `/feedback` | Gửi phản hồi bảo mật |
| `/restart` | Khởi động lại CLI, giữ session |
| `/exit` | Thoát CLI |

---

## 📝 Custom Instructions

Copilot đọc hướng dẫn tùy chỉnh từ các file sau:

- `CLAUDE.md`
- `GEMINI.md`
- `AGENTS.md` (trong git root & cwd)
- `.github/instructions/**/*.instructions.md` (trong git root & cwd)
- `.github/copilot-instructions.md`
- `~/.copilot/copilot-instructions.md`
- `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (thư mục bổ sung qua biến môi trường)

---

## 🔧 Cấu hình LSP Server

Copilot CLI hỗ trợ Language Server Protocol (LSP) cho code intelligence nâng cao.

### Cài đặt LSP Server

```bash
# Ví dụ: TypeScript
npm install -g typescript-language-server
```

### File cấu hình

- **User-level:** `~/.copilot/lsp-config.json`
- **Repo-level:** `.github/lsp.json`

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "fileExtensions": {
        ".ts": "typescript",
        ".tsx": "typescript"
      }
    }
  }
}
```

---

## 📦 Cài đặt

### Hỗ trợ: Linux, macOS, Windows

```bash
# macOS/Linux (script)
curl -fsSL https://gh.io/copilot-install | bash

# macOS/Linux (Homebrew)
brew install copilot-cli

# Windows (WinGet)
winget install GitHub.Copilot

# Đa nền tảng (npm)
npm install -g @github/copilot
```

---

> **Tóm lại:** GitHub Copilot CLI là một agent AI toàn diện ngay trong terminal — từ viết code, review, tạo PR, nghiên cứu, đến mở rộng bằng MCP/plugin, tất cả qua ngôn ngữ tự nhiên.
