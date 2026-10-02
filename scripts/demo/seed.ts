// Seeds a dataDir with fictional demo data (BookNhanh, an imaginary booking app, and its leads)
// for README screenshots. All addresses use the reserved .example TLD.
//
//   npx tsx scripts/demo/seed.ts <dataDir>      (wipes <dataDir> first)
//
// Usually run through `npm run demo:screenshots` (scripts/demo/screenshots.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../packages/db/src/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: tsx scripts/demo/seed.ts <dataDir>");
  process.exit(1);
}
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, "agyhq.db"));
const sql = db.sqlite;

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const setTimes = (table: string, id: string, cols: Record<string, string>) => {
  const sets = Object.keys(cols).map((c) => `${c} = @${c}`).join(", ");
  sql.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run({ ...cols, id });
};
const setTaskAudit = (taskId: string, minutesAgo: number) =>
  sql.prepare("UPDATE audit SET at = ? WHERE task_id = ?").run(at(minutesAgo), taskId);

const template = JSON.parse(fs.readFileSync(path.join(REPO, "templates/sales-sdr/template.json"), "utf8"));
const agent = db.agents.create({
  id: "mai",
  role: "sales-sdr",
  displayName: "Mai",
  model: template.defaultModel,
  workspacePath: path.join(dataDir, "workspaces", "mai"),
  policy: template.policy,
  trustTier: "autonomous",
});
db.settings.patch({ outboundEnabled: true, outboundDisabledReason: null, defaultSdrAgentId: agent.id });

const OWNER = "owner";
const MAI_SIG = "\n\nMai\nTư vấn viên BookNhanh\nbooknhanh.example";

interface Thread {
  name: string;
  email: string;
  title: string;
  company: string;
  domain: string;
}

function contact(t: Thread, extra: Record<string, unknown> = {}) {
  return db.crm.upsertContact({
    email: t.email,
    name: t.name,
    title: t.title,
    language: "vi",
    source: "outbound",
    ownerAgentId: agent.id,
    companyName: t.company,
    companyDomain: t.domain,
    attributes: extra,
  }).contact;
}

function doneTask(input: {
  kind: string;
  title: string;
  threadKey: string;
  taskInput: Record<string, unknown>;
  summary: string;
  data?: Record<string, unknown>;
  startedMinAgo: number;
  durationMin: number;
  priority?: number;
}) {
  const task = db.tasks.create({
    agentId: agent.id,
    kind: input.kind,
    title: input.title,
    input: input.taskInput,
    threadKey: input.threadKey,
    priority: input.priority ?? 0,
  });
  db.tasks.transition(task.id, "running");
  db.tasks.transition(task.id, "done", {
    result: { status: "done", summary: input.summary, data: input.data ?? {} } as never,
  });
  setTimes("tasks", task.id, { created_at: at(input.startedMinAgo), updated_at: at(input.startedMinAgo - input.durationMin) });
  setTaskAudit(task.id, input.startedMinAgo - input.durationMin);
  return task;
}

function sentEmail(input: {
  taskId: string;
  to: string;
  subject: string;
  body: string;
  reason: string;
  threadKey: string;
  createdMinAgo: number;
  decidedBy: string;
  inReplyTo?: string;
}) {
  const item = db.outbox.createDraft({
    agentId: agent.id,
    taskId: input.taskId,
    channel: "email",
    to: input.to,
    subject: input.subject,
    body: input.body,
    reason: input.reason,
    threadKey: input.threadKey,
    lint: [],
  });
  const decidedAt = at(input.createdMinAgo - 1);
  const sentAt = at(input.createdMinAgo - 2);
  db.outbox.decide(item.id, "approved", { decidedBy: input.decidedBy, decidedAt });
  db.outbox.decide(item.id, "sending");
  db.outbox.decide(item.id, "sent", {
    sentAt,
    messageId: `<${item.id}@booknhanh.example>`,
    inReplyTo: input.inReplyTo ?? null,
  });
  setTimes("outbox", item.id, { created_at: at(input.createdMinAgo), updated_at: sentAt });
  return item;
}

