"use strict";

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const { detectConfirmedTransfer, paymentNetwork } = require("./teles-chain-payments.cjs");

const PAYMENT_METHODS = {
  usdt_trc20: "USDT (TRC20)",
  usdt_bep20: "USDT (BEP20)",
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
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(18,6);
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_address TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS monitoring_started_at TIMESTAMP;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMP;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS chain_confirmations INTEGER;
        CREATE UNIQUE INDEX IF NOT EXISTS invoices_payment_id_idx
          ON invoices (payment_id) WHERE payment_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_number_idx
          ON invoices (invoice_number);
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
  const amount = Number(input.amount ?? campaign.price);
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

async function recordPayment(details, dbOverride) {
  const db = dbOverride || (await ensureInvoiceSchema());
  if (!db) return false;
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
    const inserted = await db.query(
      `INSERT INTO invoices
        (invoice_number, package_name, amount, status, campaign_id, telegram_id, channel_link,
         payment_id, payment_method, sender_wallet, paid_at, chain_confirmations, created_at)
       VALUES ($1,$2,$3,'paid',$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (invoice_number) DO NOTHING
       RETURNING invoice_number`,
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
        details.confirmations || 1,
      ]
    );
    if (inserted.rowCount) return true;

    const updated = await db.query(
      `UPDATE invoices SET
         status = 'paid',
         campaign_id = $2,
         telegram_id = $3,
         channel_link = $4,
         payment_id = $5,
         payment_method = $6,
         sender_wallet = $7,
         paid_at = $8,
         chain_confirmations = $9,
         amount = $10
       WHERE invoice_number = $1 AND status <> 'paid'
       RETURNING invoice_number`,
      [
        details.invoiceNumber,
        details.campaignId,
        details.telegramId,
        details.channelLink,
        details.paymentId,
        details.paymentMethod,
        details.senderWallet,
        details.paidAt,
        details.confirmations || 1,
        details.amount,
      ]
    );
    return updated.rowCount > 0;
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
}

async function allocateExpectedAmount(db, baseAmount, method) {
  const numericAmount = Number(baseAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("A valid positive campaign amount is required.");
  }
  const baseUnits = Math.ceil(numericAmount * 1_000);
  const result = await db.query(
    `SELECT expected_amount FROM invoices
     WHERE status = 'pending' AND payment_method = $1
       AND payment_expires_at > NOW() AND expected_amount IS NOT NULL`,
    [method]
  );
  const used = new Set(result.rows.map((row) => Number(row.expected_amount).toFixed(3)));
  for (let slot = 1; slot <= 999; slot += 1) {
    const candidate = (baseUnits + slot) / 1_000;
    if (!used.has(candidate.toFixed(3))) return candidate;
  }
  throw new Error("No automatic payment amount is currently available. Please retry shortly.");
}

async function withTransaction(db, callback) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client !== db && typeof client.release === "function") client.release();
  }
}

