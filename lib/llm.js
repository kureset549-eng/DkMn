// Neutral history: {role:"user"|"assistant"|"tool", content, toolCalls?:[{id,name,args}], id?, name?, isError?}
// Each adapter streams {text} chunks and finally yields {calls:[{id,name,args}]}.
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const base = (c, d) => (c.baseUrl || d).replace(/\/+$/, "");

async function* sse(res) {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

async function* openai(c, msgs, tools) {
  const messages = msgs.map((x) =>
    x.role === "tool" ? { role: "tool", tool_call_id: x.id, content: x.content }
    : x.toolCalls?.length ? { role: "assistant", content: x.content || null,
        tool_calls: x.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
    : { role: x.role, content: x.content });
  const body = { model: c.model, stream: true, messages };
  if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const res = await fetch(`${base(c, "https://api.openai.com/v1")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body) });
  const acc = [];
  for await (const j of sse(res)) {
    const d = j.choices?.[0]?.delta; if (!d) continue;
    if (d.content) yield { text: d.content };
    for (const t of d.tool_calls || []) {
      const k = (acc[t.index] ||= { id: "", name: "", raw: "" });
      if (t.id) k.id = t.id;
      if (t.function?.name) k.name += t.function.name;
      k.raw += t.function?.arguments || "";
    }
  }
  yield { calls: acc.filter(Boolean).map((k) => ({ id: k.id || crypto.randomUUID(), name: k.name, args: parse(k.raw) })) };
}

async function* anthropic(c, msgs, tools) {
  const messages = [];
  for (const x of msgs) {
    if (x.role === "tool") {
      const b = { type: "tool_result", tool_use_id: x.id, content: x.content || "(empty)", is_error: !!x.isError };
      const l = messages.at(-1);
      if (l?.role === "user" && Array.isArray(l.content)) l.content.push(b); else messages.push({ role: "user", content: [b] });
    } else if (x.role === "assistant") {
      messages.push({ role: "assistant", content: [
        ...(x.content ? [{ type: "text", text: x.content }] : []),
        ...(x.toolCalls || []).map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.args }))] });
    } else messages.push({ role: "user", content: x.content });
  }
  const body = { model: c.model, max_tokens: 4096, stream: true, messages };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const res = await fetch(`${base(c, "https://api.anthropic.com")}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const blocks = [];
  for await (const j of sse(res)) {
    if (j.type === "content_block_start" && j.content_block.type === "tool_use")
      blocks[j.index] = { id: j.content_block.id, name: j.content_block.name, raw: "" };
    else if (j.type === "content_block_delta") {
      if (j.delta.type === "text_delta") yield { text: j.delta.text };
      else if (j.delta.type === "input_json_delta") blocks[j.index].raw += j.delta.partial_json;
    } else if (j.type === "error") throw new Error(j.error?.message);
  }
  yield { calls: blocks.filter(Boolean).map((k) => ({ id: k.id, name: k.name, args: parse(k.raw) })) };
}

const DROP = ["$schema", "additionalProperties", "$id"];
const clean = (s) => Array.isArray(s) ? s.map(clean)
  : s && typeof s === "object" ? Object.fromEntries(Object.entries(s).filter(([k]) => !DROP.includes(k)).map(([k, v]) => [k, clean(v)])) : s;

async function* gemini(c, msgs, tools) {
  const contents = [];
  for (const x of msgs) {
    if (x.role === "tool") {
      const p = { functionResponse: { name: x.name, response: { result: x.content } } };
      const l = contents.at(-1);
      if (l?.parts?.[0]?.functionResponse) l.parts.push(p); else contents.push({ role: "user", parts: [p] });
    } else if (x.role === "assistant") {
      contents.push({ role: "model", parts: [
        ...(x.content ? [{ text: x.content }] : []),
        ...(x.toolCalls || []).map((t) => ({
          functionCall: { name: t.name, args: t.args },
          // Gemini 3+ requires the signature echoed back; fall back to the documented bypass value.
          thoughtSignature: t.sig || "skip_thought_signature_validator",
        }))] });
    } else contents.push({ role: "user", parts: [{ text: x.content }] });
  }
  const body = { contents };
  if (tools.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: clean(t.parameters) })) }];
  const res = await fetch(`${base(c, "https://generativelanguage.googleapis.com")}/v1beta/models/${c.model}:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": c.apiKey }, body: JSON.stringify(body) });
  const calls = [];
  for await (const j of sse(res))
    for (const p of j.candidates?.[0]?.content?.parts || []) {
      if (p.text) yield { text: p.text };
      if (p.functionCall) calls.push({
        id: crypto.randomUUID(), name: p.functionCall.name, args: p.functionCall.args || {},
        sig: p.thoughtSignature || p.thought_signature, // keep the original signature on the call
      });
    }
  yield { calls };
}

export const run = (c, msgs, tools) => ({ openai, anthropic, gemini }[c.provider] || openai)(c, msgs, tools);
