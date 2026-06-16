# @agentmemory/roocode-bridge

Import task history từ **Roo Code / Zoo Code** vào **agentmemory** — cho phép replay, search, và phân tích toàn bộ lịch sử làm việc của coding agent.

## Tính năng

- **Import một chiều** từ Zoo Code task history → agentmemory sessions + observations
- **Incremental import** — chỉ import task mới hoặc đã thay đổi
- **Active guard** — tự động skip task đang được agent dùng (file sửa < 10 phút)
- **State tracking** — lưu state ở `~/.agentmemory/bridge-state.json`
- **Dry-run mode** — preview trước khi import thực tế
- **Filter workspace** — chỉ import task từ workspace cụ thể

## Yêu cầu

- Node.js >= 20
- [agentmemory](https://github.com/dangtrandang/agentmemory) đang chạy (mặc định port 3111)
- Zoo Code / Roo Code đã có task history trong `%APPDATA%/Code/User/globalStorage/zoocodeorganization.zoo-code/tasks/`

## Cài đặt

```bash
# Clone repo
git clone https://github.com/dangtrandang/agentmemory.git
cd agentmemory/integrations/roocode-bridge

# Chạy trực tiếp
node bridge.mjs --dry-run
```

Hoặc dùng như package:

```bash
npm install -g @agentmemory/roocode-bridge
agentmemory-roocode-bridge --dry-run
```

## Sử dụng

```bash
# Preview - không ghi dữ liệu
node bridge.mjs --dry-run

# Import tất cả task
node bridge.mjs

# Chỉ import task từ workspace astro-cms
node bridge.mjs --workspace astro-cms

# Quiet mode - chỉ hiện thay đổi
node bridge.mjs --quiet
```

## Cấu hình

| Biến môi trường | Mặc định | Mô tả |
|----------------|----------|-------|
| `AGENTMEMORY_URL` | `http://localhost:3111` | REST API URL |
| `AGENTMEMORY_SECRET` | (trống) | Secret nếu bật auth |

## Cơ chế hoạt động

1. Đọc `_index.json` từ thư mục tasks của Zoo Code
2. Với mỗi task:
   - **Active guard**: file conversation history sửa < 10 phút → skip
   - **Unchanged**: mtime không đổi so với state → skip
   - **New/Updated**: parse conversation, tạo session + observations trong agentmemory
3. Lưu state vào `~/.agentmemory/bridge-state.json`

Xem chi tiết thiết kế ở [BRIDGE_DESIGN.md](./BRIDGE_DESIGN.md).

## API endpoints sử dụng

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agentmemory/session/start` | POST | Tạo session mới |
| `/agentmemory/session/end` | POST | Đánh dấu session hoàn thành |
| `/agentmemory/observe` | POST | Ghi observation (prompt_submit) |

## License

Apache-2.0
