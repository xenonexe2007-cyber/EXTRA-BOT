require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { Pool } = require("pg");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const REFERRAL_BONUS = Math.max(0, Number(process.env.REFERRAL_BONUS || 10));
const MIN_WITHDRAW = Math.max(1, Number(process.env.MIN_WITHDRAW || 100));
const POINTS_PER_TAKA = Math.max(1, Number(process.env.POINTS_PER_TAKA || 100));

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  console.error("Missing required env vars: BOT_TOKEN, ADMIN_ID, DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});
const bot = new Bot(TOKEN);
const app = express();
app.use(express.json());

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance BIGINT NOT NULL DEFAULT 0,
      referred_by BIGINT,
      referral_paid BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward BIGINT NOT NULL CHECK (reward > 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_claims (
      user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(telegram_id),
      amount_points BIGINT NOT NULL,
      method TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
const isAdmin = ctx => String(ctx.from?.id || "") === ADMIN_ID;
const money = n => `${Number(n).toLocaleString("en-US")} পয়েন্ট`;
const mainKeyboard = () => new InlineKeyboard()
  .text("💰 ব্যালেন্স", "balance").text("🧑‍🤝‍🧑 রেফার", "refer").row()
  .text("📋 টাস্ক", "tasks").text("🏧 উইথড্র", "withdraw").row()
  .text("ℹ️ নিয়ম", "rules");
async function upsertUser(from, referrerId = null) {
  const id = String(from.id);
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, referred_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name`,
    [id, from.username || null, from.first_name || "বন্ধু", referrerId && String(referrerId) !== id ? String(referrerId) : null]
  );
}
async function getUser(id) {
  const r = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [String(id)]);
  return r.rows[0];
}
async function sendAdmin(text, keyboard) {
  try { await bot.api.sendMessage(ADMIN_ID, text, keyboard ? { reply_markup: keyboard } : {}); }
  catch (e) { console.error("Could not notify admin:", e.message); }
}

bot.command("start", async ctx => {
  const payload = (ctx.match || "").trim();
  let ref = null;
  if (payload.startsWith("ref_")) ref = payload.slice(4).replace(/\D/g, "");
  await upsertUser(ctx.from, ref || null);
  const user = await getUser(ctx.from.id);
  if (user.referred_by && !user.referral_paid && String(user.referred_by) !== String(ctx.from.id)) {
    // Bonus is credited once, only after the referred user starts the bot.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const check = await client.query("SELECT referral_paid, referred_by FROM users WHERE telegram_id=$1 FOR UPDATE", [String(ctx.from.id)]);
      if (check.rows[0]?.referred_by && !check.rows[0].referral_paid) {
        await client.query("UPDATE users SET balance=balance+$1 WHERE telegram_id=$2", [REFERRAL_BONUS, String(check.rows[0].referred_by)]);
        await client.query("UPDATE users SET referral_paid=TRUE WHERE telegram_id=$1", [String(ctx.from.id)]);
        await client.query("COMMIT");
        await sendAdmin(`🎯 নতুন রেফারেল শুরু করেছে\nUser: ${ctx.from.id}\nReferrer: ${check.rows[0].referred_by}\nবোনাস: ${REFERRAL_BONUS} পয়েন্ট`);
      } else await client.query("ROLLBACK");
    } catch (e) { await client.query("ROLLBACK"); console.error(e); }
    finally { client.release(); }
  }
  await ctx.reply(
    `স্বাগতম, ${ctx.from.first_name || "বন্ধু"}! 👋\n\n` +
    `🎁 X-EXTRA EARNING BOT\n` +
    `এখানে অনুমোদিত টাস্ক সম্পন্ন করে ও বন্ধু আমন্ত্রণ করে পয়েন্ট অর্জন করতে পারবে।\n\n` +
    `⚠️ পয়েন্ট বাস্তব টাকা নয়। পেমেন্ট শুধু অ্যাডমিনের যাচাই ও তহবিলের প্রাপ্যতার ওপর নির্ভরশীল।`,
    { reply_markup: mainKeyboard() }
  );
});

bot.command("admin", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ এই কমান্ড শুধু অ্যাডমিনের জন্য।");
  await ctx.reply("🛠 Admin Panel\n\n/addtask শিরোনাম | URL | reward_points\n/tasksadmin\n/withdrawals\n/stats\n/credit USER_ID POINTS\n\nটাস্কের প্রমাণ যাচাই করে claim approve করতে /claims ব্যবহার করো।");
});
bot.command("addtask", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const raw = (ctx.match || "").trim();
  const parts = raw.split("|").map(x => x.trim());
  if (parts.length !== 3 || !parts[0] || !/^https?:\/\//i.test(parts[1]) || !/^\d+$/.test(parts[2]) || Number(parts[2]) < 1)
    return ctx.reply("ফরম্যাট:\n/addtask টাস্কের নাম | https://example.com | 20");
  const r = await pool.query("INSERT INTO tasks(title,url,reward) VALUES($1,$2,$3) RETURNING id", parts);
  await ctx.reply(`✅ টাস্ক যোগ হয়েছে। ID: ${r.rows[0].id}`);
});
bot.command("tasksadmin", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const r = await pool.query("SELECT id,title,reward,active FROM tasks ORDER BY id DESC LIMIT 30");
  await ctx.reply(r.rows.length ? r.rows.map(t => `${t.id}. ${t.title} — ${t.reward} পয়েন্ট — ${t.active ? "চালু" : "বন্ধ"}`).join("\n") : "এখনো কোনো টাস্ক নেই।");
});
bot.command("claims", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const r = await pool.query(`SELECT c.user_id,c.task_id,t.title,t.reward FROM task_claims c JOIN tasks t ON t.id=c.task_id WHERE c.status='pending' ORDER BY c.created_at LIMIT 20`);
  if (!r.rows.length) return ctx.reply("Pending claim নেই।");
  for (const c of r.rows) {
    const kb = new InlineKeyboard().text("✅ Approve", `claim_ok:${c.user_id}:${c.task_id}`).text("❌ Reject", `claim_no:${c.user_id}:${c.task_id}`);
    await ctx.reply(`Claim pending\nUser: ${c.user_id}\nTask: ${c.task_id} — ${c.title}\nReward: ${c.reward} points`, { reply_markup: kb });
  }
});
bot.command("withdrawals", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const r = await pool.query("SELECT * FROM withdrawals WHERE status='pending' ORDER BY id LIMIT 20");
  if (!r.rows.length) return ctx.reply("Pending withdrawal নেই।");
  for (const w of r.rows) {
    const kb = new InlineKeyboard().text("✅ Paid", `wd_paid:${w.id}`).text("↩️ Reject/refund", `wd_reject:${w.id}`);
    await ctx.reply(`Withdrawal #${w.id}\nUser: ${w.user_id}\nAmount: ${w.amount_points} points\nMethod: ${w.method}\nAccount: ${w.account}`, { reply_markup: kb });
  }
});
bot.command("stats", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM users) users,
    (SELECT COALESCE(SUM(balance),0) FROM users) points,
    (SELECT COUNT(*) FROM withdrawals WHERE status='pending') pending_withdrawals,
    (SELECT COUNT(*) FROM task_claims WHERE status='pending') pending_claims`);
  const s = r.rows[0];
  await ctx.reply(`📊 Stats\nUsers: ${s.users}\nমোট পয়েন্ট ব্যালেন্স: ${s.points}\nPending withdrawals: ${s.pending_withdrawals}\nPending claims: ${s.pending_claims}`);
});
bot.command("credit", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ শুধু অ্যাডমিন।");
  const p = (ctx.match || "").trim().split(/\s+/);
  if (p.length !== 2 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1]) || Number(p[1]) < 1) return ctx.reply("ফরম্যাট: /credit USER_ID POINTS");
  const r = await pool.query("UPDATE users SET balance=balance+$1 WHERE telegram_id=$2 RETURNING telegram_id", [Number(p[1]), p[0]]);
  if (!r.rowCount) return ctx.reply("এই user ID পাওয়া যায়নি।");
  await ctx.reply("✅ পয়েন্ট যোগ হয়েছে।");
  try { await bot.api.sendMessage(p[0], `🎁 অ্যাডমিন তোমার ব্যালেন্সে ${p[1]} পয়েন্ট যোগ করেছেন।`); } catch {}
});

bot.callbackQuery("balance", async ctx => {
  const u = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(`💰 তোমার ব্যালেন্স: ${money(u?.balance || 0)}\n\nউইথড্রের ন্যূনতম সীমা: ${MIN_WITHDRAW} পয়েন্ট।`);
});
bot.callbackQuery("refer", async ctx => {
  const me = await bot.api.getMe();
  const r = await pool.query("SELECT COUNT(*)::int n FROM users WHERE referred_by=$1", [String(ctx.from.id)]);
  await ctx.answerCallbackQuery();
  await ctx.reply(`🧑‍🤝‍🧑 তোমার রেফারেল লিংক:\nhttps://t.me/${me.username}?start=ref_${ctx.from.id}\n\nশুরু করা প্রতি নতুন ব্যবহারকারীর জন্য ${REFERRAL_BONUS} পয়েন্ট। একই ব্যক্তি/অ্যাকাউন্টের অপব্যবহার নিষিদ্ধ।\nতোমার রেফারেল: ${r.rows[0].n}`);
});
bot.callbackQuery("tasks", async ctx => {
  const r = await pool.query("SELECT * FROM tasks WHERE active=TRUE ORDER BY id DESC LIMIT 20");
  await ctx.answerCallbackQuery();
  if (!r.rows.length) return ctx.reply("এই মুহূর্তে কোনো টাস্ক নেই। পরে আবার দেখো।");
  for (const t of r.rows) {
    const kb = new InlineKeyboard().url("🔗 টাস্ক খুলুন", t.url).row().text("📨 সম্পন্ন করেছি", `task_claim:${t.id}`);
    await ctx.reply(`📋 ${t.title}\nপুরস্কার: ${t.reward} পয়েন্ট\n\nকাজ শেষ করে প্রমাণসহ claim পাঠাও। অ্যাডমিন যাচাই করবে।`, { reply_markup: kb });
  }
});
bot.callbackQuery(/^task_claim:(\d+)$/, async ctx => {
  const taskId = Number(ctx.match[1]);
  const task = await pool.query("SELECT id,title,reward FROM tasks WHERE id=$1 AND active=TRUE", [taskId]);
  if (!task.rowCount) { await ctx.answerCallbackQuery({ text: "টাস্ক পাওয়া যায়নি।", show_alert: true }); return; }
  const r = await pool.query("INSERT INTO task_claims(user_id,task_id,status) VALUES($1,$2,'pending') ON CONFLICT(user_id,task_id) DO NOTHING RETURNING user_id", [String(ctx.from.id), taskId]);
  await ctx.answerCallbackQuery({ text: r.rowCount ? "Claim পাঠানো হয়েছে" : "আগে claim পাঠানো হয়েছে", show_alert: true });
  if (r.rowCount) {
    await ctx.reply("📨 Claim জমা হয়েছে। অ্যাডমিন চাইলে তোমার কাজের প্রমাণ চাইতে পারেন।");
    await sendAdmin(`📋 Task claim\nUser: ${ctx.from.id}\nTask: ${task.rows[0].title} (#${taskId})\nReward: ${task.rows[0].reward}\nপ্রমাণ যাচাই করে /claims থেকে সিদ্ধান্ত নাও।`);
  }
});
bot.callbackQuery(/^claim_(ok|no):(\d+):(\d+)$/, async ctx => {
  if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "শুধু অ্যাডমিন।", show_alert: true }); return; }
  const action = ctx.match[1], userId = ctx.match[2], taskId = Number(ctx.match[3]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query(`SELECT c.status,t.reward,t.title FROM task_claims c JOIN tasks t ON t.id=c.task_id WHERE c.user_id=$1 AND c.task_id=$2 FOR UPDATE`, [userId, taskId]);
    if (!c.rowCount || c.rows[0].status !== "pending") { await client.query("ROLLBACK"); await ctx.answerCallbackQuery({ text: "আগেই নিষ্পত্তি হয়েছে।", show_alert: true }); return; }
    const status = action === "ok" ? "approved" : "rejected";
    await client.query("UPDATE task_claims SET status=$1 WHERE user_id=$2 AND task_id=$3", [status,userId,taskId]);
    if (action === "ok") await client.query("UPDATE users SET balance=balance+$1 WHERE telegram_id=$2", [c.rows[0].reward,userId]);
    await client.query("COMMIT");
    await ctx.answerCallbackQuery({ text: status });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    try { await bot.api.sendMessage(userId, action === "ok" ? `✅ টাস্ক অনুমোদিত! ${c.rows[0].reward} পয়েন্ট যোগ হয়েছে।` : "❌ টাস্ক claim বাতিল হয়েছে।"); } catch {}
  } catch (e) { await client.query("ROLLBACK"); console.error(e); await ctx.answerCallbackQuery({ text: "ত্রুটি হয়েছে।", show_alert: true }); }
  finally { client.release(); }
});

