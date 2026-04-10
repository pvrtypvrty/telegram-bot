// ============================================================
// TELEGRAM IMAGE BOT — FINAL VERSION
// ============================================================
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const Replicate = require("replicate");
const Stripe = require("stripe");

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
  try { await supabase.from("generations").insert({ telegram_id: telegramId, prompt, image_url: url }); } catch(e) {}
}

function autoDelete(chatId, messageId) {
  setTimeout(async () => {
    try { await bot.telegram.deleteMessage(chatId, messageId); } catch(e) {}
  }, 60 * 60 * 1000);
}

function getUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output[0]) {
    if (typeof output[0].url === 'function') return output[0].url();
    if (typeof output[0] === 'string') return output[0];
  }
  return null;
}

function isAdmin(ctx) { return ctx.from.id.toString() === ADMIN_ID; }
function isSub(userData) {
  return userData?.subscription_active && new Date(userData.subscription_expires_at) > new Date();
}

// ── CLAUDE PROMPT ENHANCER ────────────────────────────────────
async function enhancePrompt(userPrompt, type = "image") {
  try {
    const systemPrompt = type === "image"
      ? `You are a professional AI image prompt engineer. Take the user's prompt and enhance it into a detailed, cinematic prompt for image generation. Add lighting details, style, mood, camera angle, and quality descriptors. Keep it under 200 words. Return ONLY the enhanced prompt, nothing else.`
      : `You are a professional AI video prompt engineer. Take the user's prompt and enhance it into a detailed cinematic video prompt. Add camera movement, lighting, motion details, atmosphere, and style. Keep it under 150 words. Return ONLY the enhanced prompt, nothing else.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text?.trim() || userPrompt;
  } catch(e) {
    console.error("Prompt enhance error:", e.message);
    return userPrompt; // fallback to original
  }
}

// ── PARSE JSON OR TEXT PROMPT ─────────────────────────────────
function parsePrompt(input) {
  try {
    // Try to parse as JSON
    const cleaned = input.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    // Support common JSON prompt formats
    return parsed.prompt || parsed.description || parsed.text || parsed.content || input;
  } catch(e) {
    return input; // plain text prompt
  }
}

// ── VIDEO GENERATION (non-blocking) ──────────────────────────
async function generateVideo(chatId, telegramId, prompt, startImageUrl, subActive, creditsLeft) {
  try {
    const input = {
      prompt,
      duration: 10,
      aspect_ratio: "9:16",
      mode: "pro",
    };
    if (startImageUrl) input.start_image = startImageUrl;

    const prediction = await replicate.predictions.create({
      model: "kwaivgi/kling-v2.1",
      input
    });

    let result = prediction;
    let attempts = 0;
    while (result.status !== "succeeded" && result.status !== "failed" && result.status !== "canceled") {
      await new Promise(r => setTimeout(r, 10000));
      result = await replicate.predictions.get(prediction.id);
      attempts++;
      if (attempts > 60) throw new Error("Timed out after 10 minutes");
    }

    if (result.status !== "succeeded") throw new Error("Video failed: " + result.status);

    const videoUrl = getUrl(result.output);
    if (!videoUrl) throw new Error("No video URL returned");

    await logGeneration(telegramId, `[VIDEO] ${prompt}`, videoUrl);

    const msg = await bot.telegram.sendVideo(chatId, { url: videoUrl }, {
      caption: `🎬 *Video Done!*\n\n📝 _${prompt.substring(0, 100)}..._\n` +
        (subActive ? `⭐ Unlimited\n` : `💳 Credits left: *${creditsLeft}*\n`) +
        `\n⏱ _Deletes in 1 hour_`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "🔄 Another Video", callback_data: "video_help" },
         { text: "🎨 Generate Image", callback_data: "generate_help" }]
      ]}
    });
    autoDelete(chatId, msg.message_id);

  } catch (err) {
    console.error("Video error:", err.message);
    if (!subActive) await refundCredits(telegramId, COST_PER_VIDEO);
    try { await bot.telegram.sendMessage(chatId, "❌ Video failed. Credits refunded. Try again!"); } catch(e) {}
  }
}

// ── /start ────────────────────────────────────────────────────
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
    `🎨 Generate image — ${COST_PER_IMAGE} credits\n` +
    `✏️ Edit image — ${COST_PER_EDIT} credits\n` +
    `🎬 Generate video — ${COST_PER_VIDEO} credits\n\n` +
    `/generate [prompt] — Create an image\n` +
    `/edit — Edit your image\n` +
    `/video [prompt] — Create a video\n` +
    `/buy — Purchase credits\n` +
    `/subscribe — Unlimited monthly\n` +
    `/referral — Earn free credits\n` +
    `/balance — Check credits\n\n` +
    `💡 _Tip: You can use plain text or JSON prompts!_`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🎨 Generate Image", "generate_help"), Markup.button.callback("🎬 Generate Video", "video_help")],
      [Markup.button.callback("✏️ Edit My Image", "edit_help"), Markup.button.callback("💰 Buy Credits", "buy_menu")],
    ])}
  );
});

// ── /balance ──────────────────────────────────────────────────
bot.command("balance", async (ctx) => {
  const data = await getCredits(ctx.from.id.toString());
  if (!data) return ctx.reply("Use /start first.");
  const subStatus = isSub(data)
    ? `✅ Active (expires ${new Date(data.subscription_expires_at).toLocaleDateString()})`
    : "❌ None";
  ctx.reply(
    `💳 *Your Account*\n\nCredits: *${data.credits}*\nSubscription: ${subStatus}\n\n` +
    `🎨 Image: ${COST_PER_IMAGE} cr | ✏️ Edit: ${COST_PER_EDIT} cr | 🎬 Video: ${COST_PER_VIDEO} cr`,
    { parse_mode: "Markdown" }
  );
});

// ── /generate ─────────────────────────────────────────────────
bot.command("generate", async (ctx) => {
  const rawInput = ctx.message.text.replace("/generate", "").trim();
  if (!rawInput) return ctx.reply(
    "Provide a prompt!\n\nExamples:\n`/generate a futuristic city at night`\n\nOr JSON:\n`/generate {\"prompt\": \"cinematic portrait\", \"style\": \"neon\"}`",
    { parse_mode: "Markdown" }
  );

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");
  const sub = isSub(userData);
  if (!sub && userData.credits < COST_PER_IMAGE) return ctx.reply(`❌ Need *${COST_PER_IMAGE}* credits. You have *${userData.credits}*. Use /buy.`, { parse_mode: "Markdown" });

  const thinkingMsg = await ctx.reply("✨ Enhancing your prompt with AI... then generating!");

  try {
    if (!sub) await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);

    // Parse JSON or text prompt
    const basePrompt = parsePrompt(rawInput);

    // Enhance with Claude
    const enhancedPrompt = await enhancePrompt(basePrompt, "image");

    const output = await replicate.run("google/nano-banana-pro", {
      input: {
        prompt: enhancedPrompt,
        aspect_ratio: "9:16",
        output_format: "jpg",
      }
    });

    const imageUrl = getUrl(output);
    await logGeneration(ctx.from.id.toString(), enhancedPrompt, imageUrl);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

    const newCredits = sub ? userData.credits : userData.credits - COST_PER_IMAGE;
    const msg = await ctx.replyWithPhoto({ url: imageUrl }, {
      caption: `✅ *Done!*\n\n📝 _${basePrompt.substring(0, 80)}_\n` +
        (sub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) +
        `\n⏱ _Deletes in 1 hour_`,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Generate Another", "generate_help"), Markup.button.callback("✏️ Edit This", "edit_help")],
        [Markup.button.callback("🎬 Turn into Video", "video_help")],
      ]),
    });
    autoDelete(ctx.chat.id, msg.message_id);

  } catch (err) {
    console.error("Generate error:", err.message);
    if (!sub) await refundCredits(ctx.from.id.toString(), COST_PER_IMAGE);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    ctx.reply("❌ Generation failed. Credits refunded. Try again!");
  }
});

