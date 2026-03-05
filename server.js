const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

app.use(
  "/webhook",
  express.raw({ type: "application/json" })
);

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash),
    Buffer.from(hmacHeader)
  );
}

const CORPORATE_KEYWORDS = ["株式会社"];

function isCorporateOrder(order) {
  const targets = [
    order.customer?.first_name,
    order.customer?.last_name,
    order.customer?.default_address?.company,
    order.billing_address?.company,
    order.billing_address?.first_name,
    order.billing_address?.last_name,
    order.shipping_address?.company,
    order.shipping_address?.first_name,
    order.shipping_address?.last_name,
  ];

  return targets.some((field) => {
    if (!field) return false;
    return CORPORATE_KEYWORDS.some((kw) => field.includes(kw));
  });
}

async function sendSlackAlert(order) {
  const customerName = [
    order.customer?.last_name,
    order.customer?.first_name,
  ]
    .filter(Boolean)
    .join(" ") || "不明";

  const company =
    order.billing_address?.company ||
    order.shipping_address?.company ||
    order.customer?.default_address?.company ||
    "";

  const totalPrice = `¥${Number(order.total_price).toLocaleString()}`;
  const orderNumber = order.name || `#${order.order_number}`;

  const message = {
    text: "🏢 法人注文を検知しました",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🏢 法人注文アラート",
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*注文番号:*\n${orderNumber}`,
          },
          {
            type: "mrkdwn",
            text: `*合計金額:*\n${totalPrice}`,
          },
          {
            type: "mrkdwn",
            text: `*顧客名:*\n${customerName}`,
          },
          {
            type: "mrkdwn",
            text: `*会社名:*\n${company || "（フィールドなし）"}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*商品:*\n${order.line_items
            ?.map((item) => `• ${item.title} × ${item.quantity}`)
            .join("\n") || "（なし）"}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `注文日時: ${new Date(order.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
          },
        ],
      },
    ],
  };

  await axios.post(SLACK_WEBHOOK_URL, message);
}

app.post("/webhook/orders/create", async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.error("⚠️ Webhook署名検証に失敗しました");
    return res.status(401).send("Unauthorized");
  }

  res.status(200).send("OK");

  try {
    const order = JSON.parse(req.body.toString());
    console.log(`📦 注文受信: ${order.name}`);

    if (isCorporateOrder(order)) {
      console.log(`🏢 法人注文を検知: ${order.name}`);
      await sendSlackAlert(order);
      console.log("✅ Slack通知を送信しました");
    } else {
      console.log("👤 個人注文のためスキップ");
    }
  } catch (err) {
    console.error("❌ 処理エラー:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/orders/create`);
});
