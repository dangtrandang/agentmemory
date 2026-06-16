# BRIDGE_DESIGN.md — Roo Code → Agentmemory Bridge

## Tổng quan kiến trúc

Bridge thực hiện import **một chiều** từ Zoo Code (Roo Code fork) task history sang agentmemory, cho phép search, replay, và phân tích toàn bộ lịch sử làm việc của agent.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Zoo Code Task History                      │
│  %APPDATA%/Code/User/globalStorage/                             │
│    zoocodeorganization.zoo-code/tasks/                          │
│                                                                 │
│  tasks/                                                         │
│  ├── _index.json           ← danh sách tất cả task             │
│  ├── {task-id-1}/                                               │
│  │   └── api_conversation_history.json  ← messages array       │
│  ├── {task-id-2}/                                               │
│  │   └── api_conversation_history.json                          │
│  └── ...                                                        │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │  bridge.mjs (đọc + parse)
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Bridge Logic                           │
│                                                                 │
│  1. Load _index.json → lọc theo workspace (nếu có)             │
│  2. Sort theo ts desc (mới nhất trước)                          │
│  3. Với mỗi task:                                               │
│     ├─ Active guard: mtime < 10ph → skip                        │
│     ├─ Unchanged: mtime = state → skip                          │
│     ├─ Parse api_conversation_history.json                      │
│     ├─ Extract conversation turns (user↔assistant)              │
│     ├─ POST /agentmemory/session/start                          │
│     ├─ POST /agentmemory/observe (mỗi turn)                     │
│     ├─ POST /agentmemory/session/end                            │
│     └─ Save state → bridge-state.json                           │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │  REST API calls
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Agentmemory Server                        │
│                    http://localhost:3111                         │
│                                                                 │
│  /agentmemory/session/start  →  mem::observe (auto-create)     │
│  /agentmemory/observe        →  mem::observe                    │
│  /agentmemory/session/end    →  cập nhật endedAt + status      │
│                                                                 │
│  Viewer: http://localhost:3113                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data flow chi tiết

### 1. Parsing conversation history

File `api_conversation_history.json` là array các message objects:

```json
[
  {
    "role": "user",
    "ts": 1718500000000,
    "content": [
      { "type": "text", "text": "<user_message>\nCreate a new component\n</user_message>" }
    ]
  },
  {
    "role": "assistant",
    "ts": 1718500001000,
    "content": [
      { "type": "text", "text": "I'll create the component..." },
      { "type": "tool_use", "name": "write_to_file", ... }
    ],
    "usage": { "input_tokens": 500, "output_tokens": 200 }
  }
]
```

Bridge extract mỗi cặp `user→assistant` thành một turn với:
- `prompt`: nội dung từ `<user_message>` tag
- `assistantResponse`: text response của assistant
- `toolCalls`: danh sách tool names

### 2. Mapping sang agentmemory

Mỗi task Zoo Code → **1 session** trong agentmemory với nhiều observations:

| Zoo Code concept | Agentmemory concept |
|-----------------|-------------------|
| Task (id, mode, workspace) | Session (sessionId, project, cwd) |
| Conversation turn (user→assistant) | Observation (hookType: prompt_submit) |
| Token usage | data.tokenUsage |
| Tool calls | data.toolCalls |

### 3. State management

State file `~/.agentmemory/bridge-state.json`:

```json
{
  "task-id-abc123": {
    "mtime": 1718500000000,
    "sessionId": "uuid-from-agentmemory",
    "importedAt": "2025-06-16T12:00:00.000Z"
  }
}
```

**Cơ chế sync**:
- `mtime` = `fs.statSync(convPath).mtimeMs` — dùng để detect thay đổi
- Khi phát hiện task đã thay đổi → tạo session MỚI (không xóa session cũ vì không có REST endpoint DELETE)

### 4. Active guard

File conversation history của task đang active (agent đang chạy) sẽ bị ghi liên tục. Bridge skip task có `mtime < 10 phút` để tránh import dữ liệu chưa hoàn chỉnh.

## API contracts

### POST /agentmemory/session/start

```
Body:   { sessionId: string, project: string, cwd: string, title?: string }
Return: { session: Session, context: string }
```

Source: [`src/triggers/api.ts:560-615`](../src/triggers/api.ts)

### POST /agentmemory/observe

```
Body:   { hookType: string, sessionId: string, project: string, cwd: string,
          timestamp: string, data: any }
Return: { observationId: string }
```

Source: [`src/triggers/api.ts:286-323`](../src/triggers/api.ts)  
Observe handler: [`src/functions/observe.ts:37-339`](../src/functions/observe.ts)

Field `data.prompt` được extract thành `userPrompt` trong observation.

### POST /agentmemory/session/end

```
Body:   { sessionId: string }
Return: { success: true }
```

Source: [`src/triggers/api.ts:617-654`](../src/triggers/api.ts)

## Bug fixes từ phiên bản gốc

| # | Bug gốc | Fix |
|---|---------|-----|
| 1 | Gọi `startSession(PROJECT_NAME, sessionId, ...)` — sai thứ tự tham số | Sửa thành `startSession(sessionId, project, cwd, title)` |
| 2 | Gửi `postObserve` với `raw.userPrompt` thay vì `data.prompt` | Sửa thành `data: { prompt: ... }` |
| 3 | Gửi thừa `sessionLabel`, `startedAt` trong session/start body | Chỉ gửi `{ sessionId, project, cwd, title? }` |
| 4 | Gọi `DELETE /agentmemory/sessions?sessionId=...` — endpoint không tồn tại | Bỏ hoàn toàn; session cũ giữ nguyên |

## Tham khảo

- [Agentmemory API](https://github.com/dangtrandang/agentmemory)
- [Zoo Code (Roo Code fork)](https://github.com/zoocodeorganization/zoo-code)
- [iii-sdk](https://github.com/rohitg00/iii-sdk)
