// ============================================================
// TELEGRAM IMAGE BOT — bot.js
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

// ── CREDIT COSTS ─────────────────────────────────────────────
const COST_PER_IMAGE = 5; // credits per generation

// ── HELPERS ──────────────────────────────────────────────────
async function getOrCreateUser(telegramId, username) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();

  if (existing) return existing;

  const { data: newUser } = await supabase
    .from("users")
    .insert({ telegram_id: telegramId, username, credits: 10 }) // 10 free starter credits
    .select()
    .single();

  return newUser;
}

async function getCredits(telegramId) {
  const { data } = await supabase
    .from("users")
    .select("credits, subscription_active, subscription_expires_at")
    .eq("telegram_id", telegramId)
    .single();
  return data;
}

async function deductCredits(telegramId, amount) {
  const { data: user } = await supabase
    .from("users")
    .select("credits")
    .eq("telegram_id", telegramId)
    .single();

  if (!user || user.credits < amount) return false;

  await supabase
    .from("users")
    .update({ credits: user.credits - amount })
    .eq("telegram_id", telegramId);

  return true;
}

async function logGeneration(telegramId, prompt, imageUrl) {
  await supabase.from("generations").insert({
    telegram_id: telegramId,
    prompt,
    image_url: imageUrl,
  });
}

// ── /start ────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const user = await getOrCreateUser(
    ctx.from.id.toString(),
    ctx.from.username || ctx.from.first_name
  );

  await ctx.replyWithPhoto(
    { url: "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=800" },
    {
      caption:
        `✨ *Welcome to ImageBot!*\n\n` +
        `You've been given *${user.credits} free credits* to start.\n\n` +
        `Each image costs *${COST_PER_IMAGE} credits*.\n\n` +
        `Use /generate followed by your prompt to create an image.\n` +
        `Use /buy to purchase more credits.\n` +
        `Use /subscribe for unlimited monthly access.\n` +
        `Use /balance to check your credits.`,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎨 Generate Image", "generate_help")],
        [Markup.button.callback("💰 Buy Credits", "buy_menu")],
        [Markup.button.callback("⭐ Subscribe", "subscribe_menu")],
      ]),
    }
  );
});

// ── /balance ──────────────────────────────────────────────────
bot.command("balance", async (ctx) => {
  const data = await getCredits(ctx.from.id.toString());
  if (!data) return ctx.reply("Start the bot first with /start");

  const subStatus = data.subscription_active
    ? `✅ Active (expires ${new Date(data.subscription_expires_at).toLocaleDateString()})`
    : "❌ None";

  ctx.reply(
    `💳 *Your Account*\n\n` +
      `Credits: *${data.credits}*\n` +
      `Subscription: ${subStatus}\n\n` +
      `Each image costs ${COST_PER_IMAGE} credits.`,
    { parse_mode: "Markdown" }
  );
});

// ── /generate ─────────────────────────────────────────────────
bot.command("generate", async (ctx) => {
  const prompt = ctx.message.text.replace("/generate", "").trim();

  if (!prompt) {
    return ctx.reply(
      "Please provide a prompt!\n\nExample:\n`/generate a futuristic city at night`",
      { parse_mode: "Markdown" }
    );
  }

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");

  // Subscription users get free generations
  const isSub = userData.subscription_active &&
    new Date(userData.subscription_expires_at) > new Date();

  if (!isSub && userData.credits < COST_PER_IMAGE) {
    return ctx.reply(
      `❌ Not enough credits!\n\nYou have *${userData.credits}* credits but need *${COST_PER_IMAGE}*.\n\nUse /buy to get more or /subscribe for unlimited access.`,
      { parse_mode: "Markdown" }
    );
  }

  const thinkingMsg = await ctx.reply("🎨 Generating your image... please wait ~20 seconds");

  try {
    // Deduct credits (skip for subscribers)
    if (!isSub) {
      await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);
    }

    // Generate with Replicate (SDXL)
    const output = await replicate.run(
      "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      { input: { prompt, num_outputs: 1, width: 1024, height: 1024 } }
    );

    const imageUrl = output[0];
    await logGeneration(ctx.from.id.toString(), prompt, imageUrl);

    // Delete thinking message
    await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_IMAGE;

    await ctx.replyWithPhoto(
      { url: imageUrl },
      {
        caption:
          `✅ *Done!*\n\n` +
          `📝 Prompt: _${prompt}_\n` +
          (isSub ? `⭐ Subscriber — unlimited generations\n` : `💳 Credits remaining: *${newCredits}*\n`),
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Generate Another", "generate_help")],
          [Markup.button.callback("💳 Buy More Credits", "buy_menu")],
        ]),
      }
    );
  } catch (err) {
    console.error(err);
    // Refund credits on error
    if (!isSub) {
      const { data: u } = await supabase.from("users").select("credits").eq("telegram_id", ctx.from.id.toString()).single();
      await supabase.from("users").update({ credits: u.credits + COST_PER_IMAGE }).eq("telegram_id", ctx.from.id.toString());
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
    ctx.reply("❌ Generation failed. Your credits have been refunded. Try again!");
  }
});

