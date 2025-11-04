const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.options("*", cors());

// Configure these in your environment
const YOCO_SECRET_KEY =
  process.env.YOCO_SECRET_KEY || "sk_test_YOCO_SECRET_KEY";
const YOCO_API_URL =
  process.env.YOCO_API_URL || "https://online.yoco.com/v1/checkout/sessions"; // replace if different
const YOCO_CALLBACK_URL =
  process.env.YOCO_CALLBACK_URL || "http://localhost:5500/success.html";
const SNAPSCAN_API_TOKEN = process.env.SNAPSCAN_API_TOKEN || "replace_with_key";
const SNAPSCAN_MERCHANT_ID =
  process.env.SNAPSCAN_MERCHANT_ID || "your_merchant_id";
const MERCHANT_EMAIL = process.env.MERCHANT_EMAIL || "merchant@example.com";

// compute total (expects cart items: { price: number, quantity: number })
function computeTotalCent(cart) {
  let subtotal = 0;
  for (const item of cart) {
    const price = Number(item.price) || 0;
    const qty = Number(item.quantity) || 1;
    subtotal += price * qty;
  }
  // add VAT (15%) and shipping (R60) — match frontend calculation if present
  const vat = subtotal * 0.15;
  const shipping = 60;
  const total = subtotal + vat + shipping;
  return Math.round(total * 100); // cents
}

app.post("/create-yoco-session", async (req, res) => {
  try {
    const { cart, email } = req.body;
    if (!Array.isArray(cart) || cart.length === 0)
      return res.status(400).json({ error: "Cart is empty" });
    if (!email) return res.status(400).json({ error: "Email required" });

    // compute totals (VAT 15% and shipping rules)
    const subtotal = cart.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || 0),
      0
    );
    const vat = subtotal * 0.15;
    const totalQty = cart.reduce((s, i) => s + Number(i.quantity || 0), 0);
    const shipping = totalQty === 1 ? 6.0 : totalQty > 1 ? 120.0 : 0.0;
    const total = subtotal + vat + shipping;
    const amount = Math.round(total * 100); // smallest currency unit

    // Build payload required by Yoco Checkout API — adjust fields to match Yoco docs
    const payload = {
      amount, // integer in smallest unit
      currency: "ZAR",
      callback_url: YOCO_CALLBACK_URL,
      customer: { email },
      // optional metadata and line items:
      metadata: { cart },
    };

    const resp = await fetch(YOCO_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("Yoco create session error:", body);
      return res
        .status(resp.status || 500)
        .json({ error: body.message || body });
    }

    // adjust key below to whatever Yoco returns (authorization_url / redirect_url / checkout_url)
    const checkoutUrl =
      body.data?.checkout_url ||
      body.data?.authorization_url ||
      body.checkout_url ||
      body.redirect_url ||
      body.url;
    if (!checkoutUrl) {
      console.error("Yoco response missing redirect URL", body);
      return res.status(500).json({ error: "Missing checkout URL from Yoco" });
    }

    return res.json({ url: checkoutUrl, raw: body });
  } catch (err) {
    console.error("create-yoco-session error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

app.post("/create-snapscan-session", async (req, res) => {
  try {
    const { cart = [], email } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    if (!cart.length) return res.status(400).json({ error: "cart empty" });

    const amountCents = computeTotalCent(cart);

    // Example SnapScan checkout creation call. Adjust to SnapScan's actual API (body fields, endpoint).
    // Many providers require merchantId, amount, currency and return_url.
    const snapReq = {
      merchant_id: SNAPSCAN_MERCHANT_ID,
      amount: amountCents,
      currency: "ZAR",
      customer: { email },
      // return_url should point to a page in your frontend (e.g. /payment-success)
      return_url: `http://localhost:3000/payment-success?email=${encodeURIComponent(
        email
      )}`,
      metadata: { cart },
    };

    const snapRes = await fetch("https://api.snapscan.io/v1/checkouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SNAPSCAN_API_TOKEN}`,
      },
      body: JSON.stringify(snapReq),
    });

    const body = await snapRes.json();
    if (!snapRes.ok) {
      console.error("SnapScan create error", body);
      return res.status(500).json({ error: "snapscan error", details: body });
    }

    // Assume API returns a checkout url in body.checkout_url (adjust per actual API).
    return res.json({ checkout_url: body.checkout_url || body.url || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "server error" });
  }
});

// Webhook endpoint SnapScan calls when payment completes (configure this URL in SnapScan dashboard)
app.post("/snapscan-webhook", async (req, res) => {
  // Optionally verify signature here using SNAPSCAN webhook secret
  try {
    const event = req.body;
    // Example: event contains { status: 'paid', amount: 12345, customer: { email } }
    if (event && event.status === "paid") {
      const customerEmail =
        (event.customer && event.customer.email) ||
        (event.metadata && event.metadata.email);
      // send confirmation emails
      await sendEmail(
        customerEmail,
        "Payment received",
        `Thank you — we received your payment of R${(
          event.amount / 100
        ).toFixed(2)}.`
      );
      await sendEmail(
        MERCHANT_EMAIL,
        "New payment received",
        `A payment of R${(event.amount / 100).toFixed(
          2
        )} was received. Details: ${JSON.stringify(event)}`
      );
    }
    res.status(200).send("ok");
  } catch (err) {
    console.error("webhook error", err);
    res.status(500).send("error");
  }
});

// simple email sender (configure SMTP via env)
async function sendEmail(to, subject, text) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.example.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER || "user",
      pass: process.env.SMTP_PASS || "pass",
    },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || "no-reply@example.com",
    to,
    subject,
    text,
  });
}

app.post("/create-payment", async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data); // Return the Paystack response
  } catch (error) {
    console.error("Payment initialization error:", error.response.data);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// Initialize transaction endpoint
app.post("/initialize-transaction", async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, // Use your secret key
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data); // Return the Paystack response
  } catch (error) {
    console.error("Transaction initialization error:", error.response.data);
    res.status(500).json({ error: "Transaction initialization failed" });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
