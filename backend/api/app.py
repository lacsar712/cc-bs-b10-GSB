import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty
from rules import in_night_window

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


def _hhmm(t) -> str:
    return t.strftime("%H:%M")


def _parse_hhmm(raw):
    s = str(raw or "").strip()
    try:
        return datetime.strptime(s, "%H:%M").time()
    except ValueError:
        return None


def _parse_int(raw, lo: int, hi: int) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, float) and not raw.is_integer():
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if lo <= value <= hi else None


async def _alert_payload(pool) -> dict:
    """读取低采样提醒的当前状态与流水。

    判定一律吃数据库服务器时刻（now()），不看调用方时钟；
    状态翻转（上升沿）时写入一条提醒流水，未翻转不重复写。
    """
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT now() AS server_now,
                       s.night_start, s.night_end, s.window_minutes, s.min_done,
                       s.updated_by, s.updated_at,
                       (SELECT COUNT(*) FROM strain_readings
                        WHERE status = 'done'
                          AND processed_at >= now() - make_interval(mins => s.window_minutes)
                       ) AS done_count
                FROM alert_settings s
                WHERE s.id = 1
                """
            )
            row = await cur.fetchone()
            server_now = row["server_now"]
            in_window = in_night_window(
                server_now.time(), row["night_start"], row["night_end"]
            )
            done_count = int(row["done_count"])
            active = in_window and done_count < row["min_done"]

            await cur.execute(
                """
                UPDATE alert_state
                SET is_active = %s, checked_at = now()
                WHERE id = 1 AND is_active IS DISTINCT FROM %s
                RETURNING id
                """,
                (active, active),
            )
            flipped = await cur.fetchone()
            if flipped and active:
                await cur.execute(
                    """
                    INSERT INTO alert_events
                        (night_start, night_end, window_minutes, done_count, min_done)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        row["night_start"],
                        row["night_end"],
                        row["window_minutes"],
                        done_count,
                        row["min_done"],
                    ),
                )

            await cur.execute(
                """
                SELECT id, triggered_at, night_start, night_end,
                       window_minutes, done_count, min_done
                FROM alert_events
                ORDER BY id DESC
                LIMIT 50
                """
            )
            events = await cur.fetchall()
        await conn.commit()

    return {
        "server_now": _iso(server_now),
        "settings": {
            "night_start": _hhmm(row["night_start"]),
            "night_end": _hhmm(row["night_end"]),
            "window_minutes": row["window_minutes"],
            "min_done": row["min_done"],
            "updated_by": row["updated_by"],
            "updated_at": _iso(row["updated_at"]),
        },
        "status": {
            "in_night_window": in_window,
            "done_count": done_count,
            "active": active,
        },
        "events": [
            {
                "id": e["id"],
                "triggered_at": _iso(e["triggered_at"]),
                "night_start": _hhmm(e["night_start"]),
                "night_end": _hhmm(e["night_end"]),
                "window_minutes": e["window_minutes"],
                "done_count": e["done_count"],
                "min_done": e["min_done"],
            }
            for e in events
        ],
    }


@app.get("/api/alerts/low-sampling")
async def get_low_sampling_alert(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    payload = await _alert_payload(request.app.ctx.pool)
    return sanic_json(payload)


@app.put("/api/alerts/low-sampling/settings")
async def put_low_sampling_settings(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json(
            {"detail": "复核员只读，夜间时段与阈值只能由测量员调整"}, status=403
        )
    body = request.json or {}
    night_start = _parse_hhmm(body.get("night_start"))
    night_end = _parse_hhmm(body.get("night_end"))
    if night_start is None or night_end is None:
        return sanic_json({"detail": "夜间时段须为 HH:MM（24 小时制）"}, status=400)
    window_minutes = _parse_int(body.get("window_minutes"), 1, 1440)
    if window_minutes is None:
        return sanic_json({"detail": "统计窗须为 1～1440 分钟的整数"}, status=400)
    min_done = _parse_int(body.get("min_done"), 0, 999)
    if min_done is None:
        return sanic_json({"detail": "办结阈值须为 0～999 的整数"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE alert_settings
                SET night_start = %s, night_end = %s,
                    window_minutes = %s, min_done = %s,
                    updated_by = %s, updated_at = now()
                WHERE id = 1
                """,
                (
                    night_start,
                    night_end,
                    window_minutes,
                    min_done,
                    user["username"],
                ),
            )
        await conn.commit()

    payload = await _alert_payload(pool)
    payload["message"] = "已保存夜间时段与阈值"
    return sanic_json(payload)