// ── /buy ──────────────────────────────────────────────────────
bot.command("buy", async (ctx) => {
  await showBuyMenu(ctx);
});

bot.action("buy_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyMenu(ctx);
});

async function showBuyMenu(ctx) {
  const packages = [
    { name: "Starter", credits: 50, price: "$4.99", priceId: process.env.STRIPE_PRICE_50 },
    { name: "Popular", credits: 150, price: "$9.99", priceId: process.env.STRIPE_PRICE_150 },
    { name: "Pro", credits: 400, price: "$19.99", priceId: process.env.STRIPE_PRICE_400 },
  ];

  const buttons = packages.map((p) => [
    Markup.button.callback(
      `${p.name} — ${p.credits} credits — ${p.price}`,
      `buy_${p.credits}`
    ),
  ]);

  await ctx.reply(
    "💰 *Buy Credits*\n\nChoose a package:",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

// Handle buy actions
["50", "150", "400"].forEach((credits) => {
  bot.action(`buy_${credits}`, async (ctx) => {
    await ctx.answerCbQuery();

    const priceMap = {
      "50": process.env.STRIPE_PRICE_50,
      "150": process.env.STRIPE_PRICE_150,
      "400": process.env.STRIPE_PRICE_400,
    };

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{ price: priceMap[credits], quantity: 1 }],
        mode: "payment",
        success_url: `${process.env.WEBHOOK_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.WEBHOOK_URL}/payment-cancel`,
        metadata: {
          telegram_id: ctx.from.id.toString(),
          credits: credits,
          type: "credits",
        },
      });

      await ctx.reply(
        `💳 *Complete your purchase*\n\n${credits} credits\n\nClick below to pay securely:`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.url("💳 Pay Now", session.url)],
          ]),
        }
      );
    } catch (err) {
    console.error("STRIPE ERROR:", JSON.stringify(err, null, 2));
    ctx.reply("❌ Error: " + err.message);
    }
  });
});

// ── /subscribe ────────────────────────────────────────────────
bot.command("subscribe", async (ctx) => {
  await showSubscribeMenu(ctx);
});

bot.action("subscribe_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await showSubscribeMenu(ctx);
});

async function showSubscribeMenu(ctx) {
  await ctx.reply(
    "⭐ *Monthly Subscription*\n\n" +
      "Get *unlimited image generations* for one flat monthly fee.\n\n" +
      "• Unlimited generations\n" +
      "• Priority queue\n" +
      "• Cancel anytime\n\n" +
      "*$14.99 / month*",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⭐ Subscribe Now — $14.99/mo", "start_subscribe")],
      ]),
    }
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
      metadata: {
        telegram_id: ctx.from.id.toString(),
        type: "subscription",
      },
    });

    await ctx.reply(
      "⭐ *Subscribe for unlimited access*\n\nClick below to subscribe:",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.url("⭐ Subscribe Now", session.url)],
        ]),
      }
    );
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error. Please try again.");
  }
});

// ── INLINE ACTIONS ────────────────────────────────────────────
bot.action("generate_help", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    "🎨 *How to Generate*\n\nSend:\n`/generate your prompt here`\n\nExamples:\n• `/generate neon tokyo street at night`\n• `/generate portrait of a warrior in gold armor`\n• `/generate abstract ocean waves in oil paint style`",
    { parse_mode: "Markdown" }
  );
});

// ── /help ─────────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  ctx.reply(
    "📖 *Commands*\n\n" +
      "/start — Welcome & setup\n" +
      "/generate [prompt] — Generate an image\n" +
      "/balance — Check your credits\n" +
      "/buy — Purchase credit packages\n" +
      "/subscribe — Monthly unlimited plan\n" +
      "/help — This menu",
    { parse_mode: "Markdown" }
  );
});

// ── LAUNCH ────────────────────────────────────────────────────
bot.launch();
console.log("🤖 Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
