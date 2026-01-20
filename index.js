require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const crypto = require("crypto");

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || "Asia/Ho_Chi_Minh";
dayjs.tz.setDefault(TZ);

const { db, setSetting, getSetting } = require("./db");
const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMINS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const TICK_SECONDS = Math.max(5, Number(process.env.TICK_SECONDS || 30));
const START_LINK = process.env.START_LINK || "";

// ---------------- helpers ----------------
function isAdmin(userId) {
  return ADMINS.includes(userId);
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmacSha256Hex(key, msg) {
  return crypto.createHmac("sha256", key).update(msg).digest("hex");
}

function fmtUnix(unixTs) {
  return dayjs.unix(unixTs).tz(TZ).format("HH:mm DD/MM/YYYY");
}

function makeSeed() {
  return crypto.randomBytes(32).toString("hex");
}

/** Provably-fair: rank = HMAC_SHA256(seed, `${gid}:${user_id}`), sort asc, take top k */
function pickWinnersDeterministic(seed, gid, participants, k) {
  const ranked = participants.map(p => ({
    ...p,
    rank: hmacSha256Hex(seed, `${gid}:${p.user_id}`)
  }));

  ranked.sort((a, b) => {
    const c = a.rank.localeCompare(b.rank);
    if (c !== 0) return c;
    return a.user_id - b.user_id;
  });

  return ranked.slice(0, Math.min(k, ranked.length));
}

async function isGroupMember(ctx, chatId, userId) {
  try {
    const m = await ctx.telegram.getChatMember(chatId, userId);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch {
    return false;
  }
}

function getDefaultGroupId() {
  const v = getSetting("default_group_id");
  return v ? Number(v) : null;
}

// Telegram sometimes sends /cmd@BotName
function getCmd(ctx) {
  const t = (ctx.message?.text || "").trim();
  const first = t.split(/\s+/)[0] || "";
  return first.replace(/@\w+$/, "");
}

// ---------------- Text builders ----------------

// GROUP: giveaway post (NO commit/seed/verify)
function buildGiveawayTextPublic({ prize, sponsor, winners, end_time }, count) {
  return (
    `🎉 <b>GIVEAWAY</b> 🎉\n\n` +
    `📌 <b>Nội dung:</b> ${escHtml(prize)}\n` +
    `🤝 <b>Nhà tài trợ:</b> ${escHtml(sponsor)}\n` +
    `⏰ <b>Thời gian quay:</b> ${fmtUnix(end_time)}\n` +
    `🏆 <b>Số người trúng:</b> ${winners}\n` +
    `👥 <b>Số người tham gia:</b> ${count}\n\n` +
    `👇 Nhấn nút bên dưới để tham gia!`
  );
}

// GROUP: winners announce (NO commit/seed/verify)
function buildWinnersTextPublic(g, winners) {
  let text = `🎉 <b>CHÚC MỪNG NGƯỜI CHIẾN THẮNG!</b> 🎉\n\n🏆 <b>Danh sách:</b>\n`;
  winners.forEach((w, i) => {
    text += `${i + 1}. ${escHtml(w.name)} (${w.user_id})\n`;
  });

  text +=
    `\n🎁 <b>Phần thưởng:</b> ${escHtml(g.prize)}\n` +
    `🤝 <b>Nhà tài trợ:</b> ${escHtml(g.sponsor)}\n\n` +
    `📩 Vui lòng liên hệ nhà tài trợ để nhận quà.`;

  return text;
}

// GROUP: canceled post (NO commit/seed/verify)
function buildCanceledTextPublic(g, count) {
  return (
    `⛔ <b>GIVEAWAY ĐÃ BỊ HỦY</b>\n\n` +
    `📌 <b>Nội dung:</b> ${escHtml(g.prize)}\n` +
    `🤝 <b>Nhà tài trợ:</b> ${escHtml(g.sponsor)}\n` +
    `👥 <b>Đã tham gia:</b> ${count}\n` +
    `📝 <b>Lý do:</b> ${escHtml(g.cancel_reason || "Không có")}\n`
  );
}

// DM: proof only
function buildProofText(g) {
  return (
    `🔒 <b>PROOF (chỉ DM)</b>\n\n` +
    `#${g.id}\n` +
    `🎁 <b>Phần thưởng:</b> ${escHtml(g.prize)}\n` +
    `🤝 <b>Nhà tài trợ:</b> ${escHtml(g.sponsor)}\n` +
    `⏰ <b>Quay lúc:</b> ${fmtUnix(g.end_time)}\n\n` +
    `🔒 <b>Commit:</b> <code>${escHtml(g.seed_hash || "N/A")}</code>\n` +
    `🔓 <b>Seed:</b> <code>${escHtml(g.ended && !g.canceled ? (g.seed || "N/A") : "Chưa công bố")}</code>\n\n` +
    `✅ <b>Verify:</b>\n` +
    `rank = HMAC_SHA256(seed, "&lt;id&gt;:&lt;user_id&gt;"), sort asc, lấy top N.`
  );
}

// ---------------- /giveaway parser (support | and ｜) ----------------
function parseGiveawayArgs(fullText) {
  const raw = fullText
    .replace(/^\/giveaway(@\w+)?\s*/i, "")
    .replace(/｜/g, "|")
    .replace(/\s*\|\s*/g, "|")
    .trim();

  const parts = raw.split("|");
  if (parts.length < 4) throw new Error("BAD_FORMAT");

  const winnersStr = (parts[0] || "").trim();
  const timeStr = (parts[1] || "").trim();
  const sponsor = (parts[parts.length - 1] || "").trim();
  const prize = parts.slice(2, parts.length - 1).join("|").trim();

  const winners = Number(winnersStr);
  if (!Number.isFinite(winners) || winners < 1) throw new Error("BAD_WINNERS");

  const end = dayjs(timeStr, "HH:mm DD/MM/YYYY", true).tz(TZ);
  if (!end.isValid()) throw new Error("BAD_TIME");
  if (!prize) throw new Error("BAD_PRIZE");
  if (!sponsor) throw new Error("BAD_SPONSOR");

  return { winners, endUnix: end.unix(), prize, sponsor };
}

function usageText() {
  return (
    "❌ Sai cú pháp\n" +
    "Dùng:\n" +
    "/giveaway <số_trúng>|<HH:mm DD/MM/YYYY>|<phần thưởng>|<nhà tài trợ>\n\n" +
    "Ví dụ:\n" +
    "/giveaway 3|22:00 20/01/2026|ADMIN CHATGPT BUSINESS 1 THÁNG|@zaaraowo\n\n" +
    "Hoặc dùng form:\n" +
    "/newgiveaway"
  );
}

// ---------------- Form state (in-memory) ----------------
const formState = new Map(); // userId -> { step, data, expectingCustomWinners }
function startForm(userId) {
  formState.set(userId, { step: 1, data: {}, expectingCustomWinners: false });
}
function stopForm(userId) {
  formState.delete(userId);
}
function getForm(userId) {
  return formState.get(userId);
}

function winnersKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1", "fw_w_1"), Markup.button.callback("2", "fw_w_2"), Markup.button.callback("3", "fw_w_3")],
    [Markup.button.callback("5", "fw_w_5"), Markup.button.callback("10", "fw_w_10"), Markup.button.callback("Nhập khác", "fw_w_custom")],
    [Markup.button.callback("❌ Hủy form", "fw_abort")]
  ]);
}
function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Tạo giveaway", "fw_confirm"), Markup.button.callback("❌ Hủy", "fw_abort")]
  ]);
}
function buildPreviewText(d) {
  return (
    "🧾 <b>PREVIEW GIVEAWAY</b>\n\n" +
    `🏆 <b>Số người trúng:</b> ${d.winners}\n` +
    `⏰ <b>Thời gian quay:</b> ${fmtUnix(d.endUnix)}\n` +
    `🎁 <b>Phần thưởng:</b> ${escHtml(d.prize)}\n` +
    `🤝 <b>Nhà tài trợ:</b> ${escHtml(d.sponsor)}\n\n` +
    "Chọn ✅ để tạo và đăng vào group."
  );
}

