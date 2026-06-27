-- 言析智能客服 - Supabase 初始化脚本
-- 由 supabase db push 推送执行
-- 字段结构对照 cloudfunctions/customer-service-api/index.js 中的实际写入数据

-- 启用 UUID 扩展（如后端用 gen_random_uuid() 生成主键）
create extension if not exists "pgcrypto";

-- 清理可能因之前报错而部分创建的表，确保重建
drop table if exists public.ticket_replies cascade;
drop table if exists public.knowledge_gaps cascade;
drop table if exists public.refunds cascade;
drop table if exists public.ratings cascade;
drop table if exists public.tickets cascade;
drop table if exists public.messages cascade;
drop table if exists public.sessions cascade;
drop table if exists public.orders cascade;

-- ============================================================
-- 1. orders 订单表（对应 C.orders 集合）
-- ============================================================
create table public.orders (
  id           text primary key,                          -- OD20260620001
  product      text not null default '',
  amount       integer not null default 0,
  status       text not null default '',
  logistics    text not null default '',
  refund       text not null default '',
  refundable   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- 2. sessions 会话表（对应 C.sessions 集合）
-- ============================================================
create table public.sessions (
  id                  text primary key,                   -- CSxxxx 或 DEMO_SESSION_xx
  user_id             text not null default '',
  coze_conversation_id text not null default '',
  status              text not null default 'active',     -- active/waiting_agent/processing/closed
  resolved            boolean,
  ticket_id           text not null default '',
  pending_chat_id     text not null default '',
  pending_message     text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_sessions_created_at on public.sessions (created_at desc);
create index if not exists idx_sessions_status on public.sessions (status);

-- ============================================================
-- 3. messages 消息表（对应 C.messages 集合）
-- ============================================================
create table public.messages (
  id          text primary key,
  session_id  text not null,
  role        text not null,                              -- user/assistant/agent/system
  content     text not null default '',
  intent      text not null default '',
  confidence  double precision,
  action      text not null default '',
  source      text not null default '',
  risk_level  text not null default '',                   -- low/medium/high
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_session_id on public.messages (session_id, created_at asc);
create index if not exists idx_messages_role on public.messages (role);
create index if not exists idx_messages_created_at on public.messages (created_at desc);

-- ============================================================
-- 4. tickets 人工工单表（对应 C.tickets 集合）
-- ============================================================
create table public.tickets (
  id              text primary key,                       -- TKxxxx 或 DEMO_TICKET_xx
  session_id      text not null,
  intent          text not null default '',
  confidence      double precision,
  summary         text not null default '',
  handoff_reason  text not null default '',
  priority        text not null default 'normal',         -- normal/high
  status          text not null default 'open',           -- open/processing/closed
  agent           text not null default '',
  claimed_at      timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_tickets_status on public.tickets (status);
create index if not exists idx_tickets_created_at on public.tickets (created_at desc);
create index if not exists idx_tickets_session_id on public.tickets (session_id);

-- ============================================================
-- 5. ticket_replies 人工回复表（对应 C.replies 集合）
-- ============================================================
create table public.ticket_replies (
  id          text primary key,
  ticket_id   text not null,
  session_id  text not null,
  content     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_replies_ticket_id on public.ticket_replies (ticket_id);

-- ============================================================
-- 6. ratings 服务评价表（对应 C.ratings 集合）
-- ============================================================
create table public.ratings (
  id          text primary key,                           -- RTxxxx 或 DEMO_RATING_xx
  session_id  text not null,
  score       integer not null check (score between 1 and 5),
  resolved    boolean not null default false,
  comment     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_ratings_session_id on public.ratings (session_id);
create index if not exists idx_ratings_created_at on public.ratings (created_at desc);

-- ============================================================
-- 7. refunds 退款表（对应 C.refunds 集合）
-- ============================================================
create table if not exists public.refunds (
  id          text primary key,                           -- RFxxxx 或 DEMO_REFUND_xx
  session_id  text not null,
  order_no    text not null,
  reason      text not null default '',
  status      text not null default '待审核',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_refunds_session_id on public.refunds (session_id);
create index if not exists idx_refunds_order_no on public.refunds (order_no);

-- ============================================================
-- 8. knowledge_gaps 知识缺口表（对应 C.gaps 集合）
-- ============================================================
create table public.knowledge_gaps (
  id          text primary key,                           -- GAP_xxxx 或 DEMO_GAP_xx
  question    text not null,
  count       integer not null default 1,
  status      text not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_gaps_count on public.knowledge_gaps (count desc);

-- ============================================================
-- 种子数据：3 条订单（对应云函数 seed action）
-- ============================================================
insert into public.orders (id, product, amount, status, logistics, refund, refundable, created_at, updated_at)
values
  ('OD20260620001', 'Aurora 降噪耳机', 699, '运输中', '已到达上海浦东分拨中心，预计明日送达', '', true, now(), now()),
  ('OD20260618008', 'Luma 阅读灯', 239, '退款处理中', '', '退款审核已通过，预计 1–3 个工作日原路到账', false, now(), now()),
  ('OD20260612021', 'Mori 随行杯', 129, '已签收', '6 月 15 日由本人签收', '', true, now(), now())
on conflict (id) do nothing;

-- ============================================================
-- 种子数据：12 条作品集演示数据（对应云函数 seedDemoData action）
-- 用静态时间戳避免每次重跑数据漂移；演示用，可选清理
-- ============================================================
insert into public.sessions (id, user_id, coze_conversation_id, status, resolved, ticket_id, pending_chat_id, pending_message, created_at, updated_at)
values
  ('DEMO_SESSION_01', 'demo_user_01', '', 'closed', true,  '', '', '', '2026-06-15 00:30:00+08', '2026-06-15 01:00:00+08'),
  ('DEMO_SESSION_02', 'demo_user_02', '', 'closed', true,  '', '', '', '2026-06-16 00:30:00+08', '2026-06-16 01:00:00+08'),
  ('DEMO_SESSION_03', 'demo_user_03', '', 'closed', true,  '', '', '', '2026-06-17 00:30:00+08', '2026-06-17 01:00:00+08'),
  ('DEMO_SESSION_04', 'demo_user_04', '', 'closed', true,  '', '', '', '2026-06-18 00:30:00+08', '2026-06-18 01:00:00+08'),
  ('DEMO_SESSION_05', 'demo_user_05', '', 'closed', true,  '', '', '', '2026-06-19 00:30:00+08', '2026-06-19 01:00:00+08'),
  ('DEMO_SESSION_06', 'demo_user_06', '', 'closed', true,  '', '', '', '2026-06-20 00:30:00+08', '2026-06-20 01:00:00+08'),
  ('DEMO_SESSION_07', 'demo_user_07', '', 'closed', null,  '', '', '', '2026-06-21 00:30:00+08', '2026-06-21 01:00:00+08'),
  ('DEMO_SESSION_08', 'demo_user_08', '', 'closed', true,  'DEMO_TICKET_08', '', '', '2026-06-22 00:30:00+08', '2026-06-22 01:00:00+08'),
  ('DEMO_SESSION_09', 'demo_user_09', '', 'closed', true,  'DEMO_TICKET_09', '', '', '2026-06-23 00:30:00+08', '2026-06-23 01:00:00+08'),
  ('DEMO_SESSION_10', 'demo_user_10', '', 'processing', false, 'DEMO_TICKET_10', '', '', '2026-06-24 00:30:00+08', '2026-06-24 01:00:00+08'),
  ('DEMO_SESSION_11', 'demo_user_11', '', 'closed', true,  '', '', '', '2026-06-25 00:30:00+08', '2026-06-25 01:00:00+08'),
  ('DEMO_SESSION_12', 'demo_user_12', '', 'closed', true,  '', '', '', '2026-06-26 00:30:00+08', '2026-06-26 01:00:00+08')
on conflict (id) do nothing;

-- 12 组消息（每组 3 条：欢迎语 + 用户问题 + AI 回答）
-- 用单条 insert 写入，session_id 与上表对齐
insert into public.messages (id, session_id, role, content, intent, confidence, action, source, risk_level, created_at)
values
  ('11111111-0001-01-a-000', 'DEMO_SESSION_01', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low',  '2026-06-15 00:31:00+08'),
  ('11111111-0001-01-u-001', 'DEMO_SESSION_01', 'user', '商品签收后几天可以申请无理由退货？', '', null, '', '', '', '2026-06-15 00:32:00+08'),
  ('11111111-0001-01-a-002', 'DEMO_SESSION_01', 'assistant', '符合条件的商品在签收后 7 天内可以申请无理由退货。', '商品与政策咨询', 0.91, 'search_knowledge', '言析电商售后知识库', 'low', '2026-06-15 00:33:00+08'),

  ('11111111-0002-02-a-000', 'DEMO_SESSION_02', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-16 00:31:00+08'),
  ('11111111-0002-02-u-001', 'DEMO_SESSION_02', 'user', '订单 OD20260620001 到哪里了？', '', null, '', '', '', '2026-06-16 00:32:00+08'),
  ('11111111-0002-02-a-002', 'DEMO_SESSION_02', 'assistant', '订单已到达上海浦东分拨中心，预计明日送达。', '物流查询', 0.94, 'query_order', '订单系统', 'low', '2026-06-16 00:33:00+08'),

  ('11111111-0003-03-a-000', 'DEMO_SESSION_03', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-17 00:31:00+08'),
  ('11111111-0003-03-u-001', 'DEMO_SESSION_03', 'user', '订单 OD20260618008 退款什么时候到账？', '', null, '', '', '', '2026-06-17 00:32:00+08'),
  ('11111111-0003-03-a-002', 'DEMO_SESSION_03', 'assistant', '退款审核已通过，预计 1–3 个工作日原路到账。', '退款进度', 0.93, 'query_refund', '退款系统', 'medium', '2026-06-17 00:33:00+08'),

  ('11111111-0004-04-a-000', 'DEMO_SESSION_04', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-18 00:31:00+08'),
  ('11111111-0004-04-u-001', 'DEMO_SESSION_04', 'user', '我要给订单 OD20260612021 申请退款', '', null, '', '', '', '2026-06-18 00:32:00+08'),
  ('11111111-0004-04-a-002', 'DEMO_SESSION_04', 'assistant', '已为你展示退款申请表，请确认原因后提交。', '退款申请', 0.91, 'show_refund_form', '售后规则', 'medium', '2026-06-18 00:33:00+08'),

  ('11111111-0005-05-a-000', 'DEMO_SESSION_05', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-19 00:31:00+08'),
  ('11111111-0005-05-u-001', 'DEMO_SESSION_05', 'user', '收到的商品破损怎么处理？', '', null, '', '', '', '2026-06-19 00:32:00+08'),
  ('11111111-0005-05-a-002', 'DEMO_SESSION_05', 'assistant', '请提交订单号、商品整体及破损位置照片，我们会协助申请售后。', '商品与政策咨询', 0.91, 'search_knowledge', '言析电商售后知识库', 'low', '2026-06-19 00:33:00+08'),

  ('11111111-0006-06-a-000', 'DEMO_SESSION_06', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-20 00:31:00+08'),
  ('11111111-0006-06-u-001', 'DEMO_SESSION_06', 'user', '发票丢了还能申请售后吗？', '', null, '', '', '', '2026-06-20 00:32:00+08'),
  ('11111111-0006-06-a-002', 'DEMO_SESSION_06', 'assistant', '可以先提供订单记录，具体材料要求以售后审核结果为准。', '商品与政策咨询', 0.91, 'search_knowledge', '言析电商售后知识库', 'low', '2026-06-20 00:33:00+08'),

  ('11111111-0007-07-a-000', 'DEMO_SESSION_07', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-21 00:31:00+08'),
  ('11111111-0007-07-u-001', 'DEMO_SESSION_07', 'user', '帮我查物流，但我暂时找不到订单号', '', null, '', '', '', '2026-06-21 00:32:00+08'),
  ('11111111-0007-07-a-002', 'DEMO_SESSION_07', 'assistant', '请提供完整订单号，格式类似 OD20260620001。', '物流查询', 0.94, 'query_order', '订单系统', 'low', '2026-06-21 00:33:00+08'),

  ('11111111-0008-08-a-000', 'DEMO_SESSION_08', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-22 00:31:00+08'),
  ('11111111-0008-08-u-001', 'DEMO_SESSION_08', 'user', '退款金额不对，我要投诉并转人工', '', null, '', '', '', '2026-06-22 00:32:00+08'),
  ('11111111-0008-08-a-002', 'DEMO_SESSION_08', 'assistant', '已创建高优先级人工工单，客服会核对支付与退款流水。', '投诉与人工服务', 0.96, 'create_ticket', '风险策略', 'high', '2026-06-22 00:33:00+08'),

  ('11111111-0009-09-a-000', 'DEMO_SESSION_09', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-23 00:31:00+08'),
  ('11111111-0009-09-u-001', 'DEMO_SESSION_09', 'user', '会员生日礼物怎么领取？', '', null, '', '', '', '2026-06-23 00:32:00+08'),
  ('11111111-0009-09-a-002', 'DEMO_SESSION_09', 'assistant', '该问题已记录为知识缺口并转交人工客服。', '未知问题', 0.38, 'create_ticket', '风险策略', 'medium', '2026-06-23 00:33:00+08'),

  ('11111111-0010-10-a-000', 'DEMO_SESSION_10', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-24 00:31:00+08'),
  ('11111111-0010-10-u-001', 'DEMO_SESSION_10', 'user', '下单后怎么修改收货地址？', '', null, '', '', '', '2026-06-24 00:32:00+08'),
  ('11111111-0010-10-a-002', 'DEMO_SESSION_10', 'assistant', '该问题需要人工核实订单状态，已为你创建工单。', '未知问题', 0.38, 'create_ticket', '风险策略', 'medium', '2026-06-24 00:33:00+08'),

  ('11111111-0011-11-a-000', 'DEMO_SESSION_11', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-25 00:31:00+08'),
  ('11111111-0011-11-u-001', 'DEMO_SESSION_11', 'user', '订单 OD20260699999 到哪了？', '', null, '', '', '', '2026-06-25 00:32:00+08'),
  ('11111111-0011-11-a-002', 'DEMO_SESSION_11', 'assistant', '没有查到该订单，请检查订单号是否完整。', '物流查询', 0.94, 'query_order', '订单系统', 'low', '2026-06-25 00:33:00+08'),

  ('11111111-0012-12-a-000', 'DEMO_SESSION_12', 'assistant', '你好，我是言析售后助手，请描述你的售后问题。', '欢迎语', 1.0, 'answer', '系统预设', 'low', '2026-06-26 00:31:00+08'),
  ('11111111-0012-12-u-001', 'DEMO_SESSION_12', 'user', '虚拟商品支持七天无理由退货吗？', '', null, '', '', '', '2026-06-26 00:32:00+08'),
  ('11111111-0012-12-a-002', 'DEMO_SESSION_12', 'assistant', '虚拟商品不适用七天无理由退货。', '商品与政策咨询', 0.91, 'search_knowledge', '言析电商售后知识库', 'low', '2026-06-26 00:33:00+08')
on conflict (id) do nothing;

-- 11 条评价（DEMO_SESSION_07 没有评价）
insert into public.ratings (id, session_id, score, resolved, comment, created_at)
values
  ('DEMO_RATING_01', 'DEMO_SESSION_01', 5, true, '回复清楚，处理及时', '2026-06-15 01:00:00+08'),
  ('DEMO_RATING_02', 'DEMO_SESSION_02', 5, true, '回复清楚，处理及时', '2026-06-16 01:00:00+08'),
  ('DEMO_RATING_03', 'DEMO_SESSION_03', 4, true, '回复清楚，处理及时', '2026-06-17 01:00:00+08'),
  ('DEMO_RATING_04', 'DEMO_SESSION_04', 5, true, '回复清楚，处理及时', '2026-06-18 01:00:00+08'),
  ('DEMO_RATING_05', 'DEMO_SESSION_05', 4, true, '回复清楚，处理及时', '2026-06-19 01:00:00+08'),
  ('DEMO_RATING_06', 'DEMO_SESSION_06', 5, true, '回复清楚，处理及时', '2026-06-20 01:00:00+08'),
  ('DEMO_RATING_08', 'DEMO_SESSION_08', 4, true, '回复清楚，处理及时', '2026-06-22 01:00:00+08'),
  ('DEMO_RATING_09', 'DEMO_SESSION_09', 3, true, '已转人工，希望补充知识库', '2026-06-23 01:00:00+08'),
  ('DEMO_RATING_10', 'DEMO_SESSION_10', 2, false, '等待人工进一步处理', '2026-06-24 01:00:00+08'),
  ('DEMO_RATING_11', 'DEMO_SESSION_11', 4, true, '回复清楚，处理及时', '2026-06-25 01:00:00+08'),
  ('DEMO_RATING_12', 'DEMO_SESSION_12', 5, true, '回复清楚，处理及时', '2026-06-26 01:00:00+08')
on conflict (id) do nothing;

-- 3 条工单（DEMO_SESSION_08/09/10）
insert into public.tickets (id, session_id, intent, confidence, summary, handoff_reason, priority, status, agent, claimed_at, closed_at, created_at, updated_at)
values
  ('DEMO_TICKET_08', 'DEMO_SESSION_08', '投诉与人工服务', 0.96, '用户问题：退款金额不对，我要投诉并转人工。AI 判断为“投诉与人工服务”，建议人工核实并给出明确方案。', '用户投诉并涉及退款金额争议', 'high', 'closed', '演示客服', '2026-06-22 00:35:00+08', '2026-06-22 01:00:00+08', '2026-06-22 00:33:00+08', '2026-06-22 01:00:00+08'),
  ('DEMO_TICKET_09', 'DEMO_SESSION_09', '未知问题', 0.38, '用户问题：会员生日礼物怎么领取？。AI 判断为“未知问题”，建议人工核实并给出明确方案。', '知识库暂无可靠答案', 'normal', 'closed', '演示客服', '2026-06-23 00:35:00+08', '2026-06-23 01:00:00+08', '2026-06-23 00:33:00+08', '2026-06-23 01:00:00+08'),
  ('DEMO_TICKET_10', 'DEMO_SESSION_10', '未知问题', 0.38, '用户问题：下单后怎么修改收货地址？。AI 判断为“未知问题”，建议人工核实并给出明确方案。', '知识库暂无可靠答案', 'normal', 'processing', '演示客服', '2026-06-24 00:35:00+08', null, '2026-06-24 00:33:00+08', '2026-06-24 01:00:00+08')
on conflict (id) do nothing;

-- 2 条人工回复（DEMO_TICKET_08/09 已关闭）
insert into public.ticket_replies (id, ticket_id, session_id, content, created_at)
values
  ('22222222-0008-reply-001', 'DEMO_TICKET_08', 'DEMO_SESSION_08', '已核对退款流水并向用户说明差额原因。', '2026-06-22 00:50:00+08'),
  ('22222222-0009-reply-001', 'DEMO_TICKET_09', 'DEMO_SESSION_09', '已告知生日礼遇规则，并建议补充知识库。', '2026-06-23 00:50:00+08')
on conflict (id) do nothing;

-- 1 条退款（DEMO_SESSION_04 提交）
insert into public.refunds (id, session_id, order_no, reason, status, created_at, updated_at)
values
  ('DEMO_REFUND_01', 'DEMO_SESSION_04', 'OD20260612021', '商品不合适', '审核通过', '2026-06-18 02:00:00+08', '2026-06-19 02:00:00+08')
on conflict (id) do nothing;

-- 2 条知识缺口
insert into public.knowledge_gaps (id, question, count, status, created_at, updated_at)
values
  ('DEMO_GAP_01', '会员生日礼物怎么领取？', 3, 'open', '2026-06-23 00:33:00+08', '2026-06-26 00:00:00+08'),
  ('DEMO_GAP_02', '下单后怎么修改收货地址？', 2, 'open', '2026-06-24 00:33:00+08', '2026-06-26 00:00:00+08')
on conflict (id) do nothing;

-- ============================================================
-- 结束
-- 验证：select count(*) from sessions;  -- 应返回 12
--       select count(*) from messages;  -- 应返回 36
--       select count(*) from ratings;   -- 应返回 11
--       select count(*) from tickets;   -- 应返回 3
--       select count(*) from ticket_replies; -- 应返回 2
--       select count(*) from refunds;   -- 应返回 1
--       select count(*) from knowledge_gaps; -- 应返回 2
--       select count(*) from orders;    -- 应返回 3
-- ============================================================
