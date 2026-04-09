// ============================================================
// STRIPE WEBHOOK SERVER — webhook.js
// ============================================================
require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Telegraf } = require("telegraf");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

// RAW body for Stripe signature verification
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { telegram_id, credits, type } = session.metadata;

    if (type === "credits") {
      const { data: user } = await supabase.from("users").select("credits").eq("telegram_id", telegram_id).single();
      if (user) {
        await supabase.from("users").update({ credits: user.credits + parseInt(credits) }).eq("telegram_id", telegram_id);
        await supabase.from("transactions").insert({
          telegram_id, type: "credit_purchase", credits: parseInt(credits),
          stripe_session_id: session.id, amount_paid: session.amount_total
        });
        try {
          await bot.telegram.sendMessage(telegram_id,
            `✅ *Payment successful!*\n\n*${credits} credits* have been added to your account!\n\nUse /balance to check your balance.`,
            { parse_mode: "Markdown" }
          );
        } catch(e) {}
        console.log(`✅ Added ${credits} credits to user ${telegram_id}`);
      }
    }

    if (type === "subscription") {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      await supabase.from("users").update({
        subscription_active: true,
        subscription_expires_at: expiresAt.toISOString(),
        stripe_subscription_id: session.subscription,
      }).eq("telegram_id", telegram_id);
      await supabase.from("transactions").insert({
        telegram_id, type: "subscription",
        stripe_session_id: session.id, amount_paid: session.amount_total
      });
      try {
        await bot.telegram.sendMessage(telegram_id,
          `⭐ *Subscription activated!*\n\nYou now have *unlimited* image generation, editing and video for 30 days!\n\nUse /balance to confirm.`,
          { parse_mode: "Markdown" }
        );
      } catch(e) {}
      console.log(`✅ Subscription activated for user ${telegram_id}`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    await supabase.from("users").update({
      subscription_active: false, subscription_expires_at: null
    }).eq("stripe_subscription_id", event.data.object.id);
    console.log(`❌ Subscription cancelled: ${event.data.object.id}`);
  }

  res.json({ received: true });
});

app.use(express.json());

app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Payment Successful</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .box { text-align: center; padding: 40px; max-width: 400px; }
        .icon { font-size: 72px; margin-bottom: 20px; }
        h1 { font-size: 28px; margin-bottom: 12px; color: #47ff8a; }
        p { color: #aaa; font-size: 16px; line-height: 1.6; }
        .btn { display: inline-block; margin-top: 24px; background: #47ff8a; color: #000; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="icon">✅</div>
        <h1>Payment Successful!</h1>
        <p>Your credits have been added to your account. Return to Telegram to start generating!</p>
        <a href="https://t.me/pvrtyXbot" class="btn">Return to Bot</a>
      </div>
    </body>
    </html>
  `);
});

app.get("/payment-cancel", (req, res) => {
  res.send(`
    <html>
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Payment Cancelled</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .box { text-align: center; padding: 40px; max-width: 400px; }
        .icon { font-size: 72px; margin-bottom: 20px; }
        h1 { font-size: 28px; margin-bottom: 12px; color: #ff4747; }
        p { color: #aaa; font-size: 16px; line-height: 1.6; }
        .btn { display: inline-block; margin-top: 24px; background: #333; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="icon">❌</div>
        <h1>Payment Cancelled</h1>
        <p>No charge was made. Return to Telegram and try again whenever you're ready.</p>
        <a href="https://t.me/pvrtyXbot" class="btn">Return to Bot</a>
      </div>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