// ---------------- basic commands ----------------
bot.start(ctx => ctx.reply(`Welcome ${START_LINK}`.trim() || "Welcome!"));

// set group default (run in group)
bot.command("setgroup", ctx => {
  if (!isAdmin(ctx.from.id)) return;

  if (ctx.chat.type === "private") {
    return ctx.reply("Vào group muốn bot đăng giveaway và gõ: /setgroup");
  }

  setSetting("default_group_id", ctx.chat.id);
  ctx.reply(`✅ Đã set group mặc định: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" });
});

bot.command("group", ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const gid = getDefaultGroupId();
  ctx.reply(
    gid ? `📌 Group mặc định: <code>${gid}</code>` : "⚠️ Chưa set group. Vào group và gõ /setgroup",
    { parse_mode: "HTML" }
  );
});

// form create in DM
bot.command("newgiveaway", ctx => {
  if (!isAdmin(ctx.from.id)) return;
  if (ctx.chat.type !== "private") return ctx.reply("ℹ️ Dùng /newgiveaway trong chat riêng với bot.");

  const targetGroupId = getDefaultGroupId();
  if (!targetGroupId) return ctx.reply("⚠️ Chưa set group. Vào group gõ /setgroup");

  startForm(ctx.from.id);
  ctx.reply(
    "🧾 <b>Tạo Giveaway (Form)</b>\n\nBước 1/5: Chọn <b>số người trúng</b>",
    { parse_mode: "HTML", ...winnersKeyboard() }
  );
});

bot.command("abort", ctx => {
  if (!isAdmin(ctx.from.id)) return;
  stopForm(ctx.from.id);
  ctx.reply("✅ Đã hủy form.");
});

// form callbacks
bot.action(/^fw_w_(\d+)$/, async ctx => {
  const st = getForm(ctx.from.id);
  if (!st) return ctx.answerCbQuery("Form đã hết hạn.", { show_alert: true });

  st.data.winners = Number(ctx.match[1]);
  st.step = 2;
  st.expectingCustomWinners = false;

  await ctx.editMessageText(
    `Bước 2/5: Nhập <b>thời gian quay</b> theo format:\n<code>HH:mm DD/MM/YYYY</code>\nVí dụ: <code>22:00 20/01/2026</code>\n\nGõ /abort để hủy.`,
    { parse_mode: "HTML" }
  );
  ctx.answerCbQuery("OK");
});

bot.action("fw_w_custom", async ctx => {
  const st = getForm(ctx.from.id);
  if (!st) return ctx.answerCbQuery("Form đã hết hạn.", { show_alert: true });

  st.expectingCustomWinners = true;
  await ctx.editMessageText(
    "Nhập <b>số người trúng</b> (ví dụ: 7).\n\nGõ /abort để hủy.",
    { parse_mode: "HTML" }
  );
  ctx.answerCbQuery("Nhập số");
});

bot.action("fw_abort", async ctx => {
  stopForm(ctx.from.id);
  try { await ctx.editMessageText("✅ Đã hủy form."); } catch {}
  ctx.answerCbQuery("Đã hủy");
});

bot.action("fw_confirm", async ctx => {
  const st = getForm(ctx.from.id);
  if (!st) return ctx.answerCbQuery("Form đã hết hạn.", { show_alert: true });

  const targetGroupId = getDefaultGroupId();
  if (!targetGroupId) {
    stopForm(ctx.from.id);
    return ctx.answerCbQuery("Chưa set group (/setgroup).", { show_alert: true });
  }

  const { winners, endUnix, prize, sponsor } = st.data;
  if (!winners || !endUnix || !prize || !sponsor) {
    return ctx.answerCbQuery("Thiếu dữ liệu form.", { show_alert: true });
  }

  stopForm(ctx.from.id);
  await ctx.editMessageText("⏳ Đang tạo giveaway...");
  await createGiveawayAndPost(ctx, targetGroupId, winners, endUnix, prize, sponsor);
  ctx.answerCbQuery("Đã tạo");
});

// quick create (DM)
bot.command("giveaway", async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  if (ctx.chat.type !== "private") return ctx.reply("ℹ️ Tạo giveaway bằng DM hoặc dùng /newgiveaway.");

  const targetGroupId = getDefaultGroupId();
  if (!targetGroupId) return ctx.reply("⚠️ Chưa set group. Vào group gõ /setgroup");

  let args;
  try { args = parseGiveawayArgs(ctx.message.text); }
  catch { return ctx.reply(usageText()); }

  await createGiveawayAndPost(ctx, targetGroupId, args.winners, args.endUnix, args.prize, args.sponsor);
});

// form text input (DM)
bot.on("text", async (ctx, next) => {
  const st = getForm(ctx.from?.id);
  if (!st) return next?.();
  if (ctx.chat.type !== "private") return next?.();
  if (!isAdmin(ctx.from.id)) return next?.();

  const text = (ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) return next?.();

  if (st.expectingCustomWinners) {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return ctx.reply("❌ Số không hợp lệ. Nhập số từ 1 đến 1000.");
    st.data.winners = n;
    st.expectingCustomWinners = false;
    st.step = 2;
    return ctx.reply(
      `✅ Số người trúng: <b>${n}</b>\n\nBước 2/5: Nhập <b>thời gian quay</b> (HH:mm DD/MM/YYYY)\nVí dụ: <code>22:00 20/01/2026</code>`,
      { parse_mode: "HTML" }
    );
  }

  if (st.step === 2) {
    const end = dayjs(text, "HH:mm DD/MM/YYYY", true).tz(TZ);
    if (!end.isValid()) return ctx.reply("❌ Sai format. Ví dụ: 22:00 20/01/2026");
    if (end.unix() <= dayjs().unix()) return ctx.reply("❌ Thời gian phải ở tương lai.");

    st.data.endUnix = end.unix();
    st.step = 3;
    return ctx.reply("Bước 3/5: Nhập <b>phần thưởng</b>", { parse_mode: "HTML" });
  }

  if (st.step === 3) {
    if (text.length < 2) return ctx.reply("❌ Phần thưởng quá ngắn.");
    st.data.prize = text;
    st.step = 4;
    return ctx.reply("Bước 4/5: Nhập <b>nhà tài trợ</b> (ví dụ: @zaaraowo)", { parse_mode: "HTML" });
  }

  if (st.step === 4) {
    if (text.length < 2) return ctx.reply("❌ Nhà tài trợ quá ngắn.");
    st.data.sponsor = text;
    st.step = 5;
    return ctx.reply(buildPreviewText(st.data), { parse_mode: "HTML", ...confirmKeyboard() });
  }

  return next?.();
});

// ---------------- COMMAND ROUTER (/help /history /ginfo /cancel /proof /announce) ----------------
bot.on("text", async (ctx, next) => {
  const cmd = getCmd(ctx);
  if (!cmd.startsWith("/")) return next?.();

  // /help for everyone
  if (cmd === "/help") {
    const isAdm = isAdmin(ctx.from.id);

    let text = `📌 <b>BOT GIVEAWAY - HELP</b>\n\n`;
    text += `👤 <b>User:</b>\n`;
    text += `• <code>/start</code> - Bắt đầu\n`;
    text += `• Tham gia giveaway: bấm nút 🎉 Tham gia trong group\n\n`;

    if (isAdm) {
      text += `🛠️ <b>Admin (DM bot):</b>\n`;
      text += `• <code>/newgiveaway</code> - Tạo giveaway bằng form\n`;
      text += `• <code>/giveaway &lt;winners&gt;|&lt;HH:mm DD/MM/YYYY&gt;|&lt;prize&gt;|&lt;sponsor&gt;</code> - Tạo nhanh\n`;
      text += `• <code>/proof &lt;id&gt;</code> - Xem Commit/Seed/Verify (chỉ DM)\n`;
      text += `• <code>/announce &lt;id&gt;</code> - (Dự phòng) gửi kết quả vào nhóm\n\n`;

      text += `🛠️ <b>Admin (Group hoặc DM):</b>\n`;
      text += `• <code>/setgroup</code> - Set group mặc định\n`;
      text += `• <code>/group</code> - Xem group mặc định\n`;
      text += `• <code>/history</code> - 10 giveaway gần nhất\n`;
      text += `• <code>/ginfo &lt;id&gt;</code> - Info + winners (Proof chỉ hiện trong DM)\n`;
      text += `• <code>/cancel &lt;id&gt; [lý do]</code> - Hủy giveaway\n`;
    } else {
      text += `🔒 Một số lệnh chỉ dành cho admin.`;
    }

    return ctx.reply(text, { parse_mode: "HTML" });
  }

  if (!isAdmin(ctx.from.id)) return next?.();

  if (cmd === "/history") {
    const rows = db.prepare(`
      SELECT id, prize, ended, canceled, end_time, announced
      FROM giveaways
      ORDER BY id DESC
      LIMIT 10
    `).all();

    let text = "📜 <b>LỊCH SỬ GIVEAWAY</b>\n\n";
    if (!rows.length) text += "(chưa có)\n";

    for (const r of rows) {
      const status = r.canceled ? "⛔ Hủy" : (r.ended ? "✅ Đã quay" : "⏳ Đang chạy");
      const ann = r.announced ? "📣" : "🕒";
      text += `#${r.id} | ${status} ${ann} | ${escHtml(r.prize)}\n   ⏰ ${fmtUnix(r.end_time)}\n`;
    }
    return ctx.reply(text, { parse_mode: "HTML" });
  }

  if (cmd === "/ginfo") {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const gid = Number((parts[1] || "").trim());
    if (!gid) return ctx.reply("Dùng: /ginfo <id>");

    const g = db.prepare(`SELECT * FROM giveaways WHERE id=?`).get(gid);
    if (!g) return ctx.reply("Không tìm thấy giveaway.");

    const pCount = db.prepare(`SELECT COUNT(*) AS c FROM participants WHERE giveaway_id=?`).get(gid).c;
    const ws = db.prepare(`SELECT user_id,name FROM winners WHERE giveaway_id=? ORDER BY rowid ASC`).all(gid);

    const status = g.canceled ? "⛔ Đã hủy" : (g.ended ? "✅ Đã quay" : "⏳ Đang chạy");
    const ann = g.announced ? "✅ Đã gửi kết quả" : "❌ Chưa gửi kết quả";

    let text = `ℹ️ <b>Giveaway #${gid}</b>\n\n`;
    text += `🎁 <b>Phần thưởng:</b> ${escHtml(g.prize)}\n`;
    text += `🤝 <b>Nhà tài trợ:</b> ${escHtml(g.sponsor)}\n`;
    text += `🏆 <b>Số người trúng:</b> ${g.winners}\n`;
    text += `👥 <b>Tham gia:</b> ${pCount}\n`;
    text += `⏰ <b>Quay lúc:</b> ${fmtUnix(g.end_time)}\n`;
    text += `📌 <b>Trạng thái:</b> ${status}\n`;
    if (!g.canceled && g.ended) text += `📣 <b>Announce:</b> ${ann}\n`;
    if (g.canceled) text += `📝 <b>Lý do hủy:</b> ${escHtml(g.cancel_reason || "Không có")}\n`;

    text += `\n🏆 <b>Winners:</b>\n`;
    if (!ws.length) text += "(chưa có)\n";
    else ws.forEach((w, i) => (text += `${i + 1}. ${escHtml(w.name)} (${w.user_id})\n`));

    // ✅ Proof chỉ hiện trong DM
    if (ctx.chat.type === "private") {
      text += `\n\n${buildProofText(g)}`;
    } else {
      text += `\n\n🔒 Proof (Commit/Seed/Verify) chỉ xem trong DM: dùng <code>/proof ${gid}</code>`;
    }

    return ctx.reply(text, { parse_mode: "HTML" });
  }

  if (cmd === "/proof") {
    if (ctx.chat.type !== "private") return ctx.reply("ℹ️ Dùng /proof trong chat riêng với bot.");

    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const gid = Number((parts[1] || "").trim());
    if (!gid) return ctx.reply("Dùng: /proof <id>");

    const g = db.prepare(`SELECT * FROM giveaways WHERE id=?`).get(gid);
    if (!g) return ctx.reply("Không tìm thấy giveaway.");

    return ctx.reply(buildProofText(g), { parse_mode: "HTML" });
  }

  if (cmd === "/cancel") {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const gid = Number((parts[1] || "").trim());
    const reason = parts.slice(2).join(" ").trim() || "Không có";
    if (!gid) return ctx.reply("Dùng: /cancel <id> [lý do]");

    const g = db.prepare(`
      SELECT id, chat_id, message_id, prize, sponsor, ended, canceled
      FROM giveaways WHERE id=?
    `).get(gid);

    if (!g) return ctx.reply("❌ Không tìm thấy giveaway.");
    if (g.canceled === 1) return ctx.reply("⚠️ Giveaway đã bị hủy trước đó.");
    if (g.ended === 1) return ctx.reply("⚠️ Giveaway đã kết thúc, không thể hủy.");

    const now = dayjs().unix();
    db.prepare(`
      UPDATE giveaways
      SET canceled=1, ended=1, ended_at=?, cancel_reason=?
      WHERE id=?
    `).run(now, reason, gid);

    const count = db.prepare(`SELECT COUNT(*) AS c FROM participants WHERE giveaway_id=?`).get(gid).c;

    try {
      await ctx.telegram.editMessageText(
        g.chat_id,
        g.message_id,
        null,
        buildCanceledTextPublic({ ...g, cancel_reason: reason }, count),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
    } catch {}

    try {
      await ctx.telegram.sendMessage(
        g.chat_id,
        `⛔ Giveaway #${gid} đã bị <b>hủy</b>.\n🎁 <b>Phần thưởng:</b> ${escHtml(g.prize)}\n📝 <b>Lý do:</b> ${escHtml(reason)}`,
        { parse_mode: "HTML" }
      );
    } catch {}

    return ctx.reply(`✅ Đã hủy giveaway #${gid}.`);
  }

  // ✅ Dự phòng: admin DM bot để gửi kết quả vào group
  if (cmd === "/announce") {
    if (ctx.chat.type !== "private") return ctx.reply("ℹ️ Dùng /announce trong chat riêng với bot.");

    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const gid = Number((parts[1] || "").trim());
    if (!gid) return ctx.reply("Dùng: /announce <id>");

    const g = db.prepare(`SELECT * FROM giveaways WHERE id=?`).get(gid);
    if (!g) return ctx.reply("Không tìm thấy giveaway.");
    if (g.canceled) return ctx.reply("Giveaway đã bị hủy.");
    if (!g.ended) return ctx.reply("Giveaway chưa đến giờ quay hoặc chưa quay.");

    const ws = db.prepare(`SELECT user_id,name FROM winners WHERE giveaway_id=? ORDER BY rowid ASC`).all(gid);
    if (!ws.length) return ctx.reply("Chưa có winners trong DB (có thể bot chưa quay).");

    const publicText = buildWinnersTextPublic(g, ws);

    try {
      await ctx.telegram.sendMessage(g.chat_id, publicText, { parse_mode: "HTML" });
      db.prepare(`UPDATE giveaways SET announced=1, announced_at=? WHERE id=?`).run(dayjs().unix(), gid);

      // DM proof cho admin luôn
      for (const adminId of ADMINS) {
        bot.telegram.sendMessage(adminId, buildProofText(g), { parse_mode: "HTML" }).catch(() => {});
      }

      return ctx.reply(`✅ Đã gửi kết quả giveaway #${gid} vào nhóm.`);
    } catch (err) {
      console.error("MANUAL_ANNOUNCE_FAIL", gid, err?.response?.description || err);
      return ctx.reply(`❌ Gửi thất bại: ${err?.response?.description || "unknown error"}`);
    }
  }

  return next?.();
});

