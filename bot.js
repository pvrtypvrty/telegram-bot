// ============================================================
// PvrtyXbot — FINAL VERSION
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
const BOT_NAME = "PvrtyXbot";
const WELCOME_IMAGE = "https://i.imgur.com/placeholder.jpg"; // will be set via bot photo

const TERMS_TEXT = `━━━━━━━━━━━━━━━━━━━━
*${BOT_NAME} — TERMS OF SERVICE*

*1. AGE REQUIREMENT*
You must be at least 18 years old to use this service. By using this bot, you confirm that you are of legal age in your jurisdiction.

*2. CONTENT RESPONSIBILITY*
You are solely responsible for images you upload and generate. You confirm that:
• You own or have authorization to use any image you upload
• You will NOT upload images of real people without their explicit consent
• You will NOT upload images of minors under any circumstances
• You will NOT use this service for revenge porn or non-consensual content
• You will NOT upload images of public figures or celebrities

*3. PROHIBITED CONTENT*
The following is strictly prohibited and will result in immediate termination without refund:
• Images depicting or involving minors
• Non-consensual intimate imagery
• Content involving real people without consent
• Images of public figures or celebrities
• Content promoting violence, hatred, or illegal activities

*4. AI-GENERATED CONTENT*
All images are AI-generated. You acknowledge that:
• Generated images are synthetic and do not depict real events
• You will not misrepresent AI-generated content as real photographs
• You are responsible for how you use and distribute generated content

*5. DATA & PRIVACY*
• Images are stored on encrypted servers for maximum 7 days then auto-deleted
• We do not share or sell your images to third parties
• Your Telegram ID and username are stored for account management only

*6. CREDITS, PAYMENTS & REFUNDS*
• All purchases are final and non-refundable
• Credits do not expire
• Failed generations due to technical errors are automatically refunded
• We reserve the right to modify pricing with prior notice

*7. ACCOUNT TERMINATION*
We reserve the right to ban accounts that violate these Terms. Banned accounts forfeit all remaining credits without refund.

*8. LIMITATION OF LIABILITY*
${BOT_NAME} and its operators are not liable for any damages arising from use of this service. You use this service at your own risk.

━━━━━━━━━━━━━━━━━━━━
By clicking *I Agree*, you confirm you have read and agree to these Terms of Service.`;

const pendingPhotos = new Map();
const pendingEdits = new Map();
const pendingVideos = new Map();
const pendingReferences = new Map();  // collecting reference images
const pendingRefPrompt = new Map();   // waiting for prompt after references collected

// ── HELPERS ──────────────────────────────────────────────────
async function getOrCreateUser(telegramId, username, referredBy = null) {
  const { data: existing } = await supabase.from("users").select("*").eq("telegram_id", telegramId).single();
  if (existing) return existing;
  const startCredits = referredBy ? 10 + REFERRAL_BONUS : 10;
  const { data: newUser } = await supabase.from("users")
    .insert({ telegram_id: telegramId, username, credits: startCredits, referred_by: referredBy || null, terms_accepted: false })
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
    .select("credits, subscription_active, subscription_expires_at, terms_accepted").eq("telegram_id", telegramId).single();
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

async function requireTerms(ctx) {
  const userData = await getCredits(ctx.from.id.toString());
  if (!userData || !userData.terms_accepted) {
    await showTerms(ctx);
    return false;
  }
  return true;
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
    return userPrompt;
  }
}

function parsePrompt(input) {
  try {
    const cleaned = input.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed.prompt || parsed.description || parsed.text || parsed.content || input;
  } catch(e) {
    return input;
  }
}