// ── /video ────────────────────────────────────────────────────
bot.command("video", async (ctx) => {
  const rawInput = ctx.message.text.replace("/video", "").trim();
  if (!rawInput) return ctx.reply(
    `🎬 *Generate a Video*\n\nCosts *${COST_PER_VIDEO} credits*.\n\n` +
    `Usage: \`/video your prompt\`\n\nOr JSON: \`/video {"prompt": "waves at sunset", "style": "cinematic"}\`\n\n` +
    `Or send any photo to animate it!\n\n⏱ ~3-5 min | 📹 1080p 10s`,
    { parse_mode: "Markdown" }
  );

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");
  const sub = isSub(userData);
  if (!sub && userData.credits < COST_PER_VIDEO) return ctx.reply(`❌ Need *${COST_PER_VIDEO}* credits. You have *${userData.credits}*. Use /buy.`, { parse_mode: "Markdown" });

  if (!sub) await deductCredits(ctx.from.id.toString(), COST_PER_VIDEO);
  const newCredits = sub ? userData.credits : userData.credits - COST_PER_VIDEO;

  const basePrompt = parsePrompt(rawInput);
  const enhancedPrompt = await enhancePrompt(basePrompt, "video");

  await ctx.reply(
    `🎬 Generating your video...\n\n⏱ *3-5 minutes* — I'll send it when ready!\n\nFeel free to use other commands.`,
    { parse_mode: "Markdown" }
  );
  generateVideo(ctx.chat.id, ctx.from.id.toString(), enhancedPrompt, null, sub, newCredits);
});