// ---------------- Core: create + post ----------------
async function createGiveawayAndPost(ctx, targetGroupId, winners, endUnix, prize, sponsor) {
  const seed = makeSeed();
  const seed_hash = sha256Hex(seed);

  const text = buildGiveawayTextPublic({ prize, sponsor, winners, end_time: endUnix }, 0);

  try {
    const sent = await ctx.telegram.sendMessage(targetGroupId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([Markup.button.callback("🎉 Tham gia", "temp")])
    });

    const info = db.prepare(`
      INSERT INTO giveaways(chat_id,message_id,prize,sponsor,winners,end_time,created_at,seed,seed_hash,announced)
      VALUES (?,?,?,?,?,?,?,?,?,0)
    `).run(
      targetGroupId,
      sent.message_id,
      prize,
      sponsor,
      winners,
      endUnix,
      dayjs().unix(),
      seed,
      seed_hash
    );

    const gid = info.lastInsertRowid;

    await ctx.telegram.editMessageReplyMarkup(
      targetGroupId,
      sent.message_id,
      null,
      Markup.inlineKeyboard([Markup.button.callback("🎉 Tham gia", `join_${gid}`)]).reply_markup
    );

    await ctx.reply(`✅ Đã tạo giveaway #${gid}\n⏰ Quay lúc: ${fmtUnix(endUnix)}`);
  } catch {
    await ctx.reply("❌ Bot không gửi được vào group. Hãy đảm bảo bot có quyền và đã /setgroup.");
  }
}

