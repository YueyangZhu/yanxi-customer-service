import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const app = express();
const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const COZE_TOKEN = process.env.COZE_API_TOKEN || "";
const COZE_BOT_ID = process.env.COZE_BOT_ID || "";
const COZE_BASE = "https://api.coze.cn";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json({ limit: "300kb" }));

const now = () => {
  const d = new Date();
  return new Date(d.getTime() + 8 * 3600000).toISOString().replace("Z", "+08:00");
};
const id = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
const findOrderNo = (text) => text.match(/OD\d{11}/i)?.[0]?.toUpperCase() || "";

function withinBeijingRange(items, range = {}, field = "created_at") {
  const from = range.from ? new Date(`${range.from}T00:00:00+08:00`).getTime() : 0;
  const to = range.to ? new Date(`${range.to}T23:59:59.999+08:00`).getTime() : Number.MAX_SAFE_INTEGER;
  return items.filter((item) => {
    const timestamp = new Date(item[field] || item.created_at || 0).getTime();
    return timestamp >= from && timestamp <= to;
  });
}

async function listMessages(sessionId) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function addMessage(sessionId, role, content, extra = {}) {
  const message = {
    id: randomUUID(),
    session_id: sessionId,
    role,
    content,
    created_at: now(),
    ...extra
  };
  const { error } = await supabase.from("messages").insert(message);
  if (error) throw error;
  return message;
}

async function getSession(sessionId) {
  const { data, error } = await supabase.from("sessions").select("*").eq("id", sessionId).single();
  if (error) throw error;
  return data;
}

async function updateSession(sessionId, patch) {
  const { data, error } = await supabase
    .from("sessions")
    .update({ ...patch, updated_at: now() })
    .eq("id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getOrder(orderNo) {
  const { data, error } = await supabase.from("orders").select("*").eq("id", orderNo).single();
  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function updateOrder(orderNo, patch) {
  const { data, error } = await supabase.from("orders").update({ ...patch, updated_at: now() }).eq("id", orderNo).select().single();
  if (error) throw error;
  return data;
}

function understand(text) {
  const orderNo = findOrderNo(text);
  if (/投诉|太离谱|骗人|生气|差评|人工|金额不对|赔偿/.test(text)) {
    return { intent: "投诉与人工服务", confidence: 0.96, action: "create_ticket", orderNo, source: "风险策略", needHandoff: true, handoffReason: "用户投诉、要求人工或涉及金额争议", riskLevel: "high" };
  }
  if (/(退款|退钱|退的钱|钱退).*(进度|到账|到哪|多久|什么时候|状态|审核|处理到|退回)/.test(text) || /(进度|到账|到哪|多久|什么时候|状态|审核).*(退款|退钱|退的钱|钱退)/.test(text)) {
    return { intent: "退款进度", confidence: 0.93, action: "query_refund", orderNo, source: "退款系统", needHandoff: false, handoffReason: "", riskLevel: "medium" };
  }
  if (/申请退款|我要退款|退货退款/.test(text)) {
    return { intent: "退款申请", confidence: 0.91, action: "show_refund_form", orderNo, source: "售后规则", needHandoff: false, handoffReason: "", riskLevel: "medium" };
  }
  if (/物流|快递|到哪里|到哪了|没到|发货|送到|送达|预计到达/.test(text)) {
    return { intent: "物流查询", confidence: 0.94, action: "query_order", orderNo, source: "订单系统", needHandoff: false, handoffReason: "", riskLevel: "low" };
  }
  if (/退货|七天|7天|无理由|签收后几天|换货|发票|破损|损坏|缺件|贴身用品|能退吗/.test(text)) {
    return { intent: "商品与政策咨询", confidence: 0.91, action: "search_knowledge", orderNo, source: "言析电商售后知识库", needHandoff: false, handoffReason: "", riskLevel: "low" };
  }
  return { intent: "未知问题", confidence: 0.38, action: "create_ticket", orderNo, source: "知识库未命中", needHandoff: true, handoffReason: "知识库暂无可靠答案", riskLevel: "medium" };
}

function fallbackAnswer(result) {
  if (result.action === "query_order") {
    if (!result.orderNo) return "请把订单号发给我，格式类似 OD20260620001。";
    return "订单查询已记录，请稍后再试。";
  }
  if (result.action === "query_refund") {
    if (!result.orderNo) return "请提供需要查询的订单号。";
    return "退款查询已记录，请稍后再试。";
  }
  if (result.action === "show_refund_form") return result.orderNo ? `已识别订单 ${result.orderNo}，请在退款申请卡中确认原因并提交。` : "可以为你申请退款，请先提供订单号。";
  if (result.needHandoff) return result.riskLevel === "high" ? "我理解这个问题需要更谨慎地处理。已为你创建人工工单，客服会连同当前对话一起接手。" : "这个问题目前没有匹配到可靠答案。为了不误导你，我已转交人工客服处理。";
  return "我正在为你核实这个问题。";
}

async function cozeRequest(path, options = {}) {
  const response = await fetch(`${COZE_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${COZE_TOKEN}`, "Content-Type": "application/json", ...options.headers }
  });
  const body = await response.json();
  if (!response.ok || body.code) throw new Error(body.msg || `Coze API 请求失败（${response.status}）`);
  return body.data;
}

