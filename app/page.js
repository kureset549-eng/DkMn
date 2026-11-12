"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

const HINT = {
  openai: ["gpt-4o", "https://api.openai.com/v1"],
  anthropic: ["claude-sonnet-4-5", "https://api.anthropic.com"],
  gemini: ["gemini-2.5-flash", "https://generativelanguage.googleapis.com"],
};
const DEF = {
  provider: "openai", apiKey: "", baseUrl: "", model: "gpt-4o",
  mcp: JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }, null, 2),
};

function Md({ text }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown></div>;
}

function Tool({ p }) {
  const st = p.result === undefined ? "running" : p.isError ? "err" : "ok";
  return (
    <details className={"tool " + st}>
      <summary>{p.name} <i>{st === "running" ? "调用中…" : st === "ok" ? "完成" : "出错"}</i></summary>
      <b>参数</b><pre>{JSON.stringify(p.args, null, 2)}</pre>
      {p.result !== undefined && <><b>返回</b><pre>{p.result}</pre></>}
    </details>
  );
}

export default function Page() {
  const [cfg, setCfg] = useState(DEF);
  const [ready, setReady] = useState(false);
  const [servers, setServers] = useState([]);
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  useEffect(() => {
    try { const s = localStorage.getItem("dkmn.cfg"); if (s) setCfg({ ...DEF, ...JSON.parse(s) }); } catch {}
    setReady(true);
    fetch("/api/mcp").then((r) => r.json()).then((d) => setServers(d.servers || [])).catch(() => {});
  }, []);
  useEffect(() => { if (ready) localStorage.setItem("dkmn.cfg", JSON.stringify(cfg)); }, [cfg, ready]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const pickProvider = (e) => { const p = e.target.value; setCfg((c) => ({ ...c, provider: p, model: HINT[p][0], baseUrl: "" })); };

  async function connect() {
    setConnecting(true); setErr("");
    const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg.mcp }) });
    const d = await r.json();
    if (d.error) setErr(d.error); else setServers(d.servers);
    setConnecting(false);
  }

  async function send() {
    const q = input.trim(); if (!q || busy) return;
    const history = [...msgs.map((m) => ({ role: m.role, content: m.role === "user" ? m.text : m.parts.filter((p) => p.type === "text").map((p) => p.text).join("") })), { role: "user", content: q }];
    setInput(""); setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: q }, { role: "assistant", parts: [] }]);
    const upd = (fn) => setMsgs((m) => { const c = [...m]; const a = { ...c.at(-1), parts: [...c.at(-1).parts] }; fn(a.parts); c[c.length - 1] = a; return c; });
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cfg, messages: history }) });
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.t === "text") upd((p) => { const last = p.at(-1); if (last?.type === "text") p[p.length - 1] = { ...last, text: last.text + e.v }; else p.push({ type: "text", text: e.v }); });
          else if (e.t === "tool") upd((p) => p.push({ type: "tool", id: e.id, name: e.name, args: e.args }));
          else if (e.t === "result") upd((p) => { const i = p.findIndex((x) => x.id === e.id); if (i >= 0) p[i] = { ...p[i], result: e.result, isError: e.isError }; });
          else if (e.t === "error") upd((p) => p.push({ type: "text", text: "⚠️ " + e.v }));
        }
      }
    } catch (e) { upd((p) => p.push({ type: "text", text: "⚠️ " + e.message })); }
    setBusy(false);
  }

  return (
    <div className="app">
      <aside>
        <h1>DkMn</h1>
        <label>模型服务商
          <select value={cfg.provider} onChange={pickProvider}>
            <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option>
          </select>
        </label>
        <label>API Key<input type="password" value={cfg.apiKey} onChange={set("apiKey")} placeholder="sk-..." /></label>
        <label>Base URL<input value={cfg.baseUrl} onChange={set("baseUrl")} placeholder={HINT[cfg.provider][1]} /></label>
        <label>模型<input value={cfg.model} onChange={set("model")} /></label>
        <label>MCP 配置（mcpServers JSON）
          <textarea rows={9} spellCheck={false} value={cfg.mcp} onChange={set("mcp")} />
        </label>
        <button onClick={connect} disabled={connecting}>{connecting ? "连接中…" : "连接 MCP"}</button>
        {err && <p className="error">{err}</p>}
        <div className="servers">
          {servers.length === 0 && <p className="muted">尚未连接任何 MCP Server。</p>}
          {servers.map((s) => (
            <details key={s.name} open>
              <summary><span className={"dot " + s.status} />{s.name}<i>{s.status === "connected" ? `${s.tools.length} 个工具` : "失败"}</i></summary>
              {s.error && <p className="error">{s.error}</p>}
              <ul>{s.tools.map((t) => <li key={t.name} title={t.description}>{t.name}</li>)}</ul>
            </details>
          ))}
        </div>
      </aside>
      <main>
        <div className="feed">
          {msgs.length === 0 && <div className="empty"><h2>今天想做点什么？</h2><p className="muted">连接 MCP 后，模型会在需要时自动调用工具。</p></div>}
          {msgs.map((m, i) => m.role === "user"
            ? <div key={i} className="row user"><div className="bubble">{m.text}</div></div>
            : <div key={i} className="row">{m.parts.map((p, j) => p.type === "tool" ? <Tool key={j} p={p} /> : <Md key={j} text={p.text} />)}
                {busy && i === msgs.length - 1 && m.parts.length === 0 && <span className="muted">思考中…</span>}</div>)}
          <div ref={end} />
        </div>
        <div className="composer">
          <textarea rows={1} value={input} placeholder="给 DkMn 发送消息" onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button onClick={send} disabled={busy || !input.trim()}>发送</button>
        </div>
      </main>
    </div>
  );
}
