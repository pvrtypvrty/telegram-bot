// ============================================================
// STRIPE WEBHOOK SERVER — webhook.js
// ============================================================
require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// RAW body needed for Stripe signature verification
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── HANDLE EVENTS ──────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { telegram_id, credits, type } = session.metadata;

    if (type === "credits") {
      // Add credits to user
      const { data: user } = await supabase
        .from("users")
        .select("credits")
        .eq("telegram_id", telegram_id)
        .single();

      await supabase
        .from("users")
        .update({ credits: user.credits + parseInt(credits) })
        .eq("telegram_id", telegram_id);

      // Log transaction
      await supabase.from("transactions").insert({
        telegram_id,
        type: "credit_purchase",
        credits: parseInt(credits),
        stripe_session_id: session.id,
        amount_paid: session.amount_total,
      });

      console.log(`✅ Added ${credits} credits to user ${telegram_id}`);
    }

    if (type === "subscription") {
      // Activate subscription for 30 days
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await supabase
        .from("users")
        .update({
          subscription_active: true,
          subscription_expires_at: expiresAt.toISOString(),
          stripe_subscription_id: session.subscription,
        })
        .eq("telegram_id", telegram_id);

      await supabase.from("transactions").insert({
        telegram_id,
        type: "subscription",
        stripe_session_id: session.id,
        amount_paid: session.amount_total,
      });

      console.log(`✅ Subscription activated for user ${telegram_id}`);
    }
  }

  // Handle subscription cancellations
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;

    await supabase
      .from("users")
      .update({
        subscription_active: false,
        subscription_expires_at: null,
      })
      .eq("stripe_subscription_id", subscription.id);

    console.log(`❌ Subscription cancelled: ${subscription.id}`);
  }

  res.json({ received: true });
});

// Success/cancel pages (Stripe redirects here after payment)
app.use(express.json());

app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding: 60px; background: #0a0a0a; color: white;">
        <h1 style="font-size: 48px;">✅</h1>
        <h2>Payment Successful!</h2>
        <p>Your credits have been added. Return to Telegram and use /balance to check.</p>
      </body>
    </html>
  `);
});

app.get("/payment-cancel", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding: 60px; background: #0a0a0a; color: white;">
        <h1 style="font-size: 48px;">❌</h1>
        <h2>Payment Cancelled</h2>
        <p>No charge was made. Return to Telegram and try again.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