async function createCozeConversation(name) {
  if (!COZE_TOKEN || !COZE_BOT_ID) return "";
  const data = await cozeRequest("/v1/conversation/create", { method: "POST", body: JSON.stringify({ bot_id: COZE_BOT_ID, name }) });
  return String(data.id);
}

async function askCoze(session, text) {
  if (!COZE_TOKEN || !COZE_BOT_ID) return "";
  let conversationId = session.coze_conversation_id;
  if (!conversationId) {
    conversationId = await createCozeConversation(`网页会话_${session.id.slice(-8)}`);
    await updateSession(session.id, { coze_conversation_id: conversationId });
  }
  const created = await cozeRequest(`/v3/chat?conversation_id=${conversationId}`, {
    method: "POST",
    body: JSON.stringify({ bot_id: COZE_BOT_ID, user_id: session.user_id, stream: false, auto_save_history: true, additional_messages: [{ role: "user", type: "question", content_type: "text", content: text }] })
  });
  const chatId = String(created.id);
  for (let index = 0; index < 30; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const detail = await cozeRequest(`/v3/chat/retrieve?conversation_id=${conversationId}&chat_id=${chatId}`);
    if (detail.status === "failed") throw new Error(detail.last_error?.msg || "Coze 生成失败");
    if (detail.status === "completed") break;
  }
  const list = await cozeRequest(`/v3/chat/message/list?conversation_id=${conversationId}&chat_id=${chatId}`);
  return list.find((item) => item.role === "assistant" && item.type === "answer")?.content || "";
}

async function createTicket(session, result, text) {
  const ticketId = id("TK");
  const ticket = {
    id: ticketId,
    session_id: session.id,
    intent: result.intent,
    confidence: result.confidence,
    summary: `用户问题：${text}。AI 判断为“${result.intent}”，建议人工核实并给出明确方案。`,
    handoff_reason: result.handoffReason,
    priority: result.riskLevel === "high" ? "high" : "normal",
    status: "open",
    created_at: now(),
    updated_at: now()
  };
  const { error: ticketError } = await supabase.from("tickets").insert(ticket);
  if (ticketError) throw ticketError;
  await updateSession(session.id, { status: "waiting_agent", ticket_id: ticketId });
  return ticket;
}

async function recordKnowledgeGap(question) {
  const gapId = `GAP_${Buffer.from(question).toString("hex").slice(0, 24)}`;
  const { data: existing } = await supabase.from("knowledge_gaps").select("count").eq("id", gapId).single();
  if (existing) {
    await supabase.from("knowledge_gaps").update({ count: existing.count + 1, updated_at: now() }).eq("id", gapId);
  } else {
    await supabase.from("knowledge_gaps").insert({ id: gapId, question, count: 1, status: "open", created_at: now(), updated_at: now() });
  }
}

