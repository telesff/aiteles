const test = require("node:test");
const assert = require("node:assert/strict");

const {
  amountToUnits,
  fetchBscTransfers,
  fetchTronTransfers,
  findMatchingTransfer,
  paymentNetwork,
} = require("../teles-chain-payments.cjs");

test("supports only automatic USDT networks", () => {
  assert.equal(paymentNetwork("usdt_trc20").label, "USDT (TRC20)");
  assert.equal(paymentNetwork("usdt_bep20").label, "USDT (BEP20)");
  assert.equal(paymentNetwork("btcb_bep20"), null);
  assert.equal(amountToUnits(359.127), 359127000n);
  assert.equal(amountToUnits(359.127, 18), 359127000000000000000n);
});

test("parses confirmed TronGrid TRC20 transfers", async () => {
  const paidAt = Date.now();
  let requestedUrl;
  const transfers = await fetchTronTransfers({
    address: "TRonReceiver",
    since: paidAt - 1_000,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
      ok: true,
      json: async () => ({
        data: [
          {
            transaction_id: "tron-tx",
            from: "TRonSender",
            to: "TRonReceiver",
            value: "359127000",
            block_timestamp: paidAt,
            token_info: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
          },
        ],
      }),
      };
    },
  });

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amount, 359.127);
  assert.equal(transfers[0].method, "usdt_trc20");
  assert.equal(findMatchingTransfer(transfers, 359.127, paidAt - 1_000).txid, "tron-tx");
  assert.match(requestedUrl, /contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/);
});

test("parses sufficiently confirmed BSC USDT transfer logs", async () => {
  const receiver = "0x1111111111111111111111111111111111111111";
  const sender = "2222222222222222222222222222222222222222";
  const amount = amountToUnits(199.456, 18);
  const previousRpcUrl = process.env.BSC_RPC_URL;
  delete process.env.BSC_RPC_URL;
  const requestedUrls = [];
  const fetchImpl = async (url, options) => {
    requestedUrls.push(url);
    const request = JSON.parse(options.body);
    let result;
    if (request.method === "eth_blockNumber") result = "0x1000";
    else if (request.method === "eth_getLogs") {
      result = [
        {
          blockNumber: "0xff0",
          transactionHash: "0xbsc-tx",
          topics: ["0xtransfer", `0x${sender.padStart(64, "0")}`],
          data: `0x${amount.toString(16)}`,
        },
      ];
    } else if (request.method === "eth_getBlockByNumber") {
      result = { timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}` };
    }
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  try {
    const transfers = await fetchBscTransfers({ address: receiver, fetchImpl });

    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].amount, 199.456);
    assert.equal(transfers[0].from, `0x${sender}`);
    assert.equal(transfers[0].confirmations, 17);
    assert.equal(findMatchingTransfer(transfers, 199.456).txid, "0xbsc-tx");
    assert.deepEqual(
      [...new Set(requestedUrls)],
      ["https://bnb.rpc.subquery.network/public"]
    );
  } finally {
    if (previousRpcUrl === undefined) delete process.env.BSC_RPC_URL;
    else process.env.BSC_RPC_URL = previousRpcUrl;
  }
});

test("does not match a transfer with a different exact amount", () => {
  const transfers = [
    {
      units: amountToUnits(359.126),
      paidAt: new Date(),
      method: "usdt_trc20",
    },
  ];
  assert.equal(findMatchingTransfer(transfers, 359.127), null);
});
