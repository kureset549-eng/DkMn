import { toolDefs, callTool } from "@/lib/mcp";
import { run } from "@/lib/llm";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

const MAX_ROUNDS = 10;

export async function POST(req) {
  const { cfg, messages } = await req.json();
  const defs = toolDefs();
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const send = (o) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const hist = [...messages];
        for (let i = 0; i < MAX_ROUNDS; i++) {
          let text = "", calls = [];
          for await (const e of run(cfg, hist, defs)) {
            if (e.text) { text += e.text; send({ t: "text", v: e.text }); }
            if (e.calls) calls = e.calls;
          }
          if (!calls.length) break;
          hist.push({ role: "assistant", content: text, toolCalls: calls });
          for (const c of calls) {
            send({ t: "tool", id: c.id, name: c.name, args: c.args });
            const def = defs.find((d) => d.name === c.name);
            let r;
            try { r = def ? await callTool(def, c.args) : { text: `Unknown tool: ${c.name}`, isError: true }; }
            catch (e) { r = { text: String(e.message || e), isError: true }; }
            send({ t: "result", id: c.id, result: r.text, isError: r.isError });
            hist.push({ role: "tool", id: c.id, name: c.name, content: r.text, isError: r.isError });
          }
        }
      } catch (e) { send({ t: "error", v: String(e.message || e) }); }
      ctrl.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}
