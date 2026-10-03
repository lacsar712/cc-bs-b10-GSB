# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 夜间低采样提醒

顶栏「低采样提醒」进入专页：

- **判定吃服务器时刻**：接口以数据库 `now()` 判定是否落入夜间时段，不看浏览器时钟。
- **触发条件**：服务器时刻落入夜间时段，且最近统计窗内 `done` 办结条数低于阈值 → 专页亮提醒横幅，并在状态上升沿写一条提醒流水（不重复写）。
- **不挡报送**：提醒仅展示与记录，提交读数流程不受影响；日间（时段外）永不触发。
- **权限**：测量员可调整夜间时段 / 统计窗 / 办结阈值；复核员只读提醒与提醒记录，改阈值返回 403。
- 默认：夜间 22:00–06:00、统计窗 60 分钟、阈值 5 条；起止时刻相同视为未启用。

| 接口 | 说明 |
|------|------|
| `GET /api/alerts/low-sampling` | 当前设置 + 服务器时刻 + 提醒状态 + 最近 50 条流水（登录即可） |
| `PUT /api/alerts/low-sampling/settings` | 调整 `night_start`/`night_end`（HH:MM）、`window_minutes`（1–1440）、`min_done`（0–999），仅测量员 |

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