// ── SHOW TERMS ────────────────────────────────────────────────
async function showTerms(ctx) {
  await ctx.reply(
    `👋 *Welcome to ${BOT_NAME}!*\n\nPlease read and accept our Terms & Conditions to continue:\n\n${TERMS_TEXT}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ I Agree", "terms_agree")],
        [Markup.button.callback("❌ I Decline", "terms_decline")],
      ])
    }
  );
}

// ── SHOW MAIN MENU ────────────────────────────────────────────
async function showMainMenu(ctx, user) {
  const welcomeText =
    `✨ *Welcome to ${BOT_NAME}!*\n\n` +
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
    `💡 _Supports plain text & JSON prompts_`;

  try {
    // Try to send with the PvrtyXbot logo
    await ctx.replyWithPhoto(
      { url: "https://i.imgur.com/yXOvdOSm.png" }, // placeholder - replace with actual image URL
      {
        caption: welcomeText,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🎨 Generate Image", "generate_help"), Markup.button.callback("🎬 Generate Video", "video_help")],
          [Markup.button.callback("✏️ Edit My Image", "edit_help"), Markup.button.callback("💰 Buy Credits", "buy_menu")],
        ])
      }
    );
  } catch(e) {
    // Fallback to text only if image fails
    await ctx.reply(welcomeText, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎨 Generate Image", "generate_help"), Markup.button.callback("🎬 Generate Video", "video_help")],
        [Markup.button.callback("✏️ Edit My Image", "edit_help"), Markup.button.callback("💰 Buy Credits", "buy_menu")],
      ])
    });
  }
}

// ── TERMS ACTIONS ─────────────────────────────────────────────
bot.action("terms_agree", async (ctx) => {
  await ctx.answerCbQuery("✅ Terms accepted!");
  const telegramId = ctx.from.id.toString();
  await supabase.from("users").update({
    terms_accepted: true,
    terms_accepted_at: new Date().toISOString()
  }).eq("telegram_id", telegramId);

  const userData = await getCredits(telegramId);
  await ctx.reply(`✅ *Terms accepted!* Welcome to ${BOT_NAME}! 🎉`, { parse_mode: "Markdown" });
  await showMainMenu(ctx, userData);
});

bot.action("terms_decline", async (ctx) => {
  await ctx.answerCbQuery("❌ Terms declined");
  await ctx.reply(
    `❌ *Terms Declined*\n\nYou must accept the Terms of Service to use ${BOT_NAME}.\n\nIf you change your mind, use /start to try again.`,
    { parse_mode: "Markdown" }
  );
});

// ── /start ────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  let referredBy = null;
  if (payload && payload.startsWith("ref_")) {
    referredBy = payload.replace("ref_", "");
    if (referredBy === ctx.from.id.toString()) referredBy = null;
  }
  const user = await getOrCreateUser(ctx.from.id.toString(), ctx.from.username || ctx.from.first_name, referredBy);

  if (referredBy && user.credits === 10 + REFERRAL_BONUS) {
    // New user via referral - show terms first
  }

  if (!user.terms_accepted) {
    await showTerms(ctx);
    return;
  }

  await showMainMenu(ctx, user);
});

// ── /balance ──────────────────────────────────────────────────
bot.command("balance", async (ctx) => {
  if (!await requireTerms(ctx)) return;
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
  if (!await requireTerms(ctx)) return;
  const rawInput = ctx.message.text.replace("/generate", "").trim();
  if (!rawInput) return ctx.reply(
    "Provide a prompt!\n\nExample:\n`/generate a futuristic city at night`",
    { parse_mode: "Markdown" }
  );
  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");
  const sub = isSub(userData);
  if (!sub && userData.credits < COST_PER_IMAGE) return ctx.reply(`❌ Need *${COST_PER_IMAGE}* credits. You have *${userData.credits}*. Use /buy.`, { parse_mode: "Markdown" });

  const thinkingMsg = await ctx.reply("✨ Enhancing your prompt with AI...");
  try {
    if (!sub) await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);
    const basePrompt = parsePrompt(rawInput);
    const enhancedPrompt = await enhancePrompt(basePrompt, "image");

    const output = await replicate.run("google/nano-banana-pro", {
      input: { prompt: enhancedPrompt, aspect_ratio: "9:16", output_format: "jpg" }
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
  if (!await requireTerms(ctx)) return;
  const rawInput = ctx.message.text.replace("/video", "").trim();
  if (!rawInput) return ctx.reply(
    `🎬 *Generate a Video*\n\nCosts *${COST_PER_VIDEO} credits*.\n\nUsage: \`/video your prompt\`\n\nOr send any photo to animate it!\n\n⏱ ~3-5 min | 📹 1080p 10s`,
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
  await ctx.reply(`🎬 Generating your video...\n\n⏱ *3-5 minutes* — I'll send it when ready!`, { parse_mode: "Markdown" });
  generateVideo(ctx.chat.id, ctx.from.id.toString(), enhancedPrompt, null, sub, newCredits);
});

