"use strict";

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const PAYMENT_METHODS = {
  usdt_trc20: "USDT (TRC20)",
  usdt_bep20: "USDT (BEP20)",
  btcb_bep20: "BTCB (BEP20)",
};

let pool = null;
let schemaReady = null;

function clean(value, fallback = "Not provided") {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, 500);
}

function invoiceNumberForCampaign(campaignId) {
  const id = Number(campaignId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid campaign is required to create an invoice.");
  }
  return `TA-${String(id + 2380).padStart(4, "0")}`;
}

function paymentMethodLabel(method) {
  return PAYMENT_METHODS[method] || clean(method, "Other");
}

function database() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function ensureInvoiceSchema() {
  const db = database();
  if (!db) return null;
  if (!schemaReady) {
    schemaReady = db
      .query(`
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS campaign_id INTEGER;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS channel_link TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_id TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sender_wallet TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
        CREATE UNIQUE INDEX IF NOT EXISTS invoices_payment_id_idx
          ON invoices (payment_id) WHERE payment_id IS NOT NULL;
      `)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  await schemaReady;
  return db;
}

function buildInvoiceDetails(input) {
  const campaign = input.campaign || {};
  const campaignId = Number(campaign.id);
  const requestedPaidAt =
    input.paidAt instanceof Date ? input.paidAt : new Date(input.paidAt || Date.now());
  const paidAt = Number.isNaN(requestedPaidAt.getTime()) ? new Date() : requestedPaidAt;
  const amount = Number(campaign.price);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("A valid campaign amount is required to create an invoice.");
  }
  return {
    invoiceNumber: invoiceNumberForCampaign(campaignId),
    campaignId,
    telegramId: Number(campaign.telegramId || input.telegramUserId) || null,
    channelLink: clean(campaign.channelLink),
    packageName: clean(campaign.packageName),
    amount,
    paymentId: clean(input.txid),
    paymentMethod: paymentMethodLabel(input.method),
    paymentMethodCode: clean(input.method),
    senderWallet: clean(input.senderWallet),
    paidAt,
  };
}

async function recordPayment(details) {
  const db = await ensureInvoiceSchema();
  if (!db) return;
  const duplicate = await db.query(
    "SELECT invoice_number FROM invoices WHERE payment_id = $1 AND invoice_number <> $2 LIMIT 1",
    [details.paymentId, details.invoiceNumber]
  );
  if (duplicate.rowCount) {
    const error = new Error("This payment ID has already been used for another invoice.");
    error.code = "PAYMENT_ID_REUSED";
    throw error;
  }
  try {
    await db.query(
      `INSERT INTO invoices
        (invoice_number, package_name, amount, status, campaign_id, telegram_id, channel_link,
         payment_id, payment_method, sender_wallet, paid_at, created_at)
       VALUES ($1,$2,$3,'paid',$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT DO NOTHING`,
      [
        details.invoiceNumber,
        details.packageName,
        details.amount,
        details.campaignId,
        details.telegramId,
        details.channelLink,
        details.paymentId,
        details.paymentMethod,
        details.senderWallet,
        details.paidAt,
      ]
    );
  } catch (error) {
    if (error.code === "23505") {
      const duplicateError = new Error(
        "This payment ID has already been used for another invoice."
      );
      duplicateError.code = "PAYMENT_ID_REUSED";
      throw duplicateError;
    }
    throw error;
  }
  await db.query(
    `UPDATE invoices SET
       status = 'paid',
       campaign_id = $2,
       telegram_id = $3,
       channel_link = $4,
       payment_id = $5,
       payment_method = $6,
       sender_wallet = $7,
       paid_at = $8
     WHERE invoice_number = $1`,
    [
      details.invoiceNumber,
      details.campaignId,
      details.telegramId,
      details.channelLink,
      details.paymentId,
      details.paymentMethod,
      details.senderWallet,
      details.paidAt,
    ]
  );
}

function createInvoicePdf(details, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: details.invoiceNumber } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const blue = "#3157D5";
    const ink = "#172033";
    const muted = "#667085";
    const pageWidth = doc.page.width;
    const logoPath = options.logoPath || path.join(__dirname, "public", "images", "logo.jpg");

    doc.rect(0, 0, pageWidth, 120).fill(blue);
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, 48, 32, { fit: [64, 64] });
      } catch {}
    }
    doc.fillColor("#FFFFFF").fontSize(24).font("Helvetica-Bold").text("TELES ADS", 128, 40);
    doc.fontSize(11).font("Helvetica").text("Official Payment Invoice", 128, 72);
    doc.fontSize(10).text(details.invoiceNumber, 410, 50, { width: 135, align: "right" });

    doc.fillColor(ink).fontSize(18).font("Helvetica-Bold").text("Payment received", 48, 154);
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor(muted)
      .text(`Issued ${details.paidAt.toISOString().replace("T", " ").slice(0, 19)} UTC`, 48, 180);

    const rows = [
      ["Invoice number", details.invoiceNumber],
      ["Campaign ID", String(details.campaignId)],
      ["Channel", details.channelLink],
      ["Package", details.packageName],
      ["Payment method", details.paymentMethod],
      ["Payment ID", details.paymentId],
      ["Sender wallet", details.senderWallet],
    ];
    let y = 224;
    for (const [label, value] of rows) {
      doc.roundedRect(48, y, 499, 42, 4).fillAndStroke("#F7F9FC", "#E4E7EC");
      doc.fillColor(muted).font("Helvetica").fontSize(9).text(label.toUpperCase(), 62, y + 9, {
        width: 130,
      });
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(10).text(clean(value), 196, y + 8, {
        width: 335,
        height: 28,
        ellipsis: true,
      });
      y += 48;
    }

    doc.roundedRect(48, y + 12, 499, 70, 5).fill(blue);
    doc.fillColor("#FFFFFF").font("Helvetica").fontSize(11).text("TOTAL PAID", 68, y + 33);
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .text(`$${details.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, 300, y + 25, {
        width: 225,
        align: "right",
      });

    doc
      .fillColor(muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Thank you for choosing TELES ADS. Keep this invoice for your payment records.",
        48,
        748,
        { width: 499, align: "center" }
      );
    doc.end();
  });
}

async function sendInvoiceToTelegram(details, pdfBuffer, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token || !details.telegramId) return false;
  const form = new FormData();
  form.append("chat_id", String(details.telegramId));
  form.append(
    "caption",
    `Payment received. Your TELES ADS invoice ${details.invoiceNumber} is attached.`
  );
  form.append(
    "document",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    `${details.invoiceNumber}.pdf`
  );
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.description || `Telegram returned HTTP ${response.status}`);
  }
  return true;
}

async function handlePaymentSubmission(input) {
  const txid = String(input.txid || "").trim();
  const senderWallet = String(input.senderWallet || "").trim();
  if (!txid || !senderWallet || !PAYMENT_METHODS[input.method]) {
    throw new Error("Payment method, payment ID, and sender wallet are required.");
  }
  const details = buildInvoiceDetails({ ...input, txid, senderWallet });
  await recordPayment(details);
  const pdf = await createInvoicePdf(details);
  let delivered = false;
  try {
    delivered = await sendInvoiceToTelegram(details, pdf, input.fetchImpl || fetch);
  } catch (error) {
    console.error(`Invoice ${details.invoiceNumber}: Telegram delivery failed:`, error.message);
  }
  return { details, delivered };
}

module.exports = {
  buildInvoiceDetails,
  createInvoicePdf,
  handlePaymentSubmission,
  invoiceNumberForCampaign,
  paymentMethodLabel,
  sendInvoiceToTelegram,
};
