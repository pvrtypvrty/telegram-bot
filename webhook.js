// ============================================================
// COMBINED SERVER — webhook.js (Stripe + Telegram Bot)
// ============================================================
require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const Replicate = require("replicate");
const Stripe = require("stripe");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 600000 });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const COST_PER_IMAGE = 5;
const COST_PER_EDIT = 10;
const COST_PER_VIDEO = 50;
const REFERRAL_REWARD = 10;
const REFERRAL_BONUS = 5;
const ADMIN_ID = "1924511933";

const pendingPhotos = new Map();
const pendingEdits = new Map();
const pendingVideos = new Map();

// ── HELPERS ──────────────────────────────────────────────────
async function getOrCreateUser(telegramId, username, referredBy = null) {
  const { data: existing } = await supabase.from("users").select("*").eq("telegram_id", telegramId).single();
  if (existing) return existing;
  const startCredits = referredBy ? 10 + REFERRAL_BONUS : 10;
  const { data: newUser } = await supabase.from("users")
    .insert({ telegram_id: telegramId, username, credits: startCredits, referred_by: referredBy || null })
    .select().single();
  if (referredBy) {
    const { data: referrer } = await supabase.from("users")
      .select("credits, referral_count, referral_credits_earned").eq("telegram_id", referredBy).single();
    if (referrer) {
      await supabase.from("users").update({
        credits: referrer.credits + REFERRAL_REWARD,
        referral_count: (referrer.referral_count || 0) + 1,
        referral_credits_earned: (referrer.referral_credits_earned || 0) + REFERRAL_REWARD,
      }).eq("telegram_id", referredBy);
      try { await bot.telegram.sendMessage(referredBy, `🎉 Someone joined via your referral!\n\n+${REFERRAL_REWARD} credits added!`); } catch(e) {}
    }
  }
  return newUser;
}

async function getCredits(telegramId) {
  const { data } = await supabase.from("users")
    .select("credits, subscription_active, subscription_expires_at").eq("telegram_id", telegramId).single();
  return data;
}

async function deductCredits(telegramId, amount) {
  const { data: user } = await supabase.from("users").select("credits").eq("telegram_id", telegramId).single();
  if (!user || user.credits < amount) return false;
  await supabase.from("users").update({ credits: user.credits - amount }).eq("telegram_id", telegramId);
  return true;
}

async function refundCredits(telegramId, amount) {
  const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", telegramId).single();
  if (u) await supabase.from("users").update({ credits: u.credits + amount }).eq("telegram_id", telegramId);
}

async function logGeneration(telegramId, prompt, url) {
  await supabase.from("generations").insert({ telegram_id: telegramId, prompt, image_url: url });
}

function autoDelete(chatId, messageId, ms = 60 * 60 * 1000) {
  setTimeout(async () => { try { await bot.telegram.deleteMessage(chatId, messageId); } catch(e) {} }, ms);
}

function getUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (output[0]?.url) return output[0].url();
  if (typeof output[0] === 'string') return output[0];
  return null;
}

function isAdmin(ctx) { return ctx.from.id.toString() === ADMIN_ID; }

// ── VIDEO GENERATION (non-blocking) ──────────────────────────
async function generateVideo(chatId, telegramId, prompt, startImageUrl, isSub, creditsLeft) {
  try {
    const prediction = await replicate.predictions.create({
      model: "kwaivgi/kling-v2.1",
      input: { prompt, duration: 10, aspect_ratio: "9:16", mode: "pro", ...(startImageUrl ? { start_image: startImageUrl } : {}) }
    });
    let result = prediction;
    while (result.status !== "succeeded" && result.status !== "failed" && result.status !== "canceled") {
      await new Promise(r => setTimeout(r, 10000));
      result = await replicate.predictions.get(prediction.id);
    }
    if (result.status !== "succeeded") throw new Error("Video failed: " + result.status);
    const videoUrl = getUrl(result.output);
    await logGeneration(telegramId, `[VIDEO] ${prompt}`, videoUrl);
    const msg = await bot.telegram.sendVideo(chatId, { url: videoUrl }, {
      caption: `🎬 *Video Done!*\n\n📝 _${prompt}_\n` + (isSub ? `⭐ Unlimited\n` : `💳 Credits left: *${creditsLeft}*\n`) + `\n⏱ _Deletes in 1 hour_`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔄 Another Video", callback_data: "video_help" }, { text: "🎨 Generate Image", callback_data: "generate_help" }]] }
    });
    autoDelete(chatId, msg.message_id);
  } catch (err) {
    console.error("Video error:", err);
    if (!isSub) await refundCredits(telegramId, COST_PER_VIDEO);
    await bot.telegram.sendMessage(chatId, "❌ Video failed. Credits refunded. Try again!");
  }
}

