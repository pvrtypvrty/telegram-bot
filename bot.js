// ============================================================
// TELEGRAM IMAGE BOT — bot.js (images + editing + video)
// ============================================================
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const Replicate = require("replicate");
const Stripe = require("stripe");

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const COST_PER_IMAGE = 5;
const COST_PER_EDIT = 10;
const COST_PER_VIDEO = 50;
const REFERRAL_REWARD = 10;
const REFERRAL_BONUS = 5;

// Pending states - keyed by telegramId
const pendingPhotos = new Map();  // waiting for user to choose edit or video
const pendingEdits = new Map();   // waiting for edit prompt
const pendingVideos = new Map();  // waiting for video prompt

// ── HELPERS ──────────────────────────────────────────────────
async function getOrCreateUser(telegramId, username, referredBy = null) {
  const { data: existing } = await supabase
    .from("users").select("*").eq("telegram_id", telegramId).single();
  if (existing) return existing;

  const startCredits = referredBy ? 10 + REFERRAL_BONUS : 10;
  const { data: newUser } = await supabase
    .from("users")
    .insert({ telegram_id: telegramId, username, credits: startCredits, referred_by: referredBy || null })
    .select().single();

  if (referredBy) {
    const { data: referrer } = await supabase
      .from("users").select("credits, referral_count, referral_credits_earned")
      .eq("telegram_id", referredBy).single();
    if (referrer) {
      await supabase.from("users").update({
        credits: referrer.credits + REFERRAL_REWARD,
        referral_count: (referrer.referral_count || 0) + 1,
        referral_credits_earned: (referrer.referral_credits_earned || 0) + REFERRAL_REWARD,
      }).eq("telegram_id", referredBy);
      try {
        await bot.telegram.sendMessage(referredBy, `🎉 Someone joined using your referral link!\n\n+${REFERRAL_REWARD} credits added!`);
      } catch (e) {}
    }
  }
  return newUser;
}

async function getCredits(telegramId) {
  const { data } = await supabase.from("users")
    .select("credits, subscription_active, subscription_expires_at")
    .eq("telegram_id", telegramId).single();
  return data;
}

async function deductCredits(telegramId, amount) {
  const { data: user } = await supabase.from("users").select("credits").eq("telegram_id", telegramId).single();
  if (!user || user.credits < amount) return false;
  await supabase.from("users").update({ credits: user.credits - amount }).eq("telegram_id", telegramId);
  return true;
}

async function logGeneration(telegramId, prompt, imageUrl) {
  await supabase.from("generations").insert({ telegram_id: telegramId, prompt, image_url: imageUrl });
}

function autoDelete(ctx, messageId, ms = 60 * 60 * 1000) {
  setTimeout(async () => {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, messageId); } catch(e) {}
  }, ms);
}

function getUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (output[0]?.url) return output[0].url();
  if (typeof output[0] === 'string') return output[0];
  return null;
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
  const welcomeExtra = referredBy ? `\n🎁 You joined via referral — bonus *+${REFERRAL_BONUS} credits* added!\n` : "";
  await ctx.reply(
    `✨ *Welcome to ImageBot!*\n\n` + welcomeExtra +
    `You have *${user.credits} credits* to start.\n\n` +
    `🎨 *Generate image* — ${COST_PER_IMAGE} credits\n` +
    `✏️ *Edit your image* — ${COST_PER_EDIT} credits\n` +
    `🎬 *Generate video* — ${COST_PER_VIDEO} credits\n\n` +
    `/generate [prompt] — Create an image\n` +
    `/edit — Upload & edit your image\n` +
    `/video [prompt] — Create a video\n` +
    `/buy — Purchase credits\n` +
    `/subscribe — Unlimited monthly\n` +
    `/referral — Invite friends & earn\n` +
    `/balance — Check your credits`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🎨 Generate Image", "generate_help")],
      [Markup.button.callback("🎬 Generate Video", "video_help")],
      [Markup.button.callback("✏️ Edit My Image", "edit_help")],
      [Markup.button.callback("💰 Buy Credits", "buy_menu")],
    ])}
  );
});

