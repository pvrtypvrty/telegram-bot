// ============================================================
// TELEGRAM IMAGE BOT — bot.js (with referral system)
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
const REFERRAL_REWARD = 10;
const REFERRAL_BONUS = 5;

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
    `You have *${user.credits} credits* to start.\n\nEach image costs *${COST_PER_IMAGE} credits*.\n\n` +
    `/generate [prompt] — Create an image\n/buy — Purchase credits\n/subscribe — Unlimited monthly\n/referral — Invite friends & earn\n/balance — Check your credits`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🎨 Generate Image", "generate_help")],
      [Markup.button.callback("👥 Refer Friends", "show_referral")],
      [Markup.button.callback("💰 Buy Credits", "buy_menu")],
    ])}
  );
});

bot.command("referral", async (ctx) => { await showReferral(ctx); });
bot.action("show_referral", async (ctx) => { await ctx.answerCbQuery(); await showReferral(ctx); });

async function showReferral(ctx) {
  const telegramId = ctx.from.id.toString();
  const { data: user } = await supabase.from("users").select("referral_count, referral_credits_earned").eq("telegram_id", telegramId).single();
  const botUsername = ctx.botInfo.username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 *Your Referral Link*\n\nShare this link and earn *${REFERRAL_REWARD} credits* for every person who joins!\n\n🔗 \`${referralLink}\`\n\n📊 *Your Stats*\n• Total referrals: *${user?.referral_count || 0}*\n• Credits earned: *${user?.referral_credits_earned || 0}*\n\nNew users also get *+${REFERRAL_BONUS} bonus credits*!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.url("📤 Share Link", `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join this AI image generator bot and get free credits!")}`)]
    ])}
  );
}

bot.command("balance", async (ctx) => {
  const data = await getCredits(ctx.from.id.toString());
  if (!data) return ctx.reply("Start the bot first with /start");
  const subStatus = data.subscription_active ? `✅ Active (expires ${new Date(data.subscription_expires_at).toLocaleDateString()})` : "❌ None";
  ctx.reply(`💳 *Your Account*\n\nCredits: *${data.credits}*\nSubscription: ${subStatus}\n\nEach image costs ${COST_PER_IMAGE} credits.\nUse /referral to earn free credits!`, { parse_mode: "Markdown" });
});

bot.command("generate", async (ctx) => {
  const prompt = ctx.message.text.replace("/generate", "").trim();
  if (!prompt) return ctx.reply("Please provide a prompt!\n\nExample:\n`/generate a futuristic city at night`", { parse_mode: "Markdown" });

  const userData = await getCredits(ctx.from.id.toString());
  if (!userData) return ctx.reply("Use /start first.");

  const isSub = userData.subscription_active && new Date(userData.subscription_expires_at) > new Date();

  if (!isSub && userData.credits < COST_PER_IMAGE) {
    return ctx.reply(`❌ Not enough credits!\n\nYou have *${userData.credits}* but need *${COST_PER_IMAGE}*.\n\nUse /buy to get more or /subscribe for unlimited access.`, { parse_mode: "Markdown" });
  }

  const thinkingMsg = await ctx.reply("🎨 Generating your image... please wait ~20 seconds");

  try {
    if (!isSub) await deductCredits(ctx.from.id.toString(), COST_PER_IMAGE);

    const output = await replicate.run(
      "black-forest-labs/flux-2-pro",
      { input: { prompt, num_outputs: 1, width: 1152, height: 2048 } }
    );

    const imageUrl = typeof output === 'string' ? output : (output[0]?.url ? output[0].url() : output[0]);
    await logGeneration(ctx.from.id.toString(), prompt, imageUrl);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}

    const newCredits = isSub ? userData.credits : userData.credits - COST_PER_IMAGE;

    const photoMsg = await ctx.replyWithPhoto(
      { url: imageUrl },
      {
        caption: `✅ *Done!*\n\n📝 _${prompt}_\n` + (isSub ? `⭐ Unlimited subscriber\n` : `💳 Credits left: *${newCredits}*\n`) + `\n⏱ _This image will be deleted in 1 hour_`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Generate Another", "generate_help")],
          [Markup.button.callback("👥 Refer Friends", "show_referral")],
        ]),
      }
    );

    setTimeout(async () => {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, photoMsg.message_id); } catch(e) {}
    }, 60 * 60 * 1000);

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

bot.command("subscribe", async (ctx) => { await showSubscribeMenu(ctx); });
bot.action("subscribe_menu", async (ctx) => { await ctx.answerCbQuery(); await showSubscribeMenu(ctx); });

async function showSubscribeMenu(ctx) {
  await ctx.reply("⭐ *Monthly Subscription*\n\nUnlimited image generations for one flat fee.\n\n• Unlimited generations\n• Cancel anytime\n\n*$14.99 / month*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[Markup.button.callback("⭐ Subscribe Now — $14.99/mo", "start_subscribe")]])
  });
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

bot.action("generate_help", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply("🎨 Send:\n`/generate your prompt here`", { parse_mode: "Markdown" });
});

bot.command("help", async (ctx) => {
  ctx.reply("📖 *Commands*\n\n/start — Welcome\n/generate [prompt] — Generate image\n/balance — Check credits\n/referral — Invite friends & earn\n/buy — Purchase credits\n/subscribe — Monthly unlimited\n/help — This menu", { parse_mode: "Markdown" });
});

bot.launch();
console.log("🤖 Bot running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
