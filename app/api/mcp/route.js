import { connectAll, list } from "@/lib/mcp";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

export async function GET() { return Response.json({ servers: list() }); }

export async function POST(req) {
  try {
    const { config } = await req.json();
    return Response.json({ servers: await connectAll(config) });
  } catch (e) {
    return Response.json({ error: "Invalid JSON or connection failure: " + (e.message || e) }, { status: 400 });
  }
}