// ---------------- Join button (member-only) ----------------
bot.action(/^join_(\d+)$/, async ctx => {
  const gid = Number(ctx.match[1]);

  const g = db.prepare(`
    SELECT id, chat_id, message_id, prize, sponsor, winners, end_time, ended, canceled
    FROM giveaways WHERE id=?
  `).get(gid);

  if (!g) return ctx.answerCbQuery("❌ Giveaway không tồn tại", { show_alert: true });
  if (g.canceled === 1) return ctx.answerCbQuery("⛔ Giveaway đã bị hủy", { show_alert: true });

  const now = dayjs().unix();
  if (g.ended === 1 || now >= g.end_time) {
    return ctx.answerCbQuery("⏳ Giveaway đã đóng / đã quay", { show_alert: true });
  }

  const ok = await isGroupMember(ctx, g.chat_id, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("❌ Bạn phải là member của group mới được tham gia", { show_alert: true });

  try {
    db.prepare(`INSERT INTO participants(giveaway_id,user_id,name,joined_at) VALUES (?,?,?,?)`)
      .run(gid, ctx.from.id, ctx.from.first_name || ctx.from.username || "User", now);
  } catch {
    return ctx.answerCbQuery("❗ Bạn đã tham gia rồi", { show_alert: true });
  }

  const count = db.prepare(`SELECT COUNT(*) AS c FROM participants WHERE giveaway_id=?`).get(gid).c;

  try {
    const newText = buildGiveawayTextPublic(
      { prize: g.prize, sponsor: g.sponsor, winners: g.winners, end_time: g.end_time },
      count
    );

    await ctx.telegram.editMessageText(
      g.chat_id,
      g.message_id,
      null,
      newText,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([Markup.button.callback("🎉 Tham gia", `join_${gid}`)])
      }
    );
  } catch {}

  return ctx.answerCbQuery("🎉 Tham gia thành công!");
});

