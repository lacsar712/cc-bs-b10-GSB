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

function fmtTs(s) {
  return s ? s.replace("T", " ").slice(0, 19) : "—";
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
  page: "readings",
  lowSample: {
    status: null,
    alerts: [],
    form: { night_start: "", night_end: "", window_minutes: "", min_done: "" },
    error: "",
    msg: "",
    saving: false,
  },
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
}

async function loadLowSample() {
  if (!state.token) return;
  try {
    const [status, alerts] = await Promise.all([
      api("/api/low-sample/status"),
      api("/api/low-sample/alerts"),
    ]);
    state.lowSample.status = status;
    state.lowSample.alerts = alerts;
  } catch {
    // 低采样状态加载失败不打断报送主流程
  }
}

async function loadAll() {
  await Promise.all([loadReadings(), loadLowSample()]);
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadAll, 3000);
}

function syncLowSampleForm() {
  const st = state.lowSample.status;
  if (!st) return;
  state.lowSample.form = {
    night_start: st.night_start,
    night_end: st.night_end,
    window_minutes: String(st.window_minutes),
    min_done: String(st.min_done),
  };
}

async function openLowSample() {
  state.page = "lowsample";
  await loadLowSample();
  syncLowSampleForm();
  m.redraw();
}

function kv(label, value) {
  return [m("dt", label), m("dd", value)];
}

function lowSampleBanner(st, verbose) {
  if (!st) return m("div.banner.calm", "正在加载低采样提醒状态…");
  if (st.alert_active) {
    return m("div.banner.alert", [
      m("strong", "⚠ 夜间低采样提醒："),
      `服务器时刻 ${st.server_clock} 落入夜间时段 ${st.night_start}–${st.night_end}，` +
        `最近 ${st.window_minutes} 分钟办结 ${st.done_count} 条，低于阈值 ${st.min_done} 条。` +
        (verbose ? "提醒仅作提示并写入流水，不阻断报送。" : "提醒不阻断报送，详见低采样提醒专页。"),
    ]);
  }
  if (!verbose) return null;
  return m(
    "div.banner.calm",
    st.in_night_window
      ? `当前处于夜间时段（${st.night_start}–${st.night_end}），最近 ${st.window_minutes} 分钟办结 ${st.done_count} 条，已达阈值 ${st.min_done} 条，提醒熄灭。`
      : `当前服务器时刻 ${st.server_clock} 不在夜间时段（${st.night_start}–${st.night_end}），提醒熄灭。`
  );
}

function lowSampleConfigCard() {
  const ls = state.lowSample;
  const st = ls.status;
  const isWriter = state.user?.role === "writer";
  if (!isWriter) {
    return m("div.card", [
      m("h2.cardtitle", "夜间时段与阈值"),
      st
        ? m("dl.kv", [
            kv("夜间时段", `${st.night_start} – ${st.night_end}`),
            kv("统计窗", `最近 ${st.window_minutes} 分钟`),
            kv("办结阈值", `${st.min_done} 条`),
          ])
        : null,
      m("p.hint", "复核员仅可查看提醒与提醒记录，不能修改阈值。"),
    ]);
  }
  return m("div.card", [
    m("h2.cardtitle", "夜间时段与阈值"),
    m(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          ls.error = "";
          ls.msg = "";
          ls.saving = true;
          try {
            const status = await api("/api/low-sample/config", {
              method: "PUT",
              body: JSON.stringify({
                night_start: ls.form.night_start,
                night_end: ls.form.night_end,
                window_minutes: parseInt(ls.form.window_minutes, 10),
                min_done: parseInt(ls.form.min_done, 10),
              }),
            });
            ls.status = status;
            ls.msg = status.message || "已保存";
            syncLowSampleForm();
            await loadLowSample();
          } catch (err) {
            ls.error = err.message || "保存失败";
          } finally {
            ls.saving = false;
            m.redraw();
          }
        },
      },
      [
        m("div.row", [
          m("label", [
            "夜间开始",
            m("input", {
              type: "time",
              required: true,
              value: ls.form.night_start,
              oninput: (e) => {
                ls.form.night_start = e.target.value;
              },
            }),
          ]),
          m("label", [
            "夜间结束",
            m("input", {
              type: "time",
              required: true,
              value: ls.form.night_end,
              oninput: (e) => {
                ls.form.night_end = e.target.value;
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
              value: ls.form.window_minutes,
              oninput: (e) => {
                ls.form.window_minutes = e.target.value;
              },
            }),
          ]),
          m("label", [
            "办结阈值（条）",
            m("input", {
              type: "number",
              min: 1,
              max: 9999,
              required: true,
              value: ls.form.min_done,
              oninput: (e) => {
                ls.form.min_done = e.target.value;
              },
            }),
          ]),
          m("button", { type: "submit", disabled: ls.saving }, "保存"),
        ]),
        ls.error ? m("p.err", ls.error) : null,
        ls.msg ? m("p.ok", ls.msg) : null,
        m(
          "p.hint",
          "时段按服务器时刻判定，开始=结束视为不启用；保存后立即重新判定，提醒不阻断报送。"
        ),
      ]
    ),
  ]);
}

