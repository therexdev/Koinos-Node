"use strict";

const POB_ABI = require("./pob-abi.json");
const TOKEN_ABI = require("./token-abi.json");

const KOIN_DECIMALS = 8;
const SATS_PER_KOIN = 100000000n;

// Contract addresses and endpoints verified against chain state and the
// official documentation (docs.koinos.io). The PoB ABI in pob-abi.json was
// fetched from the mainnet contract meta store.
const NETWORKS = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    tokenSymbol: "KOIN",
    // Public RPC endpoints tried in order.
    rpcUrls: ["https://api.koinos.io"],
    localRpcUrl: "http://127.0.0.1:8080",
    explorer: {
      tx: "https://koinosblocks.com/tx/",
      address: "https://koinosblocks.com/address/",
    },
    // Fallback addresses only — the app resolves the canonical addresses at
    // runtime through the get_contract_address system call (the KOIN/VHP
    // contracts have migrated before; these values were resolved 2026-08).
    contracts: {
      koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
      vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq",
      pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv",
    },
    ports: {
      jsonrpc: 8080,
      p2p: 8888,
      amqp: 5672,
      amqpAdmin: 15672,
      grpc: 50051,
      rest: 3000,
    },
    // Image tags follow koinos/koinos env.example.
    imageTags: {
      ACCOUNT_HISTORY_TAG: "v1.1.0",
      BLOCK_PRODUCER_TAG: "v1.3.1",
      BLOCK_STORE_TAG: "v1.1.0",
      CHAIN_TAG: "v1.5.2",
      CONTRACT_META_STORE_TAG: "v1.1.0",
      GRPC_TAG: "v1.1.1",
      JSONRPC_TAG: "v1.2.0",
      MEMPOOL_TAG: "v1.5.0",
      P2P_TAG: "v1.3.0",
      REST_TAG: "v1.1.1",
      TRANSACTION_STORE_TAG: "v1.1.0",
    },
    composeProject: "koinos-desktop-mainnet",
    templateDir: "mainnet",
    // Official chain snapshot published by the Koinos Foundation seed host
    // (docs.koinos.io "Backup and restore"). Mainnet only.
    backup: {
      url: "https://seed.koinosfoundation.org/backups/koinos-backup.tar.gz",
      sha256Url: "https://seed.koinosfoundation.org/backups/koinos-backup.tar.gz.sha256",
      metadataUrl: "https://seed.koinosfoundation.org/backups/koinos-backup.tar.gz.metadata",
    },
    p2pSeeds: [
      "/dns4/seed.koinosblocks.com/tcp/8888/p2p/QmUNURuZxSu5wLnmBNJdwGtwjLmV5JxGhu4uNSAS8ZNcze",
      "/dns4/seed.koinosfoundation.org/tcp/8888/p2p/QmQVBuhg2j2BV1hvMMNoLVrZ9T9gPb8F9bRgifCspBz6WW",
      "/dns4/seed-east.burnkoin.com/tcp/8888/p2p/QmYAC9nxqgVt2p8NvmxNFsoMpQS7c4zEBmsZndEBTRHNu4",
      "/ip4/37.27.7.221/tcp/11394/p2p/QmY8NBHwoVrxBvrjS3wQoeTmWG4UUKMxmYHss7QYRXktrs",
      "/ip4/46.62.245.240/tcp/8888/p2p/QmWmxqE6WhcMWZEKwqUAbu87Qgm6JroZLdM4Xmxouu1Mmi",
    ],
  },
  harbinger: {
    id: "harbinger",
    label: "Harbinger (testnet)",
    tokenSymbol: "tKOIN",
    // No reliable public testnet RPC exists; default to the local node this
    // app manages. A custom RPC (e.g. koinos.pro with an API key) can be set
    // in Settings.
    rpcUrls: [],
    localRpcUrl: "http://127.0.0.1:8081",
    explorer: null,
    // Fallbacks — resolved at runtime via get_contract_address, same as mainnet.
    contracts: {
      koin: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
      vhp: "17n12ktwN79sR6ia9DDgCfmw77EgpbTyBi",
      pob: "1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9",
    },
    ports: {
      jsonrpc: 8081,
      p2p: 8889,
      amqp: 5673,
      amqpAdmin: 15673,
      grpc: 50052,
      rest: 3001,
    },
    imageTags: {
      ACCOUNT_HISTORY_TAG: "v1.1.0",
      BLOCK_PRODUCER_TAG: "v1.3.0",
      BLOCK_STORE_TAG: "v1.1.0",
      CHAIN_TAG: "v1.4.1",
      CONTRACT_META_STORE_TAG: "v1.1.0",
      GRPC_TAG: "v1.1.1",
      JSONRPC_TAG: "v1.1.0",
      MEMPOOL_TAG: "v1.5.0",
      P2P_TAG: "v1.3.0",
      REST_TAG: "v0.1.0",
      TRANSACTION_STORE_TAG: "v1.1.0",
    },
    composeProject: "koinos-desktop-harbinger",
    templateDir: "harbinger",
    p2pSeeds: [
      "/dns4/harbinger-seed.koinos.io/tcp/8888/p2p/QmcGiTpSm6YrmYo3rWoqrCPez2aJY4VdraBQsGsZKwFRuG",
    ],
  },
};

const DEFAULT_SETTINGS = {
  network: "mainnet",
  customRpc: {},          // { [networkId]: "https://..." }
  rewards: {
    enabled: false,
    pct: 50,              // percent of detected rewards to return
    mode: "burn",         // "burn" (compound to VHP) | "send" (to address)
    toAddress: "",
    minReturnKoin: "1",   // don't act below this many KOIN
    pollMinutes: 10,
  },
  keepLiquidKoin: "10",   // suggested liquid KOIN to keep for mana
};

module.exports = {
  KOIN_DECIMALS,
  SATS_PER_KOIN,
  NETWORKS,
  DEFAULT_SETTINGS,
  POB_ABI,
  TOKEN_ABI,
};