function inboundReply(input: {
  t: Thread;
  contactId: string;
  subject: string;
  body: string;
  threadKey: string;
  minAgo: number;
  classification?: "reply" | "unsubscribe" | "auto_reply" | "bounce" | "new_lead";
  source?: "email" | "webhook";
  fromAddress?: string;
  fromName?: string;
  payload?: Record<string, unknown>;
}) {
  const { event } = db.inbound.insertIfNew({
    source: input.source ?? "email",
    externalId: `demo-${input.t.email}-${input.minAgo}`,
    fromAddress: input.fromAddress ?? input.t.email,
    fromName: input.fromName ?? input.t.name,
    toAddress: "mai@booknhanh.example",
    subject: input.subject,
    bodyText: input.body,
    messageId: `<demo-${input.minAgo}@${input.t.domain}>`,
    threadKey: input.threadKey,
    contactId: input.contactId,
    classification: input.classification ?? "reply",
    payload: input.payload ?? {},
    receivedAt: at(input.minAgo),
  });
  setTimes("inbound_events", event.id, { received_at: at(input.minAgo), created_at: at(input.minAgo) });
  return event;
}

// ---------------------------------------------------------------------------
// Thread 1 (hero): Spa Hoa Sen asks about Zalo reminders + price → Mai replies and it is sent automatically.
{
  const t: Thread = { name: "Trần Thu Hà", email: "thuha@spahoasen.example", title: "Chủ spa", company: "Spa Hoa Sen", domain: "spahoasen.example" };
  const c = contact(t);
  const threadKey = `contact:${t.email}`;
  const subject = "Spa Hoa Sen có đang mất khách vì quên lịch hẹn?";

  const research = doneTask({
    kind: "sdr.research_lead",
    title: `Research ${t.name}`,
    threadKey,
    taskInput: { contactName: t.name, contactEmail: t.email, leadCompanyName: t.company, leadCompanyDomain: t.domain },
    summary: "Spa 2 chi nhánh ở Q.3 và Q.7, nhận đặt lịch qua Facebook/Zalo thủ công. Phù hợp ICP (BANT-lite 3/4).",
    data: { bantScore: 3, stage: "qualified" },
    startedMinAgo: 3 * 1440 + 60,
    durationMin: 2,
  });
  const firstTouch = doneTask({
    kind: "sdr.first_touch",
    title: `First touch ${t.name}`,
    threadKey,
    taskInput: { contactEmail: t.email, researchTaskId: research.id },
    summary: "Đã soạn email chào hàng nhắm vào nỗi đau khách quên lịch hẹn.",
    startedMinAgo: 3 * 1440 + 55,
    durationMin: 1,
  });
  const first = sentEmail({
    taskId: firstTouch.id,
    to: t.email,
    subject,
    body:
      "Chào chị Hà,\n\nEm thấy Spa Hoa Sen đang nhận đặt lịch qua Facebook và Zalo ở cả hai chi nhánh. Nhiều spa bên em làm việc cùng hay gặp chuyện khách đặt rồi quên, đến giờ thì ghế trống.\n\nBookNhanh tự nhắn nhắc lịch cho khách trước giờ hẹn và gom lịch của các chi nhánh vào một chỗ. Chị có muốn em gửi chị xem thử cách nó chạy trong 15 phút không ạ?" +
      MAI_SIG,
    reason: "First touch: lead phù hợp ICP (spa nhiều chi nhánh, đặt lịch thủ công).",
    threadKey,
    createdMinAgo: 3 * 1440 + 54,
    decidedBy: OWNER,
  });

  const reply = inboundReply({
    t,
    contactId: c.id,
    subject: `Re: ${subject}`,
    body:
      "Chào em Mai,\n\nBên chị có 2 chi nhánh, mỗi tháng tầm 600 lượt hẹn, khách quên lịch nhiều lắm. Phần mềm bên em có nhắc lịch qua Zalo được không? Giá cho 2 chi nhánh thế nào em?\n\nThu Hà\nSpa Hoa Sen",
    threadKey,
    minAgo: 12,
  });
  const handle = doneTask({
    kind: "sdr.handle_reply",
    title: `Reply from ${t.name}`,
    threadKey,
    priority: 10,
    taskInput: {
      contactName: t.name,
      contactEmail: t.email,
      subject: `Re: ${subject}`,
      replyBody: reply.bodyText,
      inboundEventId: reply.id,
    },
    summary: "Khách quan tâm (2 chi nhánh, ~600 lượt hẹn/tháng). Đã trả lời về nhắc lịch qua Zalo, báo giá gói Chuỗi theo bảng giá và mời demo 15 phút.",
    data: { intent: "interested_asks_price", stage: "qualified" },
    startedMinAgo: 11,
    durationMin: 1,
  });
  db.inbound.setStatus(reply.id, "routed", { routedTaskId: handle.id, contactId: c.id });
  sentEmail({
    taskId: handle.id,
    to: t.email,
    subject: `Re: ${subject}`,
    body:
      "Dạ em chào chị Hà,\n\nBên em có nhắc lịch qua Zalo chị nhé: khách nhận tin nhắc trước giờ hẹn 1 ngày và 2 tiếng, bấm xác nhận hoặc dời lịch ngay trong tin nhắn.\n\nVới 2 chi nhánh, ~600 lượt hẹn/tháng, gói phù hợp là gói Chuỗi: 790.000đ/tháng (chưa gồm VAT), tối đa 3 chi nhánh, không giới hạn lượt nhắc.\n\nChị muốn xem thử trên lịch của spa mình thì chọn giờ ở đây giúp em, chỉ 15 phút ạ: booknhanh.example/demo" +
      MAI_SIG,
    reason: "Khách hỏi nhắc lịch qua Zalo và giá cho 2 chi nhánh: trả lời theo KB sản phẩm + bảng giá, đề xuất demo 15 phút.",
    threadKey,
    createdMinAgo: 10,
    decidedBy: "policy:autonomous",
    inReplyTo: reply.messageId ?? undefined,
  });
  db.crm.setStage(c.id, "qualified", "Hỏi giá cho 2 chi nhánh, quan tâm nhắc lịch Zalo", agent.id);
  sql.prepare("UPDATE notes SET created_at = ? WHERE subject_id = ? AND body LIKE 'Stage changed%'").run(at(9), c.id);
  const note = db.crm.addNote("contact", c.id, "2 chi nhánh, ~600 lượt hẹn/tháng. Quan tâm nhắc lịch qua Zalo. Đã gửi giá gói Chuỗi + link demo.", agent.id);
  setTimes("notes", note.id, { created_at: at(9) });
  void first;
}

