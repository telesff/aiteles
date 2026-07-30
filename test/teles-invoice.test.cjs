const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildInvoiceDetails,
  createInvoicePdf,
  handlePaymentSubmission,
  invoiceNumberForCampaign,
  paymentMethodLabel,
  sendInvoiceToTelegram,
} = require("../teles-invoice.cjs");

test("builds stable campaign invoice details", () => {
  const paidAt = new Date("2026-07-30T05:30:00.000Z");
  const details = buildInvoiceDetails({
    campaign: {
      id: 4,
      telegramId: 7049127887,
      channelLink: " https://t.me/example ",
      packageName: " Scale ",
      price: 359,
    },
    method: "usdt_trc20",
    txid: " abc123 ",
    senderWallet: " wallet123 ",
    paidAt,
  });

  assert.equal(invoiceNumberForCampaign(4), "TA-2384");
  assert.equal(details.invoiceNumber, "TA-2384");
  assert.equal(details.channelLink, "https://t.me/example");
  assert.equal(details.packageName, "Scale");
  assert.equal(details.paymentMethod, "USDT (TRC20)");
  assert.equal(details.paymentId, "abc123");
  assert.equal(details.senderWallet, "wallet123");
  assert.equal(details.paidAt, paidAt);
});

test("rejects invalid campaigns and missing payment fields", async () => {
  assert.throws(() => invoiceNumberForCampaign(0), /valid campaign/i);
  await assert.rejects(
    handlePaymentSubmission({
      campaign: { id: 1, price: 100 },
      method: "usdt_trc20",
      txid: " ",
      senderWallet: "wallet",
    }),
    /required/i
  );
});

test("generates a readable PDF invoice", async () => {
  const details = buildInvoiceDetails({
    campaign: {
      id: 8,
      channelLink: "https://t.me/example",
      packageName: "Premium",
      price: 599,
    },
    method: "usdt_bep20",
    txid: "tx-8",
    senderWallet: "wallet-8",
    paidAt: new Date("2026-07-30T06:00:00.000Z"),
  });
  const pdf = await createInvoicePdf(details, { logoPath: "missing-logo.jpg" });

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(pdf.length > 1_000);
});

test("sends the PDF to the campaign owner through Telegram", async () => {
  const details = {
    telegramId: 7049127887,
    invoiceNumber: "TA-2384",
  };
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  let request;
  try {
    const delivered = await sendInvoiceToTelegram(
      details,
      Buffer.from("%PDF-test"),
      async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ ok: true }) };
      }
    );

    assert.equal(delivered, true);
    assert.match(request.url, /sendDocument$/);
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.body.get("chat_id"), "7049127887");
    assert.equal(paymentMethodLabel("btcb_bep20"), "BTCB (BEP20)");
  } finally {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }
});