// ── BOT COMMANDS ──────────────────────────────────────────────
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  let referredBy = null;
  if (payload && payload.startsWith("ref_")) {
    referredBy = payload.replace("ref_", "");
    if (referredBy === ctx.from.id.toString()) referredBy = null;
  }
  const user = await getOrCreateUser(ctx.from.id.toString(), ctx.from.username || ctx.from.first_name, referredBy);
  const welcomeExtra = referredBy ? `\n🎁 Referral bonus: *+${REFERRAL_BONUS} credits*!\n` : "";
  await ctx.reply(
    `✨ *Welcome to ImageBot!*\n\n` + welcomeExtra +
    `You have *${user.credits} credits* to start.\n\n` +
    `🎨 Generate image — ${COST_PER_IMAGE} credits\n✏️ Edit image — ${COST_PER_EDIT} credits\n🎬 Generate video — ${COST_PER_VIDEO} credits\n\n` +
    `/generate [prompt] — Create an image\n/edit — Edit your image\n/video [prompt] — Create a video\n/buy — Purchase credits\n/subscribe — Unlimited monthly\n/referral — Earn free credits\n/balance — Check credits`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🎨 Generate Image", "generate_help"), Markup.button.callback("🎬 Generate Video", "video_help")],
      [Markup.button.callback("✏️ Edit My Image", "edit_help"), Markup.button.callback("💰 Buy Credits", "buy_menu")],
    ])}
  );
});

bot.command("balance", async (ctx) => {
  const data = await getCredits(ctx.from.id.toString());
  if (!data) return ctx.reply("Use /start first.");
  const subStatus = data.subscription_active ? `✅ Active` : "❌ None";
  ctx.reply(`💳 *Your Account*\n\nCredits: *${data.credits}*\nSubscription: ${subStatus}\n\n🎨 Image: ${COST_PER_IMAGE} cr | ✏️ Edit: ${COST_PER_EDIT} cr | 🎬 Video: ${COST_PER_VIDEO} cr`, { parse_mode: "Markdown" });
});

bot.command("generate", async (ctx) => {
  const prompt = ctx.message.text.replace("/generate", "").trim();
  if (!prompt) return ctx.reply("Example:\n`/generate a futuristic city at night`", { parse_mode: "Markdown" });
  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");
  const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && userData.credits < COST_PER_IMAGE) return ctx.reply(`❌ Need *${COST_PER_IMAGE}* credits. You have *${userData.credits}*. Use /buy.`, { parse_mode: "Markdown" });
  const thinkingMsg = await ctx.reply("🎨 Generating... ~20 seconds");
  try {
    if (!isSub) await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);
    const output = await replicate.run("black-forest-labs/flux-2-pro", { input: { prompt, num_outputs: 1, width: 1152, height: 2048 } });
    const imageUrl = getUrl(output);
    await logGeneration(ctx.from.id.toString(), prompt, imageUrl);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_IMAGE;
    const msg = await ctx.replyWithPhoto({ url: imageUrl }, {
      caption: `✅ *Done!*\n\n📝 _${prompt}_\n` + (isSub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Generate Another", "generate_help"), Markup.button.callback("✏️ Edit This", "edit_help")],
        [Markup.button.callback("🎬 Turn into Video", "video_help")],
      ]),
    });
    autoDelete(ctx.chat.id, msg.message_id);
  } catch (err) {
    console.error(err);
    if (!isSub) await refundCredits(ctx.from.id.toString(), COST_PER_IMAGE);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    ctx.reply("❌ Generation failed. Credits refunded.");
  }
});

bot.command("video", async (ctx) => {
  const prompt = ctx.message.text.replace("/video", "").trim();
  if (!prompt) return ctx.reply(`🎬 *Generate a Video*\n\nCosts *${COST_PER_VIDEO} credits*.\n\nUsage: \`/video your prompt\`\n\nOr send any photo to animate it!\n\n⏱ ~3-5 min | 📹 1080p 10s`, { parse_mode: "Markdown" });
  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");
  const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && userData.credits < COST_PER_VIDEO) return ctx.reply(`❌ Need *${COST_PER_VIDEO}* credits. You have *${userData.credits}*. Use /buy.`, { parse_mode: "Markdown" });
  if (!isSub) await deductCredits(ctx.from.id.toString(), COST_PER_VIDEO);
  const newCredits = isSub ? userData.credits : userData.credits - COST_PER_VIDEO;
  await ctx.reply("🎬 Your video is being generated...\n\n⏱ *3-5 minutes* — I'll send it when ready!", { parse_mode: "Markdown" });
  generateVideo(ctx.chat.id, ctx.from.id.toString(), prompt, null, isSub, newCredits);
});