// ---------------- AUTO DRAW + AUTO ANNOUNCE (with retry) ----------------
async function drawAndAnnounce() {
  const now = dayjs().unix();

  // all due giveaways that haven't been announced yet
  const pending = db.prepare(`
    SELECT id, chat_id, prize, sponsor, winners, seed, seed_hash, ended, canceled, end_time
    FROM giveaways
    WHERE canceled = 0
      AND end_time <= ?
      AND announced = 0
  `).all(now);

  for (const g of pending) {
    try {
      // draw if not ended
      if (g.ended === 0) {
        const participants = db.prepare(`SELECT user_id, name FROM participants WHERE giveaway_id=?`).all(g.id);

        if (!participants.length) {
          db.prepare(`UPDATE giveaways SET ended=1, ended_at=? WHERE id=?`).run(now, g.id);

          const emptyText =
            `⛔ Giveaway #${g.id} kết thúc nhưng không có ai tham gia.\n` +
            `🎁 <b>Phần thưởng:</b> ${escHtml(g.prize)}\n` +
            `🤝 <b>Nhà tài trợ:</b> ${escHtml(g.sponsor)}\n`;

          await bot.telegram.sendMessage(g.chat_id, emptyText, { parse_mode: "HTML" });
          db.prepare(`UPDATE giveaways SET announced=1, announced_at=? WHERE id=?`).run(now, g.id);

          // DM proof cho admin
          const fresh = db.prepare(`SELECT * FROM giveaways WHERE id=?`).get(g.id);
          for (const adminId of ADMINS) {
            bot.telegram.sendMessage(adminId, buildProofText(fresh), { parse_mode: "HTML" }).catch(() => {});
          }

          continue;
        }

        const picked = pickWinnersDeterministic(g.seed, g.id, participants, g.winners);

        const insertWinner = db.prepare(`INSERT INTO winners(giveaway_id,user_id,name) VALUES (?,?,?)`);
        const tx = db.transaction(() => {
          for (const w of picked) insertWinner.run(g.id, w.user_id, w.name);
          db.prepare(`UPDATE giveaways SET ended=1, ended_at=? WHERE id=?`).run(now, g.id);
        });
        tx();
      }

      // announce from DB (so it can be retried)
      const ws = db.prepare(`SELECT user_id,name FROM winners WHERE giveaway_id=? ORDER BY rowid ASC`).all(g.id);
      if (!ws.length) {
        console.error("AUTO_ANNOUNCE_NO_WINNERS_IN_DB", g.id);
        continue; // don't mark announced => retry
      }

      const fresh = db.prepare(`SELECT * FROM giveaways WHERE id=?`).get(g.id);

      // GROUP: public winners only
      const publicText = buildWinnersTextPublic(fresh, ws);
      await bot.telegram.sendMessage(fresh.chat_id, publicText, { parse_mode: "HTML" });

      // mark announced only after success
      db.prepare(`UPDATE giveaways SET announced=1, announced_at=? WHERE id=?`).run(now, g.id);

      // DM: proof to admins
      for (const adminId of ADMINS) {
        bot.telegram.sendMessage(adminId, buildProofText(fresh), { parse_mode: "HTML" }).catch(() => {});
      }

    } catch (err) {
      console.error("AUTO_ANNOUNCE_FAIL", g.id, err?.response?.description || err);
      // don't set announced => retry next tick
    }
  }
}

setInterval(() => drawAndAnnounce(), TICK_SECONDS * 1000);

// ---------------- launch ----------------
bot.launch();
console.log("🤖 Giveaway bot is running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
