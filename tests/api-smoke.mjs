import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["server/index.mjs"], { stdio: "ignore" });
const base = "http://127.0.0.1:8787";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  for (let index = 0; index < 30; index += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await wait(100);
  }
  const created = await fetch(`${base}/api/sessions`, { method: "POST" }).then((response) => response.json());
  if (!created.session?.id) throw new Error("创建会话失败");

  const logistics = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: created.session.id, message: "订单 OD20260620001 到哪里了？" })
  }).then((response) => response.json());
  if (!logistics.messages?.some((message) => message.intent === "物流查询")) throw new Error("物流意图测试失败");

  const handoff = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: created.session.id, message: "退款金额不对，我要投诉并转人工" })
  }).then((response) => response.json());
  if (handoff.session.status !== "waiting_agent") throw new Error("转人工测试失败");

  const tickets = await fetch(`${base}/api/agent/tickets`).then((response) => response.json());
  if (!tickets.tickets?.length) throw new Error("工单创建测试失败");
  console.log("API smoke test passed");
} finally {
  child.kill();
}