bot.command("edit", async (ctx) => {
  ctx.reply(`✏️ *Edit Your Image*\n\nCosts *${COST_PER_EDIT} credits*.\n\nSend me any photo and I'll ask what to change!`, { parse_mode: "Markdown" });
});

bot.action("edit_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`✏️ Send me any photo to edit! Costs *${COST_PER_EDIT} credits*.`, { parse_mode: "Markdown" }); });
bot.action("video_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`🎬 Type \`/video your prompt\` or send a photo!\n\nCosts *${COST_PER_VIDEO} credits*.`, { parse_mode: "Markdown" }); });
bot.action("generate_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply("🎨 Type:\n`/generate your prompt here`", { parse_mode: "Markdown" }); });

bot.on("photo", async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const userData = await getCredits(telegramId);
  if (!userData) return ctx.reply("Use /start first.");
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  pendingPhotos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingPhotos.delete(telegramId), 10 * 60 * 1000);
  await ctx.reply(`📸 *Image received!*\n\nWhat do you want to do?`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`✏️ Edit it (${COST_PER_EDIT} credits)`, "choose_edit")],
      [Markup.button.callback(`🎬 Animate into video (${COST_PER_VIDEO} credits)`, "choose_video")],
    ])
  });
});

bot.action("choose_edit", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  if (!pendingPhotos.has(telegramId)) return ctx.reply("Photo expired. Send your image again.");
  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);
  const userData = await getCredits(telegramId);
  const isSub = userData?.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && (!userData || userData.credits < COST_PER_EDIT)) return ctx.reply(`❌ Need *${COST_PER_EDIT}* credits.`, { parse_mode: "Markdown" });
  pendingEdits.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingEdits.delete(telegramId), 10 * 60 * 1000);
  ctx.reply(`✏️ What should I do?\n\nExamples:\n• make this cinematic\n• change background to beach\n• anime style\n• add neon lights`, { parse_mode: "Markdown" });
});

bot.action("choose_video", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  if (!pendingPhotos.has(telegramId)) return ctx.reply("Photo expired. Send your image again.");
  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);
  const userData = await getCredits(telegramId);
  const isSub = userData?.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && (!userData || userData.credits < COST_PER_VIDEO)) return ctx.reply(`❌ Need *${COST_PER_VIDEO}* credits.`, { parse_mode: "Markdown" });
  pendingVideos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingVideos.delete(telegramId), 10 * 60 * 1000);
  ctx.reply(`🎬 How should I animate this?\n\nExamples:\n• slow cinematic zoom in\n• person starts walking\n• waves moving\n• camera pans right`, { parse_mode: "Markdown" });
});

bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id.toString();
  if (pendingEdits.has(telegramId)) {
    const { fileId } = pendingEdits.get(telegramId);
    const editPrompt = ctx.message.text;
    pendingEdits.delete(telegramId);
    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
    if (!isSub && userData.credits < COST_PER_EDIT) return ctx.reply(`❌ Not enough credits.`);
    const thinkingMsg = await ctx.reply("✏️ Editing... ~30 seconds");
    try {
      if (!isSub) await deductCredits(telegramId, COST_PER_EDIT);
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const output = await replicate.run("black-forest-labs/flux-kontext-pro", {
        input: { prompt: editPrompt, input_image: fileLink.href, output_format: "jpg", output_quality: 100, safety_tolerance: 6 }
      });
      const resultUrl = getUrl(output);
      await logGeneration(telegramId, `[EDIT] ${editPrompt}`, resultUrl);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      const newCredits = isSub ? userData.credits : userData.credits - COST_PER_EDIT;
      const msg = await ctx.replyWithPhoto({ url: resultUrl }, {
        caption: `✅ *Edit Done!*\n\n✏️ _${editPrompt}_\n` + (isSub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("✏️ Edit Again", "edit_help"), Markup.button.callback("🎬 Make Video", "video_help")]]),
      });
      autoDelete(ctx.chat.id, msg.message_id);
    } catch (err) {
      console.error(err);
      if (!isSub) await refundCredits(telegramId, COST_PER_EDIT);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      ctx.reply("❌ Edit failed. Credits refunded.");
    }
    return;
  }
  if (pendingVideos.has(telegramId)) {
    const { fileId } = pendingVideos.get(telegramId);
    const videoPrompt = ctx.message.text;
    pendingVideos.delete(telegramId);
    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
    if (!isSub && userData.credits < COST_PER_VIDEO) return ctx.reply(`❌ Not enough credits.`);
    if (!isSub) await deductCredits(telegramId, COST_PER_VIDEO);
    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_VIDEO;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    await ctx.reply("🎬 Animating your image...\n\n⏱ *3-5 minutes* — I'll send it when ready!", { parse_mode: "Markdown" });
    generateVideo(ctx.chat.id, telegramId, videoPrompt, fileLink.href, isSub, newCredits);
    return;
  }
});