// ── /balance ──────────────────────────────────────────────────
bot.command("balance", async (ctx) => {
  const data = await getCredits(ctx.from.id.toString());
  if (!data) return ctx.reply("Start the bot first with /start");
  const subStatus = data.subscription_active ? `✅ Active (expires ${new Date(data.subscription_expires_at).toLocaleDateString()})` : "❌ None";
  ctx.reply(
    `💳 *Your Account*\n\nCredits: *${data.credits}*\nSubscription: ${subStatus}\n\n🎨 Generate image: ${COST_PER_IMAGE} credits\n✏️ Edit image: ${COST_PER_EDIT} credits\n🎬 Generate video: ${COST_PER_VIDEO} credits\n\nUse /referral to earn free credits!`,
    { parse_mode: "Markdown" }
  );
});

// ── /generate ─────────────────────────────────────────────────
bot.command("generate", async (ctx) => {
  const prompt = ctx.message.text.replace("/generate", "").trim();
  if (!prompt) return ctx.reply("Please provide a prompt!\n\nExample:\n`/generate a futuristic city at night`", { parse_mode: "Markdown" });

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");

  const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && userData.credits < COST_PER_IMAGE) {
    return ctx.reply(`❌ Not enough credits!\n\nYou have *${userData.credits}* but need *${COST_PER_IMAGE}*.\n\nUse /buy to get more.`, { parse_mode: "Markdown" });
  }

  const thinkingMsg = await ctx.reply("🎨 Generating your image... please wait ~20 seconds");

  try {
    if (!isSub) await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);

    const output = await replicate.run(
      "black-forest-labs/flux-2-pro",
      { input: { prompt, num_outputs: 1, width: 1152, height: 2048 } }
    );

    const imageUrl = getUrl(output);
    await logGeneration(ctx.from.id.toString(), prompt, imageUrl);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_IMAGE;
    const photoMsg = await ctx.replyWithPhoto(
      { url: imageUrl },
      {
        caption: `✅ *Done!*\n\n📝 _${prompt}_\n` + (isSub ? `⭐ Unlimited subscriber\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Generate Another", "generate_help")],
          [Markup.button.callback("🎬 Turn into Video", "video_help")],
          [Markup.button.callback("✏️ Edit This", "edit_help")],
        ]),
      }
    );
    autoDelete(ctx, photoMsg.message_id);

  } catch (err) {
    console.error(err);
    if (!isSub) {
      const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", ctx.from.id.toString()).single();
      await supabase.from("users").update({ credits: u.credits + COST_PER_IMAGE }).eq("telegram_id", ctx.from.id.toString());
    }
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    ctx.reply("❌ Generation failed. Credits refunded. Try again!");
  }
});

// ── /video ────────────────────────────────────────────────────
bot.command("video", async (ctx) => {
  const prompt = ctx.message.text.replace("/video", "").trim();

  if (!prompt) {
    return ctx.reply(
      `🎬 *Generate a Video*\n\nCosts *${COST_PER_VIDEO} credits*.\n\n` +
      `*Text-to-video:*\n\`/video your prompt here\`\n\n` +
      `*Image-to-video:*\nSend any photo — I'll ask what you want to do with it\n\n` +
      `*Example prompts:*\n` +
      `• \`/video cinematic waves crashing on a beach at sunset\`\n` +
      `• \`/video a woman walking through neon lit city at night\`\n` +
      `• \`/video slow motion fire explosion in a dark room\`\n\n` +
      `⏱ ~2-3 minutes to generate\n📹 1080p, 10 seconds`,
      { parse_mode: "Markdown" }
    );
  }

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");

  const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && userData.credits < COST_PER_VIDEO) {
    return ctx.reply(`❌ Not enough credits!\n\nVideo costs *${COST_PER_VIDEO} credits*. You have *${userData.credits}*.\n\nUse /buy to get more.`, { parse_mode: "Markdown" });
  }

  const thinkingMsg = await ctx.reply("🎬 Generating your video... ~2-3 minutes ☕");

  try {
    if (!isSub) await deductCredits(ctx.from.id.toString(), COST_PER_VIDEO);

    const output = await replicate.run(
      "kwaivgi/kling-v2.1",
      { input: { prompt, duration: 10, aspect_ratio: "9:16", mode: "pro" } }
    );

    const videoUrl = getUrl(output);
    await logGeneration(ctx.from.id.toString(), `[VIDEO] ${prompt}`, videoUrl);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_VIDEO;
    const videoMsg = await ctx.replyWithVideo(
      { url: videoUrl },
      {
        caption: `🎬 *Video Done!*\n\n📝 _${prompt}_\n` + (isSub ? `⭐ Unlimited subscriber\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Another Video", "video_help")],
          [Markup.button.callback("🎨 Generate Image", "generate_help")],
          [Markup.button.callback("👥 Refer Friends", "show_referral")],
        ]),
      }
    );
    autoDelete(ctx, videoMsg.message_id);

  } catch (err) {
    console.error(err);
    if (!isSub) {
      const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", ctx.from.id.toString()).single();
      await supabase.from("users").update({ credits: u.credits + COST_PER_VIDEO }).eq("telegram_id", ctx.from.id.toString());
    }
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    ctx.reply("❌ Video failed. Credits refunded. Try again!");
  }
});

// ── /edit ─────────────────────────────────────────────────────
bot.command("edit", async (ctx) => {
  await ctx.reply(
    `✏️ *Edit Your Image*\n\nCosts *${COST_PER_EDIT} credits*.\n\n` +
    `Just send me any photo and I'll ask what to change!\n\n` +
    `*Examples:*\n• make this cinematic\n• change background to a beach\n• anime style\n• add neon lights\n• oil painting`,
    { parse_mode: "Markdown" }
  );
});

bot.action("edit_help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`✏️ *Edit Your Image*\n\nCosts *${COST_PER_EDIT} credits*.\n\nSend me any photo and I'll ask what to change!`, { parse_mode: "Markdown" });
});

bot.action("video_help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `🎬 *Generate a Video*\n\nCosts *${COST_PER_VIDEO} credits*.\n\n` +
    `Type: \`/video your prompt here\`\n\nOr send any photo to animate it into a video!`,
    { parse_mode: "Markdown" }
  );
});