// Thread 2: dental clinic asks for a demo video → also answered automatically.
{
  const t: Thread = { name: "Lê Quốc Minh", email: "minh@nhakhoasmile.example", title: "Quản lý phòng khám", company: "Nha khoa Smile", domain: "nhakhoasmile.example" };
  const c = contact(t);
  const threadKey = `contact:${t.email}`;
  const subject = "Nhắc lịch tái khám tự động cho Nha khoa Smile";
  const ft = doneTask({
    kind: "sdr.first_touch",
    title: `First touch ${t.name}`,
    threadKey,
    taskInput: { contactEmail: t.email },
    summary: "Đã soạn email chào hàng về nhắc lịch tái khám.",
    startedMinAgo: 2 * 1440,
    durationMin: 1,
  });
  sentEmail({
    taskId: ft.id,
    to: t.email,
    subject,
    body: "Chào anh Minh,\n\nPhòng khám nha khoa thường có nhiều lịch tái khám định kỳ…" + MAI_SIG,
    reason: "First touch",
    threadKey,
    createdMinAgo: 2 * 1440 - 2,
    decidedBy: OWNER,
  });
  const reply = inboundReply({
    t,
    contactId: c.id,
    subject: `Re: ${subject}`,
    body: "Em gửi anh xem demo trước được không? Bên anh đang quản lý lịch bằng Excel.\n\nMinh",
    threadKey,
    minAgo: 38,
  });
  const handle = doneTask({
    kind: "sdr.handle_reply",
    title: `Reply from ${t.name}`,
    threadKey,
    priority: 10,
    taskInput: { contactName: t.name, contactEmail: t.email, replyBody: reply.bodyText, inboundEventId: reply.id },
    summary: "Khách muốn xem demo trước; đang dùng Excel. Đã gửi video demo 3 phút + mời đặt lịch.",
    startedMinAgo: 37,
    durationMin: 1,
  });
  db.inbound.setStatus(reply.id, "routed", { routedTaskId: handle.id, contactId: c.id });
  sentEmail({
    taskId: handle.id,
    to: t.email,
    subject: `Re: ${subject}`,
    body:
      "Dạ em chào anh Minh,\n\nEm gửi anh video demo 3 phút: booknhanh.example/video. Phần nhập lịch từ Excel nằm ở phút 1:20, anh tải file hiện tại lên là có lịch ngay ạ.\n\nNếu anh muốn em hướng dẫn trực tiếp thì anh chọn giờ ở đây giúp em: booknhanh.example/demo" +
      MAI_SIG,
    reason: "Khách xin demo và đang dùng Excel: gửi video demo, chỉ đúng đoạn nhập từ Excel, mời đặt lịch.",
    threadKey,
    createdMinAgo: 36,
    decidedBy: "policy:autonomous",
    inReplyTo: reply.messageId ?? undefined,
  });
  db.crm.setStage(c.id, "replied", "Xin demo", agent.id);
}