function lowSamplePage() {
  const ls = state.lowSample;
  const st = ls.status;
  return m("div", [
    lowSampleBanner(st, true),
    m("div.card", [
      m("h2.cardtitle", "判定依据（吃服务器时刻）"),
      st
        ? m("dl.kv", [
            kv("服务器时刻", `${fmtTs(st.server_now)}（判定取 ${st.server_clock}）`),
            kv("夜间时段", `${st.night_start} – ${st.night_end}`),
            kv("落入夜间时段", st.in_night_window ? "是" : "否"),
            kv("统计窗", `最近 ${st.window_minutes} 分钟`),
            kv("窗内办结", `${st.done_count} 条`),
            kv("办结阈值", `${st.min_done} 条`),
            kv("提醒状态", st.alert_active ? "亮（翻转时写流水）" : "熄"),
          ])
        : m("p.sub", "加载中…"),
      m(
        "p.hint",
        "提醒判定以服务器时刻为准，不取浏览器时钟；提醒只亮灯、写流水，绝不阻断读数报送。"
      ),
    ]),
    lowSampleConfigCard(),
    m("div.card", [
      m("h2.cardtitle", "提醒流水"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "触发时刻"),
            m("th", "统计窗起"),
            m("th", "统计窗止"),
            m("th", "窗内办结"),
            m("th", "阈值"),
          ]),
        ]),
        m(
          "tbody",
          ls.alerts.length
            ? ls.alerts.map((a) =>
                m("tr", { key: a.id }, [
                  m("td", a.id),
                  m("td", fmtTs(a.triggered_at)),
                  m("td", fmtTs(a.window_start)),
                  m("td", fmtTs(a.window_end)),
                  m("td", `${a.done_count} 条`),
                  m("td", `${a.min_done} 条`),
                ])
              )
            : [m("tr", m("td", { colspan: 6 }, "暂无提醒记录"))]
        ),
      ]),
    ]),
  ]);
}

function readingsPage(isWriter) {
  const st = state.lowSample.status;
  return m("div", [
    st && st.alert_active ? lowSampleBanner(st, false) : null,
    isWriter
      ? m("div.card", [
          m("h2.cardtitle", "提交读数"),
          m(
            "form",
            {
              onsubmit: async (e) => {
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
              },
            },
            [
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
                m(
                  "button",
                  { type: "submit", disabled: state.loading },
                  "提交"
                ),
              ]),
              state.error ? m("p.err", state.error) : null,
              state.msg ? m("p.ok", state.msg) : null,
            ]
          ),
        ])
      : null,
    m("div.card", [
      m("h2.cardtitle", "读数列表"),
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

const App = {
  oninit() {
    loadAll();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
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
                    await loadAll();
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
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
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
        ]
      );
    }

    const isWriter = state.user?.role === "writer";
    const alertOn = state.lowSample.status?.alert_active;

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.page = "readings";
                state.lowSample.status = null;
                state.lowSample.alerts = [];
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      m("div.topnav", [
        m(
          "button.navbtn" + (state.page === "readings" ? ".active" : ""),
          {
            type: "button",
            onclick: () => {
              state.page = "readings";
            },
          },
          "读数报送"
        ),
        m(
          "button.navbtn" + (state.page === "lowsample" ? ".active" : ""),
          { type: "button", onclick: openLowSample },
          ["低采样提醒", alertOn ? m("span.dot", { title: "低采样提醒中" }) : null]
        ),
      ]),
      state.page === "lowsample" ? lowSamplePage() : readingsPage(isWriter),
    ]);
  },
};

export default App;