// ── HANDLE PHOTO UPLOADS ──────────────────────────────────────
bot.on("photo", async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const userData = await getCredits(telegramId);
  if (!userData) return ctx.reply("Use /start first.");

  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  const fileId = photo.file_id;

  // Store fileId in pendingPhotos map — use short key in buttons
  pendingPhotos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingPhotos.delete(telegramId), 10 * 60 * 1000);

  await ctx.reply(
    `📸 *Image received!*\n\nWhat do you want to do with it?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✏️ Edit it (${COST_PER_EDIT} credits)`, "choose_edit")],
        [Markup.button.callback(`🎬 Animate into video (${COST_PER_VIDEO} credits)`, "choose_video")],
      ])
    }
  );
});

// User chose to edit
bot.action("choose_edit", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();

  if (!pendingPhotos.has(telegramId)) {
    return ctx.reply("Photo expired. Please send your image again.");
  }

  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);

  const userData = await getCredits(telegramId);
  const isSub = userData?.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && (!userData || userData.credits < COST_PER_EDIT)) {
    return ctx.reply(`❌ Not enough credits! You need *${COST_PER_EDIT}* credits.`, { parse_mode: "Markdown" });
  }

  pendingEdits.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingEdits.delete(telegramId), 10 * 60 * 1000);

  await ctx.reply(
    `✏️ What should I do to this image?\n\n*Examples:*\n• make this cinematic\n• change background to a beach\n• anime style\n• add neon lights\n• oil painting style`,
    { parse_mode: "Markdown" }
  );
});