// ── VIDEO GENERATION (non-blocking) ──────────────────────────
async function generateVideo(chatId, telegramId, prompt, startImageUrl, subActive, creditsLeft) {
  try {
    const input = { prompt, duration: 10, aspect_ratio: "9:16", mode: "pro" };
    if (startImageUrl) input.start_image = startImageUrl;

    const prediction = await replicate.predictions.create({ model: "kwaivgi/kling-v2.1", input });

    let result = prediction;
    let attempts = 0;
    while (result.status !== "succeeded" && result.status !== "failed" && result.status !== "canceled") {
      await new Promise(r => setTimeout(r, 10000));
      result = await replicate.predictions.get(prediction.id);
      if (++attempts > 60) throw new Error("Timed out");
    }
    if (result.status !== "succeeded") throw new Error("Video failed: " + result.status);

    const videoUrl = getUrl(result.output);
    if (!videoUrl) throw new Error("No video URL");

    await logGeneration(telegramId, `[VIDEO] ${prompt}`, videoUrl);
    const msg = await bot.telegram.sendVideo(chatId, { url: videoUrl }, {
      caption: `🎬 *Video Done!*\n\n` + (subActive ? `⭐ Unlimited\n` : `💳 Credits left: *${creditsLeft}*\n`) + `\n⏱ _Deletes in 1 hour_`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔄 Another Video", callback_data: "video_help" }, { text: "🎨 Generate Image", callback_data: "generate_help" }]] }
    });
    autoDelete(chatId, msg.message_id);
  } catch (err) {
    console.error("Video error:", err.message);
    if (!subActive) await refundCredits(telegramId, COST_PER_VIDEO);
    try { await bot.telegram.sendMessage(chatId, "❌ Video failed. Credits refunded. Try again!"); } catch(e) {}
  }
}

// ── /edit ─────────────────────────────────────────────────────
bot.command("edit", async (ctx) => {
  if (!await requireTerms(ctx)) return;
  ctx.reply(`✏️ *Edit Your Image*\n\nCosts *${COST_PER_EDIT} credits*.\n\nSend me any photo and I'll ask what to change!`, { parse_mode: "Markdown" });
});