async function prepareAutomaticPayment(input) {
  const campaign = input.campaign || {};
  const method = String(input.method || "");
  const network = paymentNetwork(method);
  if (!network || !PAYMENT_METHODS[method]) {
    throw new Error("Select USDT TRC20 or USDT BEP20.");
  }
  const db = input.db || (await ensureInvoiceSchema());
  if (!db) throw new Error("Automatic payment verification requires PostgreSQL.");
  const invoiceNumber = invoiceNumberForCampaign(campaign.id);
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `teles-payment-allocation:${method}`,
    ]);
    let result = await client.query(
      "SELECT * FROM invoices WHERE invoice_number = $1 LIMIT 1 FOR UPDATE",
      [invoiceNumber]
    );
    if (!result.rowCount) {
      await client.query(
        `INSERT INTO invoices (invoice_number, package_name, amount, status, campaign_id,
          telegram_id, channel_link, created_at)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,NOW())
         ON CONFLICT (invoice_number) DO NOTHING`,
        [
          invoiceNumber,
          clean(campaign.packageName),
          Number(campaign.price),
          Number(campaign.id),
          Number(campaign.telegramId || input.telegramUserId) || null,
          clean(campaign.channelLink),
        ]
      );
      result = await client.query(
        "SELECT * FROM invoices WHERE invoice_number = $1 LIMIT 1 FOR UPDATE",
        [invoiceNumber]
      );
    }
    const invoice = result.rows[0];
    if (invoice.status === "paid") return { db, invoice, network, alreadyPaid: true };
    const reusable =
      invoice.payment_method === method &&
      invoice.expected_amount &&
      invoice.payment_expires_at &&
      new Date(invoice.payment_expires_at).getTime() > Date.now();
    if (reusable) return { db, invoice, network, alreadyPaid: false };

    const expectedAmount = await allocateExpectedAmount(client, campaign.price, method);
    const monitoringStartedAt = new Date();
    const expiresAt = new Date(monitoringStartedAt.getTime() + 2 * 60 * 60 * 1_000);
    await client.query(
      `UPDATE invoices SET campaign_id=$2, telegram_id=$3, channel_link=$4,
         payment_method=$5, expected_amount=$6, payment_address=$7,
         monitoring_started_at=$8, payment_expires_at=$9
       WHERE invoice_number=$1`,
      [
        invoiceNumber,
        Number(campaign.id),
        Number(campaign.telegramId || input.telegramUserId) || null,
        clean(campaign.channelLink),
        method,
        expectedAmount,
        network.address,
        monitoringStartedAt,
        expiresAt,
      ]
    );
    const updated = await client.query(
      "SELECT * FROM invoices WHERE invoice_number = $1 LIMIT 1",
      [invoiceNumber]
    );
    return { db, invoice: updated.rows[0], network, alreadyPaid: false };
  });
}

function automaticPaymentResponse(invoice, extra = {}) {
  return {
    status: invoice.status === "paid" ? "paid" : "pending",
    invoiceNumber: invoice.invoice_number,
    method: invoice.payment_method,
    paymentAddress: invoice.payment_address,
    expectedAmount: Number(invoice.expected_amount || invoice.amount),
    expiresAt: invoice.payment_expires_at
      ? new Date(invoice.payment_expires_at).toISOString()
      : null,
    paymentId: invoice.payment_id || null,
    ...extra,
  };
}

async function startOrCheckAutomaticPayment(input) {
  const prepared = await prepareAutomaticPayment(input);
  if (prepared.alreadyPaid) return automaticPaymentResponse(prepared.invoice);
  const invoice = prepared.invoice;
  let transfer;
  try {
    transfer = await detectConfirmedTransfer({
      method: invoice.payment_method,
      expectedAmount: Number(invoice.expected_amount),
      since: new Date(invoice.monitoring_started_at),
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    console.error(`Invoice ${invoice.invoice_number}: chain lookup delayed:`, error.message);
    return automaticPaymentResponse(invoice, { verificationDelayed: true });
  }
  if (!transfer) return automaticPaymentResponse(invoice);

  const details = buildInvoiceDetails({
    campaign: input.campaign,
    telegramUserId: input.telegramUserId,
    method: invoice.payment_method,
    txid: transfer.txid,
    senderWallet: transfer.from,
    paidAt: transfer.paidAt,
    amount: transfer.amount,
  });
  details.confirmations = transfer.confirmations;
  const newlyRecorded = await recordPayment(details, prepared.db);
  if (!newlyRecorded) {
    const current = await prepared.db.query(
      "SELECT * FROM invoices WHERE invoice_number = $1 LIMIT 1",
      [details.invoiceNumber]
    );
    return automaticPaymentResponse(current.rows[0] || { ...invoice, status: "paid" });
  }
  const pdf = await createInvoicePdf(details);
  let delivered = false;
  try {
    delivered = await sendInvoiceToTelegram(details, pdf, input.telegramFetchImpl || fetch);
  } catch (error) {
    console.error(`Invoice ${details.invoiceNumber}: Telegram delivery failed:`, error.message);
  }
  return automaticPaymentResponse(
    {
      ...invoice,
      status: "paid",
      payment_id: transfer.txid,
      expected_amount: transfer.amount,
    },
    { justConfirmed: true, invoiceDelivered: delivered }
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
  allocateExpectedAmount,
  automaticPaymentResponse,
  buildInvoiceDetails,
  createInvoicePdf,
  handlePaymentSubmission,
  invoiceNumberForCampaign,
  paymentMethodLabel,
  sendInvoiceToTelegram,
  startOrCheckAutomaticPayment,
};