// User chose to animate into video
bot.action("choose_video", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();

  if (!pendingPhotos.has(telegramId)) {
    return ctx.reply("Photo expired. Please send your image again.");
  }

  const { fileId } = pendingPhotos.get(telegramId);
  pendingPhotos.delete(telegramId);

  const userData = await getCredits(telegramId);
  const isSub = userData?.subscription_active && new Date(userData.subscription_expires_at) > new Date();
  if (!isSub && (!userData || userData.credits < COST_PER_VIDEO)) {
    return ctx.reply(`❌ Not enough credits! Video animation costs *${COST_PER_VIDEO}* credits.`, { parse_mode: "Markdown" });
  }

  pendingVideos.set(telegramId, { fileId, timestamp: Date.now() });
  setTimeout(() => pendingVideos.delete(telegramId), 10 * 60 * 1000);

  await ctx.reply(
    `🎬 How should I animate this image?\n\n*Examples:*\n• slow cinematic zoom in\n• the person starts walking\n• waves moving in the background\n• camera slowly pans right\n• wind blowing through the scene`,
    { parse_mode: "Markdown" }
  );
});

// ── HANDLE TEXT (edit & video prompts) ───────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id.toString();

  // Handle edit prompt
  if (pendingEdits.has(telegramId)) {
    const { fileId } = pendingEdits.get(telegramId);
    const editPrompt = ctx.message.text;
    pendingEdits.delete(telegramId);

    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
    if (!isSub && userData.credits < COST_PER_EDIT) {
      return ctx.reply(`❌ Not enough credits!`, { parse_mode: "Markdown" });
    }

    const thinkingMsg = await ctx.reply("✏️ Editing your image... ~30 seconds");

    try {
      if (!isSub) await deductCredits(telegramId, COST_PER_EDIT);
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const imageUrl = fileLink.href;

      const output = await replicate.run(
        "black-forest-labs/flux-kontext-pro",
        { input: { prompt: editPrompt, input_start_image: imageUrl, output_format: "jpg", output_quality: 100, safety_tolerance: 6 } }
      );

      const resultUrl = getUrl(output);
      await logGeneration(telegramId, `[EDIT] ${editPrompt}`, resultUrl);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

      const newCredits = isSub ? userData.credits : userData.credits - COST_PER_EDIT;
      const photoMsg = await ctx.replyWithPhoto(
        { url: resultUrl },
        {
          caption: `✅ *Edit Done!*\n\n✏️ _${editPrompt}_\n` + (isSub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("✏️ Edit Again", "edit_help")],
            [Markup.button.callback("🎬 Turn into Video", "video_help")],
          ]),
        }
      );
      autoDelete(ctx, photoMsg.message_id);

    } catch (err) {
      console.error(err);
      if (!isSub) {
        const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", telegramId).single();
        await supabase.from("users").update({ credits: u.credits + COST_PER_EDIT }).eq("telegram_id", telegramId);
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      ctx.reply("❌ Edit failed. Credits refunded. Try again!");
    }
    return;
  }

  // Handle image-to-video prompt
  if (pendingVideos.has(telegramId)) {
    const { fileId } = pendingVideos.get(telegramId);
    const videoPrompt = ctx.message.text;
    pendingVideos.delete(telegramId);

    const userData = await getCredits(telegramId);
    if (!userData) return ctx.reply("Use /start first.");
    const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();
    if (!isSub && userData.credits < COST_PER_VIDEO) {
      return ctx.reply(`❌ Not enough credits!`, { parse_mode: "Markdown" });
    }

    const thinkingMsg = await ctx.reply("🎬 Animating your image into a video... ~2-3 minutes ☕");

    try {
      if (!isSub) await deductCredits(telegramId, COST_PER_VIDEO);
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const imageUrl = fileLink.href;

      const output = await replicate.run(
        const output = await replicate.run(
      const output = await replicate.run(
      "kwaivgi/kling-v2.1",
      { input: { prompt: videoPrompt, start_image: imageUrl, duration: 10, aspect_ratio: "9:16", mode: "pro" } },
      { wait: { interval: 5000, maxAttempts: 120 } }
    );
      { input: { prompt, duration: 10, aspect_ratio: "9:16", mode: "pro" } },
      { wait: { interval: 5000, maxAttempts: 120 } }
    );
        { input: { prompt: videoPrompt, start_image: imageUrl, duration: 10, aspect_ratio: "9:16", mode: "pro" } }
      );

      const videoUrl = getUrl(output);
      await logGeneration(telegramId, `[I2V] ${videoPrompt}`, videoUrl);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

      const newCredits = isSub ? userData.credits : userData.credits - COST_PER_VIDEO;
      const videoMsg = await ctx.replyWithVideo(
        { url: videoUrl },
        {
          caption: `🎬 *Video Done!*\n\n📝 _${videoPrompt}_\n` + (isSub ? `⭐ Unlimited\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _Deletes in 1 hour_`,
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Another Video", "video_help")],
            [Markup.button.callback("🎨 Generate Image", "generate_help")],
          ]),
        }
      );
      autoDelete(ctx, videoMsg.message_id);

    } catch (err) {
      console.error(err);
      if (!isSub) {
        const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", telegramId).single();
        await supabase.from("users").update({ credits: u.credits + COST_PER_VIDEO }).eq("telegram_id", telegramId);
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
      ctx.reply("❌ Video failed. Credits refunded. Try again!");
    }
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
    `👥 *Your Referral Link*\n\nEarn *${REFERRAL_REWARD} credits* per person who joins!\n\n🔗 \`${referralLink}\`\n\n📊 *Stats*\n• Referrals: *${user?.referral_count || 0}*\n• Credits earned: *${user?.referral_credits_earned || 0}*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.url("📤 Share", `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join this AI image & video bot and get free credits!")}`)]
    ])}
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
    } catch (err) {
      console.error("STRIPE ERROR:", JSON.stringify(err, null, 2));
      ctx.reply("❌ Error: " + err.message);
    }
  });
});

