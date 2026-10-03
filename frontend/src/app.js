import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtServerTime(iso) {
  if (!iso) return "—";
  const match = String(iso).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (!match) return String(iso);
  const utc = /(Z|\+00:00)$/.test(String(iso)) ? " UTC" : "";
  return `${match[1]} ${match[2]}${utc}`;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  page: "main",
  alert: null,
  alertForm: { night_start: "", night_end: "", window_minutes: "", min_done: "" },
  alertMsg: "",
  alertError: "",
  alertSaving: false,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function loadAlerts() {
  if (!state.token) return;
  try {
    state.alert = await api("/api/alerts/low-sampling");
  } catch {
    // 提醒状态拉取失败不打断主流程，下一轮轮询再试
  }
  m.redraw();
}

function syncAlertForm() {
  const s = state.alert?.settings;
  if (!s) return;
  state.alertForm = {
    night_start: s.night_start,
    night_end: s.night_end,
    window_minutes: String(s.window_minutes),
    min_done: String(s.min_done),
  };
}

function tick() {
  loadReadings();
  loadAlerts();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(tick, 3000);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.alert = null;
  state.page = "main";
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

async function submitReading(e) {
  e.preventDefault();
  state.error = "";
  state.msg = "";
  state.loading = true;
  try {
    const data = await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.submitForm.span_code,
        microstrain: parseFloat(state.submitForm.microstrain),
      }),
    });
    state.msg = data.message || "已提交";
    state.submitForm = { span_code: "", microstrain: "" };
    await loadReadings();
  } catch (err) {
    state.error = err.message || "提交失败";
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function saveAlertSettings(e) {
  e.preventDefault();
  state.alertError = "";
  state.alertMsg = "";
  state.alertSaving = true;
  try {
    const data = await api("/api/alerts/low-sampling/settings", {
      method: "PUT",
      body: JSON.stringify({
        night_start: state.alertForm.night_start,
        night_end: state.alertForm.night_end,
        window_minutes: Number(state.alertForm.window_minutes),
        min_done: Number(state.alertForm.min_done),
      }),
    });
    state.alert = data;
    syncAlertForm();
    state.alertMsg = data.message || "已保存";
  } catch (err) {
    state.alertError = err.message || "保存失败";
  } finally {
    state.alertSaving = false;
    m.redraw();
  }
}

function topbar() {
  const isWriter = state.user?.role === "writer";
  const alertActive = state.alert?.status?.active;
  const onAlertPage = state.page === "alerts";
  return m("div.topbar", [
    m("div", [
      m("h1", "桥梁应变班交台"),
      m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
    ]),
    m("div.topbar-actions", [
      m("span.user", `${state.user?.username}（${isWriter ? "测量员" : "复核员"}）`),
      m(
        "button.secondary",
        {
          type: "button",
          onclick: () => {
            if (onAlertPage) {
              state.page = "main";
            } else {
              state.page = "alerts";
              state.alertMsg = "";
              state.alertError = "";
              syncAlertForm();
              loadAlerts();
            }
            m.redraw();
          },
        },
        [
          onAlertPage ? "返回读数列表" : "低采样提醒",
          alertActive ? m("span.badge-dot", { title: "夜间低采样提醒中" }) : null,
        ]
      ),
      m("button.secondary", { type: "button", onclick: logout }, "退出"),
    ]),
  ]);
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            state.error = "";
            state.loading = true;
            try {
              const data = await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(state.loginForm),
              });
              state.token = data.access_token;
              state.user = { username: data.username, role: data.role };
              localStorage.setItem(TOKEN_KEY, state.token);
              localStorage.setItem(USER_KEY, JSON.stringify(state.user));
              await loadReadings();
              await loadAlerts();
              startPolling();
            } catch {
              state.error = "用户名或密码错误";
            } finally {
              state.loading = false;
              m.redraw();
            }
          },
        },
        [
          m("div.row", [
            m("label", [
              "用户名",
              m("input", {
                value: state.loginForm.username,
                oninput: (e) => {
                  state.loginForm.username = e.target.value;
                },
              }),
            ]),
            m("label", [
              "密码",
              m("input", {
                type: "password",
                value: state.loginForm.password,
                oninput: (e) => {
                  state.loginForm.password = e.target.value;
                },
              }),
            ]),
            m("button", { type: "submit", disabled: state.loading }, "登录"),
          ]),
          state.error ? m("p.err", state.error) : null,
        ]
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);
}

