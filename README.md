# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

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

## 夜间低采样提醒

顶栏「低采样提醒」专页：夜间时段 + 办结阈值 + 提醒流水。

- **判定条件（吃服务器时刻）**：数据库 `now()` 落入夜间时段，且最近 `window_minutes` 窗内
  `status='done'` 的办结条数低于 `min_done` 时，专页亮提醒；判定不取浏览器时钟。
- **不挡报送**：提醒只亮灯、写流水，`POST /api/readings` 不受任何影响，日间不出提醒。
- **提醒流水**：提醒状态熄→亮翻转时写一条 `low_sample_alerts`，轮询不会刷爆流水。
- **权限**：测量员可改夜间时段与阈值；复核员只能查看提醒与提醒记录（改阈值返回 403）。

默认配置：夜间 22:00–06:00（跨零点），统计窗 60 分钟，阈值 5 条；开始=结束视为不启用。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/low-sample/status` | GET | 当前判定状态（服务器时刻、是否落入时段、窗内办结、提醒亮熄） |
| `/api/low-sample/alerts` | GET | 提醒流水（最近 100 条） |
| `/api/low-sample/config` | PUT | 修改夜间时段与阈值（仅测量员） |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