// Thread 3: unsubscribe — handled without any model call.
{
  const t: Thread = { name: "Phạm Ngọc Anh", email: "ngocanh@yogaxanh.example", title: "Chủ studio", company: "Yoga Xanh", domain: "yogaxanh.example" };
  const c = contact(t, { doNotContact: true });
  const ev = inboundReply({
    t,
    contactId: c.id,
    subject: "Re: Lịch học yoga kín chỗ, khách vẫn quên buổi?",
    body: "Cảm ơn em nhưng chị không có nhu cầu, đừng gửi email nữa nhé.",
    threadKey: `contact:${t.email}`,
    minAgo: 85,
    classification: "unsubscribe",
  });
  db.inbound.setStatus(ev.id, "routed", { contactId: c.id });
  db.crm.setStage(c.id, "disqualified", "Opted out", null);
}

// Thread 4: out-of-office auto reply — ignored.
{
  const t: Thread = { name: "Đỗ Văn Khoa", email: "khoa@barberhouse.example", title: "Chủ tiệm", company: "Barber House", domain: "barberhouse.example" };
  const c = contact(t);
  const ev = inboundReply({
    t,
    contactId: c.id,
    subject: "Trả lời tự động: Barber House kín lịch cuối tuần?",
    body: "Anh đang nghỉ phép đến 06/10, sẽ phản hồi khi quay lại.",
    threadKey: `contact:${t.email}`,
    minAgo: 140,
    classification: "auto_reply",
  });
  db.inbound.setStatus(ev.id, "ignored", { statusReason: "auto_reply", contactId: c.id });
}

// Thread 5: bounce.
{
  const t: Thread = { name: "Võ Thanh Tùng", email: "tung@tiemnail.example", title: "Chủ tiệm", company: "Tiệm Nail Tùng", domain: "tiemnail.example" };
  const c = contact(t, { emailBounced: true, doNotContact: true });
  const ev = inboundReply({
    t,
    contactId: c.id,
    subject: "Undelivered Mail Returned to Sender",
    body: "550 5.1.1 <tung@tiemnail.example>: Recipient address rejected: User unknown",
    threadKey: `contact:${t.email}`,
    minAgo: 300,
    classification: "bounce",
    fromAddress: "mailer-daemon@mail.example",
    fromName: "Mail Delivery System",
  });
  db.inbound.setStatus(ev.id, "routed", { contactId: c.id });
}