function mainView() {
  const isWriter = state.user?.role === "writer";
  return m("div.wrap", [
    topbar(),
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m("form", { onsubmit: submitReading }, [
            m("div.row", [
              m("label", [
                "跨段编号",
                m("input", {
                  required: true,
                  placeholder: "例如 跨中S3",
                  value: state.submitForm.span_code,
                  oninput: (e) => {
                    state.submitForm.span_code = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "微应变（με）",
                m("input", {
                  required: true,
                  type: "number",
                  step: "0.1",
                  value: state.submitForm.microstrain,
                  oninput: (e) => {
                    state.submitForm.microstrain = e.target.value;
                  },
                }),
              ]),
              m("button", { type: "submit", disabled: state.loading }, "提交"),
            ]),
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", r.status),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
        ),
      ]),
    ]),
  ]);
}

function alertsView() {
  const isWriter = state.user?.role === "writer";
  const a = state.alert;
  const s = a?.settings;
  const st = a?.status;
  return m("div.wrap", [
    topbar(),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "夜间低采样提醒"),
      st
        ? st.active
          ? m("div.alert-banner.on", [
              m("strong", "⚠ 提醒中："),
              `夜间时段内最近 ${s.window_minutes} 分钟仅办结 ${st.done_count} 条，` +
                `低于阈值 ${s.min_done} 条。该提醒不阻断报送。`,
            ])
          : m("div.alert-banner.off", [
              m("strong", "当前无提醒："),
              st.in_night_window
                ? `夜间时段内最近 ${s.window_minutes} 分钟办结 ${st.done_count} 条，` +
                  `未低于阈值 ${s.min_done} 条。`
                : "当前服务器时刻不在夜间时段内。",
            ])
        : m("p.sub", "加载中…"),
      m("p.sub", { style: { marginBottom: 0 } }, [
        `服务器时刻 ${fmtServerTime(a?.server_now)}（提醒判定以服务器时刻为准）`,
        s ? ` · 夜间时段 ${s.night_start}–${s.night_end}` : "",
        s?.updated_by ? ` · 最近由 ${s.updated_by} 调整` : "",
      ]),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "夜间时段与阈值"),
      isWriter
        ? m("form", { onsubmit: saveAlertSettings }, [
            m("div.row", [
              m("label", [
                "夜间开始",
                m("input", {
                  type: "time",
                  required: true,
                  value: state.alertForm.night_start,
                  oninput: (e) => {
                    state.alertForm.night_start = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "夜间结束",
                m("input", {
                  type: "time",
                  required: true,
                  value: state.alertForm.night_end,
                  oninput: (e) => {
                    state.alertForm.night_end = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "统计窗（分钟）",
                m("input", {
                  type: "number",
                  min: 1,
                  max: 1440,
                  required: true,
                  value: state.alertForm.window_minutes,
                  oninput: (e) => {
                    state.alertForm.window_minutes = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "办结阈值（条）",
                m("input", {
                  type: "number",
                  min: 0,
                  max: 999,
                  required: true,
                  value: state.alertForm.min_done,
                  oninput: (e) => {
                    state.alertForm.min_done = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                { type: "submit", disabled: state.alertSaving },
                "保存"
              ),
            ]),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "落入夜间时段且统计窗内办结条数低于阈值时亮提醒并记流水；起止时刻相同视为未启用夜间时段。"
            ),
            state.alertError ? m("p.err", state.alertError) : null,
            state.alertMsg ? m("p.ok", state.alertMsg) : null,
          ])
        : m("div", [
            m(
              "p.sub",
              `夜间时段 ${s?.night_start ?? "—"}–${s?.night_end ?? "—"} · ` +
                `统计窗 ${s?.window_minutes ?? "—"} 分钟 · 办结阈值 ${s?.min_done ?? "—"} 条`
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "复核员只读：可查看提醒与提醒记录，夜间时段与阈值由测量员维护。"
            ),
          ]),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提醒流水"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "触发时间（服务器）"),
            m("th", "夜间时段"),
            m("th", "统计窗（分钟）"),
            m("th", "办结条数"),
            m("th", "阈值"),
          ]),
        ]),
        m(
          "tbody",
          a?.events?.length
            ? a.events.map((ev) =>
                m("tr", { key: ev.id }, [
                  m("td", fmtServerTime(ev.triggered_at)),
                  m("td", `${ev.night_start}–${ev.night_end}`),
                  m("td", ev.window_minutes),
                  m("td", ev.done_count),
                  m("td", ev.min_done),
                ])
              )
            : [m("tr", m("td", { colspan: 5 }, "暂无提醒记录"))]
        ),
      ]),
    ]),
  ]);
}

const App = {
  oninit() {
    loadReadings();
    loadAlerts();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) return loginView();
    return state.page === "alerts" ? alertsView() : mainView();
  },
};

export default App;