// ── /edit ─────────────────────────────────────────────────────
bot.command("edit", async (ctx) => {
  ctx.reply(
    `✏️ *Edit Your Image*\n\nCosts *${COST_PER_EDIT} credits*.\n\n` +
    `Send me any photo and I'll ask what to change!\n\n` +
    `Examples: make cinematic, change background, anime style, neon lights`,
    { parse_mode: "Markdown" }
  );
});

bot.action("edit_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`✏️ Send me any photo to edit! Costs *${COST_PER_EDIT} credits*.`, { parse_mode: "Markdown" }); });
bot.action("video_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`🎬 Type \`/video your prompt\` or send a photo!\n\nCosts *${COST_PER_VIDEO} credits*.`, { parse_mode: "Markdown" }); });
bot.action("generate_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply("🎨 Type:\n`/generate your prompt here`", { parse_mode: "Markdown" }); });

// ── HANDLE PHOTO UPLOADS ──────────────────────────────────────
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
  const sub = isSub(userData);
  if (!sub && (!userData || userData.credits < COST_PER_EDIT)) return ctx.reply(`❌ Need *${COST_PER_EDIT}* credits.`, { parse_mode: "Markdown" });
  pendingEdits.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingEdits.delete(telegramId), 10 * 60 * 1000);
  ctx.reply(`✏️ What should I do?\n\nExamples:\n• make this cinematic\n• change background to beach\n• anime style\n• add neon lights\n• oil painting`, { parse_mode: "Markdown" });
});

bot.action("choose_video", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  if (!pendingPhotos.has(telegramId)) return ctx.reply("Photo expired. Send your image again.");
  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);
  const userData = await getCredits(telegramId);
  const sub = isSub(userData);
  if (!sub && (!userData || userData.credits < COST_PER_VIDEO)) return ctx.reply(`❌ Need *${COST_PER_VIDEO}* credits.`, { parse_mode: "Markdown" });
  pendingVideos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingVideos.delete(telegramId), 10 * 60 * 1000);
  ctx.reply(`🎬 How should I animate this?\n\nExamples:\n• slow cinematic zoom in\n• person starts walking\n• waves moving in background\n• camera pans right\n• wind blowing through scene`, { parse_mode: "Markdown" });
});