bot.command("referral", async (ctx) => { await showReferral(ctx); });
bot.action("show_referral", async (ctx) => { await ctx.answerCbQuery(); await showReferral(ctx); });
async function showReferral(ctx) {
  const telegramId = ctx.from.id.toString();
  const { data: user } = await supabase.from("users").select("referral_count, referral_credits_earned").eq("telegram_id", telegramId).single();
  const botUsername = ctx.botInfo.username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 *Your Referral Link*\n\nEarn *${REFERRAL_REWARD} credits* per person!\n\n🔗 \`${referralLink}\`\n\n📊 Referrals: *${user?.referral_count || 0}* | Earned: *${user?.referral_credits_earned || 0}*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.url("📤 Share", `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join this AI image & video bot — get free credits!")}`)]]) }
  );
}

bot.command("buy", async (ctx) => { await showBuyMenu(ctx); });
bot.action("buy_menu", async (ctx) => { await ctx.answerCbQuery(); await showBuyMenu(ctx); });
async function showBuyMenu(ctx) {
  await ctx.reply("💰 *Buy Credits*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("Starter — 50 credits — $4.99", "buy_50")],
      [Markup.button.callback("Popular — 150 credits — $9.99", "buy_150")],
      [Markup.button.callback("Pro — 400 credits — $19.99", "buy_400")],
    ])
  });
}