bot.action("edit_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`✏️ Send me any photo to edit! Costs *${COST_PER_EDIT} credits*.`, { parse_mode: "Markdown" }); });
bot.action("video_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply(`🎬 Type \`/video your prompt\` or send a photo!\n\nCosts *${COST_PER_VIDEO} credits*.`, { parse_mode: "Markdown" }); });
bot.action("generate_help", async (ctx) => { await ctx.answerCbQuery(); ctx.reply("🎨 Type:\n`/generate your prompt here`", { parse_mode: "Markdown" }); });

// ── HANDLE PHOTO UPLOADS ──────────────────────────────────────
bot.on("photo", async (ctx) => {
  if (!await requireTerms(ctx)) return;
  const telegramId = ctx.from.id.toString();
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  // If user is in reference collection mode, add to their collection
  if (pendingReferences.has(telegramId)) {
    const refs = pendingReferences.get(telegramId);
    refs.fileIds.push(fileId);
    pendingReferences.set(telegramId, refs);
    await ctx.reply(
      `📸 *Reference ${refs.fileIds.length} added!*\n\nSend more photos or tap *Generate* when ready.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Generate from ${refs.fileIds.length} reference(s)`, "ref_done")],
          [Markup.button.callback("❌ Cancel", "ref_cancel")],
        ])
      }
    );
    return;
  }

  // Normal photo — show options
  pendingPhotos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingPhotos.delete(telegramId), 10 * 60 * 1000);
  await ctx.reply(`📸 *Image received!*\n\nWhat do you want to do?`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`✏️ Edit it (${COST_PER_EDIT} credits)`, "choose_edit")],
      [Markup.button.callback(`🎨 Use as Reference (${COST_PER_IMAGE} credits)`, "choose_reference")],
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
  ctx.reply(`✏️ What should I do?\n\nExamples:\n• make this cinematic\n• change background to beach\n• anime style\n• add neon lights`, { parse_mode: "Markdown" });
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
  ctx.reply(`🎬 How should I animate this?\n\nExamples:\n• slow cinematic zoom in\n• person starts walking\n• waves moving\n• camera pans right`, { parse_mode: "Markdown" });
});