// ── /subscribe ────────────────────────────────────────────────
bot.command("subscribe", async (ctx) => { await showSubscribeMenu(ctx); });
bot.action("subscribe_menu", async (ctx) => { await ctx.answerCbQuery(); await showSubscribeMenu(ctx); });

async function showSubscribeMenu(ctx) {
  await ctx.reply(
    "⭐ *Monthly Subscription*\n\nUnlimited images, edits AND videos.\n\n• Unlimited image generation\n• Unlimited image editing\n• Unlimited video generation\n• Cancel anytime\n\n*$14.99 / month*",
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
  } catch (err) { ctx.reply("❌ Error. Please try again."); }
});

// ── INLINE ACTIONS ────────────────────────────────────────────
bot.action("generate_help", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply("🎨 Send:\n`/generate your prompt here`", { parse_mode: "Markdown" });
});

bot.command("help", async (ctx) => {
  ctx.reply(
    "📖 *Commands*\n\n" +
    `/generate [prompt] — Image (${COST_PER_IMAGE} credits)\n` +
    `/edit — Edit image (${COST_PER_EDIT} credits)\n` +
    `/video [prompt] — Video (${COST_PER_VIDEO} credits)\n` +
    "/balance — Check credits\n" +
    "/referral — Earn free credits\n" +
    "/buy — Purchase credits\n" +
    "/subscribe — Unlimited monthly\n" +
    "/help — This menu",
    { parse_mode: "Markdown" }
  );
});

bot.launch();
console.log("🤖 Bot running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
