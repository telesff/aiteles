"use strict";

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRON_TOKEN_DECIMALS = 6;
const BSC_TOKEN_DECIMALS = 18;

const NETWORKS = {
  usdt_trc20: {
    address: process.env.USDT_TRC20_ADDRESS || "TDhNivo7HsfKu2jmxyjKBWXgkR9pn8dJPf",
    label: "USDT (TRC20)",
  },
  usdt_bep20: {
    address:
      process.env.USDT_BEP20_ADDRESS || "0x0fa48b8d8379e1ac7f6b8c5cff3d8d8c419492a9",
    label: "USDT (BEP20)",
  },
};

function paymentNetwork(method) {
  return NETWORKS[method] || null;
}

function amountToUnits(amount, decimals = TRON_TOKEN_DECIMALS) {
  const text = String(amount).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw new Error("A valid positive USDT amount is required.");
  }
  const [whole, rawFraction = ""] = text.split(".");
  const discarded = rawFraction.slice(decimals);
  if (discarded && /[1-9]/.test(discarded)) {
    throw new Error(`USDT amount exceeds ${decimals} decimal places.`);
  }
  const fraction = rawFraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}

function unitsToAmount(units, decimals = TRON_TOKEN_DECIMALS) {
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = (units % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(fraction ? `${whole}.${fraction}` : whole.toString());
}

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(Math.max(3_000, Number(timeoutMs) || 12_000));
}

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || body.error || `Blockchain API returned HTTP ${response.status}`);
  }
  return body;
}

async function fetchTronTransfers(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const address = options.address || NETWORKS.usdt_trc20.address;
  const since = options.since instanceof Date ? options.since.getTime() : Number(options.since) || 0;
  const endpoint = process.env.TRON_API_URL || "https://api.trongrid.io";
  const query = new URLSearchParams({
    only_confirmed: "true",
    limit: "200",
    contract_address: TRON_USDT_CONTRACT,
    min_timestamp: String(Math.max(0, since - 60_000)),
  });
  const headers = {};
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  const body = await fetchJson(
    `${endpoint}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${query}`,
    { headers, signal: timeoutSignal(options.timeoutMs) },
    fetchImpl
  );
  const expectedAddress = address.toLowerCase();
  return (body.data || [])
    .filter(
      (item) =>
        String(item.to || "").toLowerCase() === expectedAddress &&
        String(item.token_info?.address || "") === TRON_USDT_CONTRACT
    )
    .map((item) => {
      const units = BigInt(String(item.value || "0"));
      return {
        txid: String(item.transaction_id || ""),
        from: String(item.from || ""),
        to: String(item.to || ""),
        units,
        amount: unitsToAmount(units, TRON_TOKEN_DECIMALS),
        paidAt: new Date(Number(item.block_timestamp)),
        confirmations: 1,
        method: "usdt_trc20",
      };
    })
    .filter((item) => item.txid && !Number.isNaN(item.paidAt.getTime()));
}

async function bscRpc(method, params, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint =
    process.env.BSC_RPC_URL || "https://bnb.rpc.subquery.network/public";
  const body = await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: timeoutSignal(options.timeoutMs),
    },
    fetchImpl
  );
  if (body.error) throw new Error(body.error.message || "BSC RPC request failed.");
  return body.result;
}

function addressTopic(address) {
  const raw = String(address || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error("The configured BEP20 wallet is invalid.");
  return `0x${raw.padStart(64, "0")}`;
}

async function fetchBscTransfers(options = {}) {
  const address = options.address || NETWORKS.usdt_bep20.address;
  const latestHex = await bscRpc("eth_blockNumber", [], options);
  const latest = Number.parseInt(latestHex, 16);
  const scanBlocks = Math.max(100, Number(process.env.BSC_SCAN_BLOCKS) || 5_000);
  const fromBlock = Math.max(0, latest - scanBlocks);
  const logs =
    (await bscRpc(
      "eth_getLogs",
      [
        {
          address: BSC_USDT_CONTRACT,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: "latest",
          topics: [TRANSFER_TOPIC, null, addressTopic(address)],
        },
      ],
      options
    )) || [];
  const minConfirmations = Math.max(1, Number(process.env.BSC_CONFIRMATIONS) || 12);
  const sinceMs = options.since instanceof Date ? options.since.getTime() : Number(options.since) || 0;
  const transfers = [];
  for (const log of logs) {
    const blockNumber = Number.parseInt(log.blockNumber, 16);
    const confirmations = latest - blockNumber + 1;
    if (confirmations < minConfirmations) continue;
    const block = await bscRpc("eth_getBlockByNumber", [log.blockNumber, false], options);
    const paidAt = new Date(Number.parseInt(block.timestamp, 16) * 1_000);
    if (sinceMs && paidAt.getTime() < sinceMs - 60_000) continue;
    const units = BigInt(log.data || "0x0");
    transfers.push({
      txid: String(log.transactionHash || ""),
      from: `0x${String(log.topics?.[1] || "").slice(-40)}`,
      to: address,
      units,
      amount: unitsToAmount(units, BSC_TOKEN_DECIMALS),
      paidAt,
      confirmations,
      method: "usdt_bep20",
    });
  }
  return transfers.filter((item) => item.txid && !Number.isNaN(item.paidAt.getTime()));
}

function findMatchingTransfer(transfers, expectedAmount, since) {
  const sinceMs = since instanceof Date ? since.getTime() : Number(since) || 0;
  return (
    transfers
      .filter(
        (item) => {
          const decimals = item.method === "usdt_bep20" ? BSC_TOKEN_DECIMALS : TRON_TOKEN_DECIMALS;
          return (
            item.units === amountToUnits(expectedAmount, decimals) &&
            (!sinceMs || item.paidAt.getTime() >= sinceMs - 60_000)
          );
        }
      )
      .sort((a, b) => a.paidAt - b.paidAt)[0] || null
  );
}

async function detectConfirmedTransfer({ method, expectedAmount, since, fetchImpl, timeoutMs }) {
  const network = paymentNetwork(method);
  if (!network) throw new Error("Unsupported automatic payment network.");
  const options = { address: network.address, since, fetchImpl, timeoutMs };
  const transfers =
    method === "usdt_trc20"
      ? await fetchTronTransfers(options)
      : await fetchBscTransfers(options);
  return findMatchingTransfer(transfers, expectedAmount, since);
}

module.exports = {
  BSC_USDT_CONTRACT,
  NETWORKS,
  TRON_USDT_CONTRACT,
  amountToUnits,
  detectConfirmedTransfer,
  fetchBscTransfers,
  fetchTronTransfers,
  findMatchingTransfer,
  paymentNetwork,
};