function buildDashboard(range = {}) {
  return async () => {
    const [
      { data: sessions },
      { data: messages },
      { data: tickets },
      { data: ratings },
      { data: gaps }
    ] = await Promise.all([
      supabase.from("sessions").select("*").limit(100),
      supabase.from("messages").select("*").limit(100),
      supabase.from("tickets").select("*").limit(100),
      supabase.from("ratings").select("*").limit(100),
      supabase.from("knowledge_gaps").select("*").limit(100)
    ]);
    const s = withinBeijingRange(sessions || [], range);
    const m = withinBeijingRange(messages || [], range);
    const t = withinBeijingRange(tickets || [], range);
    const r = withinBeijingRange(ratings || [], range);
    const g = withinBeijingRange(gaps || [], range);
    const total = Math.max(s.length, 1);
    const solved = r.filter((item) => item.resolved).length;
    const average = r.length ? r.reduce((sum, item) => sum + item.score, 0) / r.length : 0;
    const counts = {};
    m.filter((item) => item.role === "assistant" && item.intent && !["欢迎语", "人工回复"].includes(item.intent))
      .forEach((item) => { counts[item.intent] = (counts[item.intent] || 0) + 1; });
    const max = Math.max(...Object.values(counts), 1);
    const ticketSessions = new Set(t.map((item) => item.session_id));
    const resolvedSessions = new Set(r.filter((item) => item.resolved).map((item) => item.session_id));
    const aiResolved = s.filter((item) => resolvedSessions.has(item.id) && !ticketSessions.has(item.id)).length;
    const humanResolved = s.filter((item) => resolvedSessions.has(item.id) && ticketSessions.has(item.id)).length;
    const inProgress = Math.max(0, s.length - aiResolved - humanResolved);
    return {
      range: { from: range.from || "", to: range.to || "", timeZone: "Asia/Shanghai" },
      metrics: {
        sessions: s.length,
        solveRate: Math.round(solved / total * 100),
        handoffRate: Math.round(t.length / total * 100),
        satisfaction: Number(average.toFixed(1)),
        messages: m.length,
        aiHandled: m.filter((item) => item.role === "assistant").length,
        handoffs: t.length,
        ratings: r.length,
        aiResolved,
        humanResolved,
        inProgress
      },
      intents: Object.entries(counts).map(([name, count]) => ({ name, count, percent: Math.round(count / max * 100) })),
      knowledgeGaps: g.sort((a, b) => b.count - a.count),
      closure: [
        { name: "AI 自助解决", count: aiResolved },
        { name: "人工已解决", count: humanResolved },
        { name: "处理中", count: inProgress }
      ]
    };
  };
}

async function pick(items, fields, range = {}) {
  return withinBeijingRange(items, range).map((item) => Object.fromEntries(fields.map((field) => [field, item[field] ?? ""])));
}

// ============================================================
// RESTful 路由
// ============================================================