// ── REFERENCE IMAGE ACTIONS ───────────────────────────────────
bot.action("choose_reference", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  if (!pendingPhotos.has(telegramId)) return ctx.reply("Photo expired. Send your image again.");
  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);
  pendingReferences.set(telegramId, { fileIds: [fileId], timestamp: Date.now() });
  setTimeout(() => pendingReferences.delete(telegramId), 15 * 60 * 1000);
  ctx.reply(
    `🎨 *Reference Mode — 1 photo added!*\n\nSend up to *5 more photos* as additional references, or tap Generate now.\n\nMore references = better blending of styles!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("✅ Generate from 1 reference", "ref_done")],
      [Markup.button.callback("❌ Cancel", "ref_cancel")],
    ])}
  );
});

bot.action("ref_done", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  if (!pendingReferences.has(telegramId)) return ctx.reply("Session expired. Please start again.");
  const { fileIds } = pendingReferences.get(telegramId);
  const userData = await getCredits(telegramId);
  const sub = isSub(userData);
  if (!sub && (!userData || userData.credits < COST_PER_IMAGE)) {
    pendingReferences.delete(telegramId);
    return ctx.reply(`❌ Need *${COST_PER_IMAGE}* credits.`, { parse_mode: "Markdown" });
  }
  pendingRefPrompt.set(telegramId, { fileIds, timestamp: Date.now() });
  pendingReferences.delete(telegramId);
  setTimeout(() => pendingRefPrompt.delete(telegramId), 10 * 60 * 1000);
  ctx.reply(
    `✨ *${fileIds.length} reference(s) ready!*\n\nDescribe what you want to generate:\n\n• "cinematic portrait in this style"\n• "combine these styles into one image"\n• "similar scene but at night"\n• "fashion photo with this aesthetic"`,
    { parse_mode: "Markdown" }
  );
});

bot.action("ref_cancel", async (ctx) => {
  await ctx.answerCbQuery();
  pendingReferences.delete(ctx.from.id.toString());
  pendingRefPrompt.delete(ctx.from.id.toString());
  ctx.reply("❌ Cancelled.");
});

// ── HANDLE TEXT ───────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id.toString();

  // Handle reference prompt
  if (pendingRefPrompt.has(telegramId)) {
    const { fileIds } = pendingRefPrompt.get(telegramId);
    const refPrompt = parsePrompt(ctx.message.text);
    pendingRefPrompt.delete(telegramId);
    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const sub = isSub(userData);
    if (!sub && userData.credits < COST_PER_IMAGE) return ctx.reply(`❌ Not enough credits.`);
    const thinkingMsg = await ctx.reply(`🎨 Generating from ${fileIds.length} reference(s)... ~30 seconds`);
    try {
      if (!sub) await deductCredits(telegramId, COST_PER_IMAGE);
      const enhancedPrompt = await enhancePrompt(refPrompt, "image");

      // Get file links for all references
      const fileLinks = await Promise.all(
        fileIds.map(fid => ctx.telegram.getFileLink(fid).then(l => l.href))
      );

      // Build input with reference images
      const input = {
        prompt: enhancedPrompt,
        aspect_ratio: "9:16",
        output_format: "jpg",
      };

      // Nano Banana Pro supports multiple reference images
      if (fileLinks.length === 1) {
        input.reference_image = fileLinks[0];
      } else {
        input.reference_images = fileLinks.slice(0, 5); // max 5
      }

      const output = await replicate.run("google/nano-banana-pro", { input });
      const imageUrl = getUrl(output);
      await logGeneration(telegramId, `[REF] ${refPrompt}`, imageUrl);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      const newCredits = sub ? userData.credits : userData.credits - COST_PER_IMAGE;
      const msg = await ctx.replyWithPhoto({ url: imageUrl }, {
        caption: `✅ *Generated from ${fileIds.length} reference(s)!*\n\n📝 _${refPrompt.substring(0, 80)}_\n` +
          (sub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) +
          `\n⏱ _Deletes in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Generate Another", "generate_help"), Markup.button.callback("✏️ Edit This", "edit_help")],
        ]),
      });
      autoDelete(ctx.chat.id, msg.message_id);
    } catch (err) {
      console.error("Reference gen error:", err.message);
      if (!sub) await refundCredits(telegramId, COST_PER_IMAGE);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      ctx.reply("❌ Generation failed. Credits refunded.");
    }
    return;
  }

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
        caption: `✅ *Edit Done!*\n\n✏️ _${editPrompt.substring(0, 80)}_\n` + (sub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
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
bot.command("referral", async (ctx) => {
  if (!await requireTerms(ctx)) return;
  await showReferral(ctx);
});
bot.action("show_referral", async (ctx) => { await ctx.answerCbQuery(); await showReferral(ctx); });
async function showReferral(ctx) {
  const telegramId = ctx.from.id.toString();
  const { data: user } = await supabase.from("users").select("referral_count, referral_credits_earned").eq("telegram_id", telegramId).single();
  const botUsername = ctx.botInfo.username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 *Your Referral Link*\n\nEarn *${REFERRAL_REWARD} credits* per person!\n\n🔗 \`${referralLink}\`\n\n📊 Referrals: *${user?.referral_count || 0}* | Earned: *${user?.referral_credits_earned || 0}*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.url("📤 Share", `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(`Join ${BOT_NAME} — AI image & video bot. Get free credits!`)}`)]])  }
  );
}

// ── /buy ──────────────────────────────────────────────────────
bot.command("buy", async (ctx) => {
  if (!await requireTerms(ctx)) return;
  await showBuyMenu(ctx);
});
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
bot.command("subscribe", async (ctx) => {
  if (!await requireTerms(ctx)) return;
  await showSubscribeMenu(ctx);
});
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
    `📖 *${BOT_NAME} Commands*\n\n` +
    `/generate [prompt] — Image (${COST_PER_IMAGE} cr)\n` +
    `/edit — Edit image (${COST_PER_EDIT} cr)\n` +
    `/video [prompt] — Video (${COST_PER_VIDEO} cr)\n` +
    `/balance — Check credits\n` +
    `/referral — Earn free credits\n` +
    `/buy — Purchase credits\n` +
    `/subscribe — Unlimited monthly\n` +
    `/terms — View terms of service\n` +
    `/help — This menu`,
    { parse_mode: "Markdown" }
  );
});

bot.command("terms", async (ctx) => {
  await showTerms(ctx);
});

// ── ADMIN COMMANDS ────────────────────────────────────────────
bot.command("adminhelp", async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `🔧 *Admin Commands*\n\n` +
    `/stats — Bot overview\n` +
    `/listusers — Recent 15 users\n` +
    `/user [id] — User details\n` +
    `/addcredits [id] [amount]\n` +
    `/removecredits [id] [amount]\n` +
    `/setcredits [id] [amount]\n` +
    `/broadcast [message]`,
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
      `📊 *${BOT_NAME} Stats*\n\n` +
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
    ctx.reply("❌ Stats error: " + err.message);
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
  const targetId = parts[1]; const amount = parseInt(parts[2]);
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Invalid amount.");
  const { data: user } = await supabase.from("users").select("credits, username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  const newBalance = Math.max(0, user.credits - amount);
  await supabase.from("users").update({ credits: newBalance }).eq("telegram_id", targetId);
  ctx.reply(`✅ Removed *${amount}* from *${user.username || targetId}*. New balance: *${newBalance}*`, { parse_mode: "Markdown" });
});

bot.command("setcredits", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("Usage: /setcredits [telegram_id] [amount]");
  const targetId = parts[1]; const amount = parseInt(parts[2]);
  if (isNaN(amount) || amount < 0) return ctx.reply("❌ Invalid amount.");
  const { data: user } = await supabase.from("users").select("username").eq("telegram_id", targetId).single();
  if (!user) return ctx.reply(`❌ User ${targetId} not found.`);
  await supabase.from("users").update({ credits: amount }).eq("telegram_id", targetId);
  ctx.reply(`✅ Set *${user.username || targetId}* to *${amount}* credits`, { parse_mode: "Markdown" });
});

bot.command("listusers", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: users } = await supabase.from("users").select("telegram_id, username, credits, subscription_active").order("created_at", { ascending: false }).limit(15);
  if (!users || users.length === 0) return ctx.reply("No users yet.");
  const list = users.map(u => `• *${u.username || "unknown"}* (${u.telegram_id}) — ${u.credits} cr ${u.subscription_active ? "⭐" : ""}`).join("\n");
  ctx.reply(`👥 *Recent Users*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.command("user", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 2) return ctx.reply("Usage: /user [telegram_id]");
  const { data: user } = await supabase.from("users").select("*").eq("telegram_id", parts[1]).single();
  if (!user) return ctx.reply(`❌ User not found.`);
  const { count: genCount } = await supabase.from("generations").select("*", { count: "exact", head: true }).eq("telegram_id", parts[1]);
  ctx.reply(
    `👤 *User Info*\n\nUsername: *${user.username || "unknown"}*\nID: \`${user.telegram_id}\`\nCredits: *${user.credits}*\nSubscriber: *${user.subscription_active ? "Yes ⭐" : "No"}*\nTerms accepted: *${user.terms_accepted ? "Yes" : "No"}*\nGenerations: *${genCount || 0}*\nJoined: *${new Date(user.created_at).toLocaleDateString()}*`,
    { parse_mode: "Markdown" }
  );
});

bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const message = ctx.message.text.replace("/broadcast", "").trim();
  if (!message) return ctx.reply("Usage: /broadcast your message here");
  const { data: users } = await supabase.from("users").select("telegram_id");
  if (!users || users.length === 0) return ctx.reply("No users.");
  let sent = 0; let failed = 0;
  await ctx.reply(`📢 Broadcasting to ${users.length} users...`);
  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegram_id, `📢 *Announcement from ${BOT_NAME}*\n\n${message}`, { parse_mode: "Markdown" });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  ctx.reply(`✅ Done! Sent: *${sent}* | Failed: *${failed}*`, { parse_mode: "Markdown" });
});

// ── LAUNCH ────────────────────────────────────────────────────
// Wait 5 seconds before launching to avoid 409 conflicts on restart
setTimeout(() => {
  bot.launch().catch(err => {
    if (err.description setTimeout(() => bot.launch(), 5000);setTimeout(() => bot.launch(), 5000); err.description.includes("409")) {
      console.log("409 detected - another instance running, exiting gracefully...");
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
}, 5000);
console.log("🤖 PvrtyXbot running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