bot.callbackQuery("withdraw", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.reply(`🏧 উইথড্র করতে এই ফরম্যাটে পাঠাও:\n\n/wd POINTS METHOD ACCOUNT\n\nউদাহরণ: /wd 1000 bKash 01XXXXXXXXX\nন্যূনতম: ${MIN_WITHDRAW} পয়েন্ট\n\n⚠️ অ্যাকাউন্ট নম্বর private chat-এ পাঠাও। পেমেন্ট অ্যাডমিনের যাচাই ও তহবিলের ওপর নির্ভরশীল।`);
});
bot.command("wd", async ctx => {
  const p = (ctx.match || "").trim().split(/\s+/);
  if (p.length < 3 || !/^\d+$/.test(p[0]) || !["bkash","nagad","rocket"].includes(p[1].toLowerCase()) || !/^[0-9+ -]{8,20}$/.test(p.slice(2).join(" "))) {
    return ctx.reply("ফরম্যাট: /wd POINTS bKash ACCOUNT\nউদাহরণ: /wd 1000 bKash 01XXXXXXXXX");
  }
  const amount = Number(p[0]), method = p[1], account = p.slice(2).join(" ");
  if (amount < MIN_WITHDRAW) return ctx.reply(`ন্যূনতম ${MIN_WITHDRAW} পয়েন্ট লাগবে।`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE", [String(ctx.from.id)]);
    if (!u.rowCount || Number(u.rows[0].balance) < amount) {
      await client.query("ROLLBACK"); return ctx.reply("❌ পর্যাপ্ত পয়েন্ট নেই।");
    }
    await client.query("UPDATE users SET balance=balance-$1 WHERE telegram_id=$2", [amount,String(ctx.from.id)]);
    const w = await client.query("INSERT INTO withdrawals(user_id,amount_points,method,account) VALUES($1,$2,$3,$4) RETURNING id", [String(ctx.from.id),amount,method,account]);
    await client.query("COMMIT");
    await ctx.reply(`✅ Withdrawal request #${w.rows[0].id} জমা হয়েছে। অ্যাডমিন যাচাই করবেন।`);
    const kb = new InlineKeyboard().text("✅ Paid", `wd_paid:${w.rows[0].id}`).text("↩️ Reject/refund", `wd_reject:${w.rows[0].id}`);
    await sendAdmin(`🏧 নতুন withdrawal #${w.rows[0].id}\nUser: ${ctx.from.id}\nPoints: ${amount}\nMethod: ${method}\nAccount: ${account}`, kb);
  } catch (e) { await client.query("ROLLBACK"); console.error(e); await ctx.reply("ত্রুটি হয়েছে। পরে আবার চেষ্টা করো।"); }
  finally { client.release(); }
});
bot.callbackQuery(/^wd_(paid|reject):(\d+)$/, async ctx => {
  if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "শুধু অ্যাডমিন।", show_alert: true }); return; }
  const id = Number(ctx.match[2]), action = ctx.match[1];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE", [id]);
    if (!r.rowCount || r.rows[0].status !== "pending") { await client.query("ROLLBACK"); await ctx.answerCallbackQuery({ text: "আগেই নিষ্পত্তি হয়েছে।", show_alert: true }); return; }
    const w = r.rows[0];
    if (action === "reject") await client.query("UPDATE users SET balance=balance+$1 WHERE telegram_id=$2", [w.amount_points,w.user_id]);
    await client.query("UPDATE withdrawals SET status=$1 WHERE id=$2", [action === "paid" ? "paid" : "rejected",id]);
    await client.query("COMMIT");
    await ctx.answerCallbackQuery({ text: action === "paid" ? "Paid marked" : "Rejected and refunded" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    try { await bot.api.sendMessage(String(w.user_id), action === "paid" ? `✅ Withdrawal #${id} paid হিসেবে চিহ্নিত হয়েছে।` : `↩️ Withdrawal #${id} বাতিল; ${w.amount_points} পয়েন্ট ফেরত দেওয়া হয়েছে।`); } catch {}
  } catch (e) { await client.query("ROLLBACK"); console.error(e); await ctx.answerCallbackQuery({ text: "ত্রুটি হয়েছে।", show_alert: true }); }
  finally { client.release(); }
});
bot.callbackQuery("rules", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.reply(`📌 নিয়ম\n• পয়েন্টের নিজস্ব নগদ মূল্য নেই।\n• টাস্কের দাবি অ্যাডমিন যাচাই করবেন।\n• রেফারেল বোনাস নতুন ব্যবহারকারী /start করলে একবার যোগ হয়।\n• উইথড্র অ্যাডমিনের হাতে যাচাই ও বাস্তব তহবিল থাকলে সম্পন্ন হবে।\n• ভুয়া অ্যাকাউন্ট, স্প্যাম বা প্রতারণা করলে পুরস্কার বাতিল হতে পারে।\n• এই বট নিজে থেকে আয় তৈরি করে না।`);
});

app.get("/", (_req,res) => res.status(200).send("X-EXTRA EARNING BOT is running."));
app.get("/health", (_req,res) => res.json({ ok: true }));
async function main() {
  await initDb();
  if (PUBLIC_URL) {
    const secret = process.env.WEBHOOK_SECRET || require("crypto").randomBytes(24).toString("hex");
    app.use("/telegram", webhookCallback(bot, "express", { secretToken: secret }));
    app.listen(PORT, async () => {
      try {
        await bot.api.setWebhook(`${PUBLIC_URL}/telegram`, { secret_token: secret, allowed_updates: ["message","callback_query"] });
        console.log("Webhook configured at", `${PUBLIC_URL}/telegram`);
      } catch (e) { console.error("Webhook setup failed:", e); process.exit(1); }
    });
  } else {
    app.listen(PORT, () => console.log(`HTTP health server listening on ${PORT}`));
    await bot.start();
    console.log("Bot started in polling mode.");
  }
}
process.once("SIGINT", () => { bot.stop(); pool.end(); process.exit(0); });
process.once("SIGTERM", () => { bot.stop(); pool.end(); process.exit(0); });
main().catch(e => { console.error("Startup failed:", e); process.exit(1); });
