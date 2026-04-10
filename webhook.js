// ============================================================
// STRIPE WEBHOOK SERVER — webhook.js (NO Telegraf - uses direct HTTP)
// ============================================================
require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Send Telegram message directly via HTTP (no Telegraf needed)
async function sendTelegramMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
    });
  } catch(e) { console.error("Telegram notify error:", e.message); }
}

// RAW body for Stripe signature verification
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { telegram_id, credits, type } = session.metadata;

    if (type === "credits") {
      const { data: user } = await supabase.from("users").select("credits").eq("telegram_id", telegram_id).single();
      if (user) {
        const newBalance = user.credits + parseInt(credits);
        await supabase.from("users").update({ credits: newBalance }).eq("telegram_id", telegram_id);
        await supabase.from("transactions").insert({
          telegram_id, type: "credit_purchase", credits: parseInt(credits),
          stripe_session_id: session.id, amount_paid: session.amount_total
        });
        await sendTelegramMessage(telegram_id,
          `✅ *Payment successful!*\n\n*${credits} credits* have been added!\n\nNew balance: *${newBalance} credits*\n\nUse /balance to confirm.`
        );
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
      await sendTelegramMessage(telegram_id,
        `⭐ *Subscription activated!*\n\nYou now have *unlimited* image generation, editing & video for 30 days!\n\nUse /balance to confirm.`
      );
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
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a0a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .box { text-align: center; padding: 48px 32px; max-width: 400px; }
        .icon { font-size: 80px; margin-bottom: 24px; }
        h1 { font-size: 30px; font-weight: 700; margin-bottom: 12px; color: #47ff8a; }
        p { color: #888; font-size: 16px; line-height: 1.6; margin-bottom: 32px; }
        .btn { display: inline-block; background: #47ff8a; color: #000; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="icon">✅</div>
        <h1>Payment Successful!</h1>
        <p>Your credits have been added. Return to Telegram and use /balance to check your new balance.</p>
        <a href="https://t.me/pvrtyXbot" class="btn">Open Bot →</a>
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
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a0a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .box { text-align: center; padding: 48px 32px; max-width: 400px; }
        .icon { font-size: 80px; margin-bottom: 24px; }
        h1 { font-size: 30px; font-weight: 700; margin-bottom: 12px; color: #ff4747; }
        p { color: #888; font-size: 16px; line-height: 1.6; margin-bottom: 32px; }
        .btn { display: inline-block; background: #222; color: white; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; border: 1px solid #333; }
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