// ── HANDLE TEXT ───────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id.toString();

  if (pendingEdits.has(telegramId)) {
    const { fileId } = pendingEdits.get(telegramId);
    const editPrompt = parsePrompt(ctx.message.text);
    pendingEdits.delete(telegramId);
    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const sub = isSub(userData);
    if (!sub && userData.credits < COST_PER_EDIT) return ctx.reply(`❌ Not enough credits.`);
    const thinkingMsg = await ctx.reply("✏️ Editing... ~30 seconds");
    try {
      if (!sub) await deductCredits(telegramId, COST_PER_EDIT);
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const output = await replicate.run("black-forest-labs/flux-kontext-pro", {
        input: { prompt: editPrompt, input_image: fileLink.href, output_format: "jpg", output_quality: 100, safety_tolerance: 6 }
      });
      const resultUrl = getUrl(output);
      await logGeneration(telegramId, `[EDIT] ${editPrompt}`, resultUrl);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      const newCredits = sub ? userData.credits : userData.credits - COST_PER_EDIT;
      const msg = await ctx.replyWithPhoto({ url: resultUrl }, {
        caption: `✅ *Edit Done!*\n\n✏️ _${editPrompt.substring(0, 80)}_\n` +
          (sub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) +
          `\n⏱ _Deletes in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("✏️ Edit Again", "edit_help"), Markup.button.callback("🎬 Make Video", "video_help")]]),
      });
      autoDelete(ctx.chat.id, msg.message_id);
    } catch (err) {
      console.error("Edit error:", err.message);
      if (!sub) await refundCredits(telegramId, COST_PER_EDIT);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      ctx.reply("❌ Edit failed. Credits refunded.");
    }
    return;
  }

  if (pendingVideos.has(telegramId)) {
    const { fileId } = pendingVideos.get(telegramId);
    const videoPrompt = parsePrompt(ctx.message.text);
    pendingVideos.delete(telegramId);
    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const sub = isSub(userData);
    if (!sub && userData.credits < COST_PER_VIDEO) return ctx.reply(`❌ Not enough credits.`);
    if (!sub) await deductCredits(telegramId, COST_PER_VIDEO);
    const newCredits = sub ? userData.credits : userData.credits - COST_PER_VIDEO;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const enhancedPrompt = await enhancePrompt(videoPrompt, "video");
    await ctx.reply("🎬 Animating your image...\n\n⏱ *3-5 minutes* — I'll send it when ready!", { parse_mode: "Markdown" });
    generateVideo(ctx.chat.id, telegramId, enhancedPrompt, fileLink.href, sub, newCredits);
    return;
  }
});

// ── /referral ─────────────────────────────────────────────────
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

// ── /buy ──────────────────────────────────────────────────────
bot.command("buy", async (ctx) => { await showBuyMenu(ctx); });
bot.action("buy_menu", async (ctx) => { await ctx.answerCbQuery(); await showBuyMenu(ctx); });
async function showBuyMenu(ctx) {
  await ctx.reply("💰 *Buy Credits*\n\nChoose a package:", {
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
        payment_method_types: ["card"],
        line_items: [{ price: priceMap[credits], quantity: 1 }],
        mode: "payment",
        success_url: `${process.env.WEBHOOK_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.WEBHOOK_URL}/payment-cancel`,
        metadata: { telegram_id: ctx.from.id.toString(), credits, type: "credits" },
      });
      await ctx.reply(`💳 *Complete your purchase*\n\n${credits} credits`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.url("💳 Pay Now", session.url)]])
      });
    } catch (err) { console.error(err); ctx.reply("❌ Error: " + err.message); }
  });
});

// ── /subscribe ────────────────────────────────────────────────
bot.command("subscribe", async (ctx) => { await showSubscribeMenu(ctx); });
bot.action("subscribe_menu", async (ctx) => { await ctx.answerCbQuery(); await showSubscribeMenu(ctx); });
async function showSubscribeMenu(ctx) {
  await ctx.reply(
    "⭐ *Monthly Subscription*\n\nUnlimited images, edits & videos.\n\n• Unlimited everything\n• Cancel anytime\n\n*$14.99 / month*",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⭐ Subscribe Now — $14.99/mo", "start_subscribe")]]) }
  );
}
bot.action("start_subscribe", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_SUB, quantity: 1 }],
      mode: "subscription",
      success_url: `${process.env.WEBHOOK_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEBHOOK_URL}/payment-cancel`,
      metadata: { telegram_id: ctx.from.id.toString(), type: "subscription" },
    });
    await ctx.reply("⭐ *Subscribe for unlimited access*", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.url("⭐ Subscribe Now", session.url)]])
    });
  } catch (err) { ctx.reply("❌ Error. Try again."); }
});

// ── /help ─────────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  ctx.reply(
    `📖 *Commands*\n\n` +
    `/generate [prompt] — Image (${COST_PER_IMAGE} cr)\n` +
    `/edit — Edit image (${COST_PER_EDIT} cr)\n` +
    `/video [prompt] — Video (${COST_PER_VIDEO} cr)\n` +
    `/balance — Check credits\n` +
    `/referral — Earn free credits\n` +
    `/buy — Purchase credits\n` +
    `/subscribe — Unlimited monthly\n` +
    `/help — This menu\n\n` +
    `💡 _Supports plain text AND JSON prompts_`,
    { parse_mode: "Markdown" }
  );
});

// ── ADMIN COMMANDS ────────────────────────────────────────────
bot.command("adminhelp", async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `🔧 *Admin Commands*\n\n` +
    `/stats — Bot overview\n` +
    `/listusers — Recent 15 users\n` +
    `/user [id] — User details\n` +
    `/addcredits [id] [amount] — Add credits\n` +
    `/removecredits [id] [amount] — Remove credits\n` +
    `/setcredits [id] [amount] — Set exact credits\n` +
    `/broadcast [message] — Message all users`,
    { parse_mode: "Markdown" }
  );
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const [
      { count: userCount },
      { count: genCount },
      { count: txnCount },
      { count: subCount },
      { data: txns },
    ] = await Promise.all([
      supabase.from("users").select("*", { count: "exact", head: true }),
      supabase.from("generations").select("*", { count: "exact", head: true }),
      supabase.from("transactions").select("*", { count: "exact", head: true }),
      supabase.from("users").select("*", { count: "exact", head: true }).eq("subscription_active", true),
      supabase.from("transactions").select("amount_paid"),
    ]);
    const revenue = txns ? txns.reduce((sum, t) => sum + (t.amount_paid || 0), 0) / 100 : 0;
    const today = new Date(); today.setHours(0,0,0,0);
    const { count: newToday } = await supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", today.toISOString());
    await ctx.reply(
      `📊 *Bot Stats*\n\n` +
      `👥 Total users: *${userCount || 0}* (+${newToday || 0} today)\n` +
      `🎨 Total generations: *${genCount || 0}*\n` +
      `💳 Total transactions: *${txnCount || 0}*\n` +
      `⭐ Active subscribers: *${subCount || 0}*\n` +
      `💰 Total revenue: *$${revenue.toFixed(2)}*\n` +
      `📈 MRR: *$${((subCount || 0) * 14.99).toFixed(2)}*`,
      { parse_mode: "Markdown" }
    );
  } catch(err) {
    console.error("Stats error:", err);
    ctx.reply("❌ Error fetching stats: " + err.message);
  }
});

bot.command("addcredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /addcredits [telegram_id] [amount]");
  const targetId = parts[1];
  const amount = parseInt(parts[2]);
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Invalid amount.");
  const { data: user } = await supabase.from("users").select("credits, username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  const newBalance = user.credits + amount;
  await supabase.from("users").update({ credits: newBalance }).eq("telegram_id", targetId);
  try { await bot.telegram.sendMessage(targetId, `🎁 *${amount} credits* added!\n\nNew balance: *${newBalance}*`, { parse_mode: "Markdown" }); } catch(e) {}
  ctx.reply(`✅ Added *${amount}* credits to *${user.username || targetId}*\nNew balance: *${newBalance}*`, { parse_mode: "Markdown" });
});

bot.command("removecredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /removecredits [telegram_id] [amount]");
  const targetId = parts[1];
  const amount = parseInt(parts[2]);
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Invalid amount.");
  const { data: user } = await supabase.from("users").select("credits, username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  const newBalance = Math.max(0, user.credits - amount);
  await supabase.from("users").update({ credits: newBalance }).eq("telegram_id", targetId);
  ctx.reply(`✅ Removed *${amount}* credits from *${user.username || targetId}*\nNew balance: *${newBalance}*`, { parse_mode: "Markdown" });
});

bot.command("setcredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /setcredits [telegram_id] [amount]");
  const targetId = parts[1];
  const amount = parseInt(parts[2]);
  if (isNaN(amount) || amount < 0) return ctx.reply("❌ Invalid amount.");
  const { data: user } = await supabase.from("users").select("username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  await supabase.from("users").update({ credits: amount }).eq("telegram_id", targetId);
  ctx.reply(`✅ Set *${user.username || targetId}* credits to *${amount}*`, { parse_mode: "Markdown" });
});

bot.command("listusers", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: users } = await supabase.from("users")
    .select("telegram_id, username, credits, subscription_active, created_at")
    .order("created_at", { ascending: false }).limit(15);
  if (!users || users.length === 0) return ctx.reply("No users yet.");
  const list = users.map(u =>
    `• *${u.username || "unknown"}* (${u.telegram_id}) — ${u.credits} cr ${u.subscription_active ? "⭐" : ""}`
  ).join("\n");
  ctx.reply(`👥 *Recent Users*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.command("user", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 2) return ctx.reply("Usage: /user [telegram_id]");
  const targetId = parts[1];
  const { data: user } = await supabase.from("users").select("*").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  const { count: genCount } = await supabase.from("generations").select("*", { count: "exact", head: true }).eq("telegram_id", targetId);
  ctx.reply(
    `👤 *User Info*\n\n` +
    `Username: *${user.username || "unknown"}*\n` +
    `ID: \`${user.telegram_id}\`\n` +
    `Credits: *${user.credits}*\n` +
    `Subscriber: *${user.subscription_active ? "Yes ⭐" : "No"}*\n` +
    `Generations: *${genCount || 0}*\n` +
    `Joined: *${new Date(user.created_at).toLocaleDateString()}*`,
    { parse_mode: "Markdown" }
  );
});

bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const message = ctx.message.text.replace("/broadcast", "").trim();
  if (!message) return ctx.reply("Usage: /broadcast your message here");
  const { data: users } = await supabase.from("users").select("telegram_id");
  if (!users || users.length === 0) return ctx.reply("No users to broadcast to.");
  let sent = 0; let failed = 0;
  await ctx.reply(`📢 Broadcasting to ${users.length} users...`);
  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegram_id, `📢 *Announcement*\n\n${message}`, { parse_mode: "Markdown" });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  ctx.reply(`✅ Done!\n\n✓ Sent: *${sent}*\n✗ Failed: *${failed}*`, { parse_mode: "Markdown" });
});

// ── LAUNCH ────────────────────────────────────────────────────
bot.launch();
console.log("🤖 Bot running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
