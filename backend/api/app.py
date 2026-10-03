import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty
from rules import is_in_night_window

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _parse_hhmm(value, field: str):
    s = str(value or "").strip()
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    raise ValueError(f"{field}须为 HH:MM 格式")


async def _evaluate_low_sample(conn) -> dict:
    """按服务器时刻评估夜间低采样提醒。

    时钟取自数据库 now()/localtime（同事务内一致），不用应用进程或浏览器时钟。
    条件：落入夜间时段 且 最近 window_minutes 窗内办结条数 < min_done。
    仅在提醒状态翻转（熄→亮）时写一条提醒流水，避免轮询刷爆流水；
    评估结果只用于展示与记录，绝不阻断报送。
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT now() AS server_now, localtime AS server_clock,
                   night_start, night_end, window_minutes, min_done, alert_active
            FROM low_sample_config
            WHERE id = 1
            """
        )
        cfg = await cur.fetchone()
        server_now = cfg["server_now"]
        window_start = server_now - timedelta(minutes=cfg["window_minutes"])
        await cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM strain_readings
            WHERE status = 'done' AND processed_at >= %s
            """,
            (window_start,),
        )
        done_count = (await cur.fetchone())["n"]
        in_window = is_in_night_window(
            cfg["night_start"], cfg["night_end"], cfg["server_clock"]
        )
        should_alert = bool(in_window and done_count < cfg["min_done"])
        if should_alert != cfg["alert_active"]:
            await cur.execute(
                "UPDATE low_sample_config SET alert_active = %s WHERE id = 1",
                (should_alert,),
            )
            if should_alert:
                await cur.execute(
                    """
                    INSERT INTO low_sample_alerts
                        (window_start, window_end, done_count, min_done)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (window_start, server_now, done_count, cfg["min_done"]),
                )
    return {
        "server_now": _iso(server_now),
        "server_clock": cfg["server_clock"].strftime("%H:%M:%S"),
        "night_start": cfg["night_start"].strftime("%H:%M"),
        "night_end": cfg["night_end"].strftime("%H:%M"),
        "window_minutes": cfg["window_minutes"],
        "min_done": cfg["min_done"],
        "in_night_window": in_window,
        "done_count": done_count,
        "alert_active": should_alert,
    }


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


@app.get("/api/low-sample/status")
async def low_sample_status(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        status = await _evaluate_low_sample(conn)
        await conn.commit()
    status["can_edit"] = user["role"] == "writer"
    return sanic_json(status)


@app.get("/api/low-sample/alerts")
async def low_sample_alerts(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, triggered_at, window_start, window_end, done_count, min_done
                FROM low_sample_alerts
                ORDER BY id DESC
                LIMIT 100
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "triggered_at": _iso(r["triggered_at"]),
                "window_start": _iso(r["window_start"]),
                "window_end": _iso(r["window_end"]),
                "done_count": r["done_count"],
                "min_done": r["min_done"],
            }
        )
    return sanic_json(out)


@app.put("/api/low-sample/config")
async def update_low_sample_config(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json(
            {"detail": "复核员仅可查看提醒与提醒记录，不能修改阈值"}, status=403
        )
    body = request.json or {}
    try:
        night_start = _parse_hhmm(body.get("night_start"), "夜间开始")
        night_end = _parse_hhmm(body.get("night_end"), "夜间结束")
    except ValueError as exc:
        return sanic_json({"detail": str(exc)}, status=400)
    try:
        window_minutes = int(body.get("window_minutes"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "统计窗分钟数必须是整数"}, status=400)
    if not 1 <= window_minutes <= 1440:
        return sanic_json({"detail": "统计窗分钟数须在 1～1440 之间"}, status=400)
    try:
        min_done = int(body.get("min_done"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "办结阈值必须是整数"}, status=400)
    if not 1 <= min_done <= 9999:
        return sanic_json({"detail": "办结阈值须在 1～9999 之间"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE low_sample_config
                SET night_start = %s, night_end = %s,
                    window_minutes = %s, min_done = %s
                WHERE id = 1
                """,
                (night_start, night_end, window_minutes, min_done),
            )
        status = await _evaluate_low_sample(conn)
        await conn.commit()
    status["can_edit"] = True
    status["message"] = "夜间时段与阈值已保存"
    return sanic_json(status)