app.post("/api/sessions", async (_req, res) => {
  const sessionId = id("CS");
  const userId = `web_${randomUUID().slice(0, 8)}`;
  const session = {
    id: sessionId,
    user_id: userId,
    coze_conversation_id: "",
    status: "active",
    resolved: null,
    ticket_id: "",
    pending_chat_id: "",
    pending_message: "",
    created_at: now(),
    updated_at: now()
  };
  const { error } = await supabase.from("sessions").insert(session);
  if (error) return res.status(500).json({ message: error.message });
  await addMessage(sessionId, "assistant", "你好，我是言析售后助手。你可以直接描述商品、物流、退换货或退款问题；复杂问题我会连同上下文一起交给人工客服。", { intent: "欢迎语", confidence: 1, action: "answer", source: "系统预设", risk_level: "low" });
  res.status(201).json({ session, messages: await listMessages(sessionId) });
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    res.json({ session, messages: await listMessages(req.params.id) });
  } catch {
    res.status(404).json({ message: "会话不存在" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ message: "会话或消息无效" });
  let session;
  try { session = await getSession(sessionId); } catch { return res.status(400).json({ message: "会话或消息无效" }); }
  const text = message.trim();
  await addMessage(sessionId, "user", text);
  const result = understand(text);
  let answer = "";
  let source = result.source;

  // 确定性业务动作优先走本地数据，不依赖 Coze 生成
  if (["query_order", "query_refund"].includes(result.action)) {
    const order = await getOrder(result.orderNo);
    if (result.action === "query_order") {
      answer = !result.orderNo
        ? "请把订单号发给我，格式类似 OD20260620001。"
        : !order
          ? `没有查到订单 ${result.orderNo}，请检查订单号是否完整。`
          : `查到订单 ${order.id}（${order.product}），当前状态为“${order.status}”，${order.logistics || order.refund || "暂无物流信息。"}`;
    } else {
      answer = !result.orderNo
        ? "请提供需要查询的订单号。"
        : !order
          ? `没有查到订单 ${result.orderNo}。`
          : `订单 ${order.id} 当前状态为“${order.status}”。${order.refund || "暂时没有退款记录。"}`;
    }
    source = answer.includes("订单") ? "订单系统" : source;
  } else if (result.action === "show_refund_form") {
    answer = result.orderNo ? `已识别订单 ${result.orderNo}，请在退款申请卡中确认原因并提交。` : "可以为你申请退款，请先提供订单号。";
  } else if (result.needHandoff) {
    answer = result.riskLevel === "high"
      ? "我理解这个问题需要更谨慎地处理。已为你创建人工工单，客服会连同当前对话一起接手。"
      : "这个问题目前没有匹配到可靠答案。为了不误导你，我已转交人工客服处理。";
  } else {
    // 非确定性咨询调用 Coze 生成自然语言回答
    try { answer = await askCoze(session, text); } catch (error) { console.warn("Coze fallback:", error.message); }
    if (!answer) {
      answer = result.intent === "商品与政策咨询"
        ? "这个问题建议参考商品详情页或联系人工客服确认具体政策。"
        : "我正在为你核实这个问题。";
    }
  }

  await addMessage(sessionId, "assistant", answer, {
    intent: result.intent,
    confidence: result.confidence,
    action: result.action,
    source,
    risk_level: result.riskLevel
  });
  if (result.needHandoff && !session.ticket_id) await createTicket(session, result, text);
  if (result.intent === "未知问题") await recordKnowledgeGap(text);
  const updated = await getSession(sessionId);
  res.json({ session: updated, messages: await listMessages(sessionId), decision: result });
});

app.post("/api/refunds", async (req, res) => {
  const { sessionId, orderNo, reason } = req.body || {};
  let session;
  try { session = await getSession(sessionId); } catch { return res.status(400).json({ message: "请完整填写退款信息" }); }
  const order = await getOrder(orderNo);
  if (!order || !reason) return res.status(400).json({ message: "请完整填写退款信息" });
  if (!order.refundable) return res.status(409).json({ message: "该订单当前不可重复申请退款" });
  const refundId = id("RF");
  const refund = { id: refundId, session_id: sessionId, order_no: orderNo, reason, status: "待审核", created_at: now(), updated_at: now() };
  const { error } = await supabase.from("refunds").insert(refund);
  if (error) return res.status(500).json({ message: error.message });
  await updateOrder(orderNo, { status: "退款审核中" });
  await addMessage(sessionId, "assistant", `退款申请 ${refundId} 已提交，审核结果会在当前会话更新。`, { intent: "退款申请", confidence: 1, action: "answer", source: "退款系统", risk_level: "medium" });
  res.status(201).json({ refund });
});

app.post("/api/ratings", async (req, res) => {
  const { sessionId, score, resolved, comment = "" } = req.body || {};
  let session;
  try { session = await getSession(sessionId); } catch { return res.status(400).json({ message: "评价信息无效" }); }
  if (!Number.isInteger(score) || score < 1 || score > 5) return res.status(400).json({ message: "评价信息无效" });
  const ratingId = id("RT");
  const rating = { id: ratingId, session_id: sessionId, score, resolved: Boolean(resolved), comment, created_at: now() };
  const { error } = await supabase.from("ratings").insert(rating);
  if (error) return res.status(500).json({ message: error.message });
  await updateSession(sessionId, { resolved: rating.resolved, status: "closed" });
  res.status(201).json({ rating });
});

app.get("/api/agent/tickets", async (_req, res) => {
  const { data, error } = await supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ message: error.message });
  const tickets = await Promise.all((data || []).map(async (ticket) => ({ ...ticket, messages: await listMessages(ticket.session_id) })));
  res.json({ tickets });
});