// Thread 6: new lead from the website form → researched → first touch waiting for the owner's approval.
{
  const t: Thread = { name: "Nguyễn Hải Yến", email: "haiyen@salonmay.example", title: "Chủ salon", company: "Salon Mây", domain: "salonmay.example" };
  const c = contact(t);
  const threadKey = `contact:${t.email}`;
  const ev = inboundReply({
    t,
    contactId: c.id,
    subject: "Form đăng ký dùng thử",
    body: "Salon tóc 1 chi nhánh, 4 thợ. Muốn khách tự đặt lịch online.",
    threadKey,
    minAgo: 190,
    classification: "new_lead",
    source: "webhook",
    payload: { source: "website-form" },
  });
  const research = doneTask({
    kind: "sdr.research_lead",
    title: `Research ${t.name}`,
    threadKey,
    taskInput: { contactName: t.name, contactEmail: t.email, leadCompanyName: t.company, context: ev.bodyText },
    summary: "Salon 1 chi nhánh, 4 thợ, đăng ký dùng thử từ form website. Phù hợp gói Cơ bản.",
    data: { bantScore: 3, stage: "qualified" },
    startedMinAgo: 189,
    durationMin: 2,
  });
  db.inbound.setStatus(ev.id, "routed", { routedTaskId: research.id, contactId: c.id });
  const ft = doneTask({
    kind: "sdr.first_touch",
    title: `First touch ${t.name}`,
    threadKey,
    taskInput: { contactEmail: t.email, researchTaskId: research.id },
    summary: "Đã soạn email chào mừng + hướng dẫn bật đặt lịch online.",
    startedMinAgo: 186,
    durationMin: 1,
  });
  const draft = db.outbox.createDraft({
    agentId: agent.id,
    taskId: ft.id,
    channel: "email",
    to: t.email,
    subject: "Salon Mây: bật đặt lịch online trong 10 phút",
    body:
      "Chào chị Yến,\n\nCảm ơn chị đã đăng ký dùng thử BookNhanh. Với salon 4 thợ, chị chỉ cần thêm tên thợ và giờ làm là khách đặt lịch online được ngay, lịch tự chia theo từng thợ.\n\nEm gửi chị hướng dẫn 3 bước: booknhanh.example/bat-dau. Chị cần em gọi hỗ trợ cài đặt thì trả lời email này giúp em nhé." +
      MAI_SIG,
    reason: "Lead mới từ form website, đã nghiên cứu: phù hợp gói Cơ bản. Email đầu tiên tới người nhận mới nên cần chủ duyệt.",
    threadKey,
    lint: [],
  });
  setTimes("outbox", draft.id, { created_at: at(185), updated_at: at(185) });
  db.crm.setStage(c.id, "qualified", "Form dùng thử", agent.id);
}

// Older sent first-touch emails to fill the Sent tab.
const older: [string, string, string, string, number][] = [
  ["Hoàng Mỹ Linh", "mylinh@thammyvienlinh.example", "Thẩm mỹ viện Linh", "Thẩm mỹ viện Linh: giảm 30% lịch hẹn bị bỏ?", 1440 + 300],
  ["Bùi Đức Thắng", "thang@gymfit.example", "GymFit Q.1", "Lớp PT ở GymFit có hay bị huỷ sát giờ?", 1440 + 500],
  ["Trịnh Thảo Vy", "thaovy@petspa.example", "Pet Spa Mèo Mun", "Khách đặt lịch tắm cho bé cưng qua Zalo?", 2 * 1440 + 200],
];
for (const [name, email, company, subject, minAgo] of older) {
  const t: Thread = { name, email, title: "Chủ cơ sở", company, domain: email.split("@")[1]! };
  contact(t);
  const threadKey = `contact:${email}`;
  const ft = doneTask({ kind: "sdr.first_touch", title: `First touch ${name}`, threadKey, taskInput: { contactEmail: email }, summary: "Đã soạn email chào hàng.", startedMinAgo: minAgo + 2, durationMin: 1 });
  sentEmail({ taskId: ft.id, to: email, subject, body: `Chào ${name.split(" ").pop()},\n\n…` + MAI_SIG, reason: "First touch", threadKey, createdMinAgo: minAgo, decidedBy: OWNER });
  db.crm.setStage(db.crm.findContacts({ email })[0]!.id, "contacted", "First touch sent", agent.id);
}

console.log("seeded", dataDir);