["50", "150", "400"].forEach((credits) => {
  bot.action(`buy_${credits}`, async (ctx) => {
    await ctx.answerCbQuery();
    const priceMap = { "50": process.env.STRIPE_PRICE_50, "150": process.env.STRIPE_PRICE_150, "400": process.env.STRIPE_PRICE_400 };
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"], line_items: [{ price: priceMap[credits], quantity: 1 }], mode: "payment",
        success_url: `${process.env.WEBHOOK_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.WEBHOOK_URL}/payment-cancel`,
        metadata: { telegram_id: ctx.from.id.toString(), credits, type: "credits" },
      });
      await ctx.reply(`💳 *${credits} credits*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.url("💳 Pay Now", session.url)]]) });
    } catch (err) { ctx.reply("❌ Error: " + err.message); }
  });
});

bot.command("subscribe", async (ctx) => { await showSubscribeMenu(ctx); });
bot.action("subscribe_menu", async (ctx) => { await ctx.answerCbQuery(); await showSubscribeMenu(ctx); });
async function showSubscribeMenu(ctx) {
  await ctx.reply("⭐ *Monthly Subscription*\n\nUnlimited images, edits & videos.\n\n*$14.99 / month* — Cancel anytime", {
    parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⭐ Subscribe Now — $14.99/mo", "start_subscribe")]])
  });
}
bot.action("start_subscribe", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"], line_items: [{ price: process.env.STRIPE_PRICE_SUB, quantity: 1 }], mode: "subscription",
      success_url: `${process.env.WEBHOOK_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEBHOOK_URL}/payment-cancel`,
      metadata: { telegram_id: ctx.from.id.toString(), type: "subscription" },
    });
    await ctx.reply("⭐ *Subscribe*", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.url("⭐ Subscribe Now", session.url)]]) });
  } catch (err) { ctx.reply("❌ Error. Try again."); }
});

bot.command("help", async (ctx) => {
  ctx.reply(`📖 *Commands*\n\n/generate [prompt] — Image (${COST_PER_IMAGE} cr)\n/edit — Edit image (${COST_PER_EDIT} cr)\n/video [prompt] — Video (${COST_PER_VIDEO} cr)\n/balance — Credits\n/referral — Earn credits\n/buy — Buy credits\n/subscribe — Unlimited\n/help — This menu`, { parse_mode: "Markdown" });
});

// ── ADMIN ─────────────────────────────────────────────────────
bot.command("addcredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /addcredits [telegram_id] [amount]");
  const targetId = parts[1]; const amount = parseInt(parts[2]);
  if (isNaN(amount)) return ctx.reply("Invalid amount.");
  const { data: user } = await supabase.from("users").select("credits, username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  await supabase.from("users").update({ credits: user.credits + amount }).eq("telegram_id", targetId);
  try { await bot.telegram.sendMessage(targetId, `🎁 *${amount} credits* added!\n\nNew balance: *${user.credits + amount}*`, { parse_mode: "Markdown" }); } catch(e) {}
  ctx.reply(`✅ Added *${amount}* credits to *${user.username || targetId}*. New balance: *${user.credits + amount}*`, { parse_mode: "Markdown" });
});

bot.command("setcredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /setcredits [telegram_id] [amount]");
  const targetId = parts[1]; const amount = parseInt(parts[2]);
  if (isNaN(amount)) return ctx.reply("Invalid amount.");
  const { data: user } = await supabase.from("users").select("username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  await supabase.from("users").update({ credits: amount }).eq("telegram_id", targetId);
  ctx.reply(`✅ Set *${user.username || targetId}* credits to *${amount}*`, { parse_mode: "Markdown" });
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { count: userCount } = await supabase.from("users").select("*", { count: "exact", head: true });
  const { count: genCount } = await supabase.from("generations").select("*", { count: "exact", head: true });
  const { count: txnCount } = await supabase.from("transactions").select("*", { count: "exact", head: true });
  const { data: txns } = await supabase.from("transactions").select("amount_paid");
  const revenue = txns ? txns.reduce((sum, t) => sum + (t.amount_paid || 0), 0) / 100 : 0;
  const { count: subCount } = await supabase.from("users").select("*", { count: "exact", head: true }).eq("subscription_active", true);
  ctx.reply(`📊 *Bot Stats*\n\n👥 Users: *${userCount}*\n🎨 Generations: *${genCount}*\n💳 Transactions: *${txnCount}*\n⭐ Subscribers: *${subCount}*\n💰 Revenue: *$${revenue.toFixed(2)}*`, { parse_mode: "Markdown" });
});

bot.command("listusers", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: users } = await supabase.from("users").select("telegram_id, username, credits, subscription_active").order("created_at", { ascending: false }).limit(10);
  if (!users || users.length === 0) return ctx.reply("No users yet.");
  const list = users.map(u => `• ${u.username || "unknown"} (${u.telegram_id}) — ${u.credits} cr ${u.subscription_active ? "⭐" : ""}`).join("\n");
  ctx.reply(`👥 *Recent Users*\n\n${list}`, { parse_mode: "Markdown" });
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { telegram_id, credits, type } = session.metadata;
    if (type === "credits") {
      const { data: user } = await supabase.from("users").select("credits").eq("telegram_id", telegram_id).single();
      await supabase.from("users").update({ credits: user.credits + parseInt(credits) }).eq("telegram_id", telegram_id);
      await supabase.from("transactions").insert({ telegram_id, type: "credit_purchase", credits: parseInt(credits), stripe_session_id: session.id, amount_paid: session.amount_total });
      try { await bot.telegram.sendMessage(telegram_id, `✅ *${credits} credits* added to your account!\n\nUse /balance to check.`, { parse_mode: "Markdown" }); } catch(e) {}
    }
    if (type === "subscription") {
      const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 30);
      await supabase.from("users").update({ subscription_active: true, subscription_expires_at: expiresAt.toISOString(), stripe_subscription_id: session.subscription }).eq("telegram_id", telegram_id);
      await supabase.from("transactions").insert({ telegram_id, type: "subscription", stripe_session_id: session.id, amount_paid: session.amount_total });
      try { await bot.telegram.sendMessage(telegram_id, `⭐ *Subscription activated!*\n\nYou now have unlimited access for 30 days.`, { parse_mode: "Markdown" }); } catch(e) {}
    }
  }
  if (event.type === "customer.subscription.deleted") {
    await supabase.from("users").update({ subscription_active: false, subscription_expires_at: null }).eq("stripe_subscription_id", event.data.object.id);
  }
  res.json({ received: true });
});

app.use(express.json());

app.get("/payment-success", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:white"><h1>✅</h1><h2>Payment Successful!</h2><p>Return to Telegram and use /balance to check.</p></body></html>`);
});

app.get("/payment-cancel", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:white"><h1>❌</h1><h2>Payment Cancelled</h2><p>No charge was made.</p></body></html>`);
});

// ── LAUNCH ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram";

app.post(WEBHOOK_PATH, express.json(), (req, res) => bot.handleUpdate(req.body, res));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 Bot running on webhook`);
});