app.post("/api/agent/tickets/:id/claim", async (req, res) => {
  const { data: ticket, error } = await supabase.from("tickets").select("*").eq("id", req.params.id).single();
  if (error || !ticket) return res.status(404).json({ message: "工单不存在" });
  if (ticket.status === "closed") return res.status(409).json({ message: "已关闭工单不能重新接入" });
  const updated = { ...ticket, status: "processing", agent: "演示客服", claimed_at: now(), updated_at: now() };
  await supabase.from("tickets").update({ status: "processing", agent: "演示客服", claimed_at: now(), updated_at: now() }).eq("id", ticket.id);
  await updateSession(ticket.session_id, { status: "processing" });
  res.json({ ticket: updated });
});

app.post("/api/agent/tickets/:id/reply", async (req, res) => {
  const { data: ticket, error } = await supabase.from("tickets").select("*").eq("id", req.params.id).single();
  if (error || !ticket) return res.status(404).json({ message: "工单不存在" });
  if (ticket.status !== "processing") return res.status(409).json({ message: "请先接入会话，再发送人工回复" });
  if (!req.body?.content?.trim()) return res.status(400).json({ message: "回复内容不能为空" });
  const message = await addMessage(ticket.session_id, "agent", req.body.content.trim(), { intent: "人工回复", source: "人工客服" });
  await supabase.from("ticket_replies").insert({ id: message.id, ticket_id: ticket.id, session_id: ticket.session_id, content: message.content, created_at: message.created_at });
  await supabase.from("tickets").update({ updated_at: now() }).eq("id", ticket.id);
  await updateSession(ticket.session_id, { status: "processing" });
  res.json({ ticket: { ...ticket, updated_at: now() } });
});

app.post("/api/agent/tickets/:id/close", async (req, res) => {
  const { data: ticket, error } = await supabase.from("tickets").select("*").eq("id", req.params.id).single();
  if (error || !ticket) return res.status(404).json({ message: "工单不存在" });
  if (ticket.status !== "processing") return res.status(409).json({ message: "请先接入会话，再关闭工单" });
  await supabase.from("tickets").update({ status: "closed", closed_at: now(), updated_at: now() }).eq("id", ticket.id);
  await updateSession(ticket.session_id, { status: "closed" });
  res.json({ ticket: { ...ticket, status: "closed", closed_at: now(), updated_at: now() } });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const data = await buildDashboard(req.query)();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message || "统计失败" });
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const [
      { data: sessions },
      { data: messages },
      { data: tickets },
      { data: replies },
      { data: ratings },
      { data: refunds },
      { data: gaps }
    ] = await Promise.all([
      supabase.from("sessions").select("*").limit(100),
      supabase.from("messages").select("*").limit(100),
      supabase.from("tickets").select("*").limit(100),
      supabase.from("ticket_replies").select("*").limit(100),
      supabase.from("ratings").select("*").limit(100),
      supabase.from("refunds").select("*").limit(100),
      supabase.from("knowledge_gaps").select("*").limit(100)
    ]);
    res.json({
      range: { from: req.query.from || "", to: req.query.to || "", generatedAt: now() },
      sessions: pick(sessions || [], ["id", "status", "resolved", "ticket_id", "created_at", "updated_at"], req.query),
      messages: pick(messages || [], ["id", "session_id", "role", "content", "intent", "confidence", "action", "source", "risk_level", "created_at"], req.query),
      tickets: pick(tickets || [], ["id", "session_id", "intent", "handoff_reason", "priority", "status", "summary", "created_at", "updated_at"], req.query),
      replies: pick(replies || [], ["id", "ticket_id", "session_id", "content", "created_at"], req.query),
      ratings: pick(ratings || [], ["id", "session_id", "resolved", "score", "comment", "created_at"], req.query),
      refunds: pick(refunds || [], ["id", "session_id", "order_no", "reason", "status", "created_at", "updated_at"], req.query),
      knowledgeGaps: pick(gaps || [], ["id", "question", "count", "status", "created_at", "updated_at"], req.query)
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "导出失败" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: COZE_TOKEN && COZE_BOT_ID ? "coze" : "local-simulator",
    db: supabaseUrl ? "supabase" : "memory"
  });
});

app.listen(port, "127.0.0.1", () => console.log(`API ready at http://127.0.0.1:${port}`));
