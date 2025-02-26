#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/scan.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
function isPda(pubkey) {
  if (PublicKey.isOnCurve(pubkey)) {
    return false;
  }
  ;
  return true;
}
function loadIDL(filePath) {
  try {
    const rawIdl = fs.readFileSync(filePath, "utf8");
    return JSON.parse(rawIdl);
  } catch (error) {
    console.error(`\u274C ERROR: Failed to read IDL file '${filePath}'`);
    return null;
  }
}
function identifyAccountType(pubkey, account, programIds) {
  if (account.executable) return "Program Account";
  const owner = account.owner.toBase58();
  if (owner === SYSTEM_PROGRAM_ID.toBase58()) {
    return "Wallet";
  }
  if (isPda(pubkey)) {
    return "PDA";
  }
  if (programIds.some((progId) => owner === progId.toBase58())) {
    return "Data Account";
  }
  return "Other";
}
function scanAccounts(programId, idl, programIds) {
  return __async(this, null, function* () {
    try {
      const accounts = yield connection.getProgramAccounts(programId);
      console.log(`\u2705 Found ${accounts.length} accounts for program ${programId.toBase58()}.`);
      const coder = new BorshAccountsCoder(idl);
      return accounts.map(({ pubkey, account }) => {
        var _a;
        let decodedData = null;
        let name = null;
        for (const accType of (_a = idl.accounts) != null ? _a : []) {
          try {
            decodedData = coder.decode(accType.name, account.data);
            name = accType.name;
            break;
          } catch (e) {
            continue;
          }
        }
        return {
          name,
          address: pubkey.toBase58(),
          owner: account.owner.toBase58(),
          lamports: account.lamports,
          executable: account.executable,
          dataSize: account.data.length,
          accountType: identifyAccountType(pubkey, account, programIds),
          decodedData
          // Include decoded inxfo if possible
        };
      });
    } catch (error) {
      console.error(`\u274C ERROR: Failed to fetch accounts for '${programId.toBase58()}':`, error);
      return [];
    }
  });
}
function processAllIdls() {
  return __async(this, null, function* () {
    var _a, _b, _c;
    const allAccounts = [];
    const programIds = [];
    for (const idlFile of idlFiles) {
      const filePath = path.join(IDL_DIR, idlFile);
      const idl = loadIDL(filePath);
      if (!idl) continue;
      const programId = new PublicKey(idl.address);
      programIds.push(programId);
    }
    for (const idlFile of idlFiles) {
      const filePath = path.join(IDL_DIR, idlFile);
      const idl = loadIDL(filePath);
      if (!idl) continue;
      const programId = new PublicKey(idl.address);
      console.log(`\u{1F4CC} Processing program: ${programId.toBase58()} (${(_b = (_a = idl.metadata) == null ? void 0 : _a.name) != null ? _b : idlFile.replace(".json", "")})`);
      allAccounts.push({
        name: (_c = idl.metadata) == null ? void 0 : _c.name,
        address: programId.toBase58(),
        owner: "11111111111111111111111111111111",
        lamports: 0,
        executable: true,
        dataSize: 0,
        accountType: "Program",
        decodedData: null
      });
      const programAccounts = yield scanAccounts(programId, idl, programIds);
      allAccounts.push(...programAccounts);
    }
    fs.writeFileSync("accounts.json", JSON.stringify(allAccounts, null, 2));
    console.log(`\u{1F4BE} Saved all accounts to accounts.json`);
  });
}
var RPC_URL, connection, SYSTEM_PROGRAM_ID, IDL_DIR, idlFiles;
var init_scan = __esm({
  "src/scan.ts"() {
    "use strict";
    dotenv.config();
    RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
    connection = new Connection(RPC_URL);
    SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
    IDL_DIR = path.join(process.cwd(), "target", "idl");
    if (!fs.existsSync(IDL_DIR)) {
      console.error("\u274C ERROR: IDL directory not found! Ensure 'target/idl/' exists.");
      process.exit(1);
    }
    idlFiles = fs.readdirSync(IDL_DIR).filter((file) => file.endsWith(".json"));
    if (idlFiles.length === 0) {
      console.error("\u274C ERROR: No IDL files found in 'target/idl/'. Run 'anchor build'.");
      process.exit(1);
    }
  }
});

// src/server.ts
import express from "express";
import fs2 from "fs";
import path2 from "path";
import open from "open";
function startServer() {
  app.listen(PORT, () => __async(this, null, function* () {
    console.log(`\u{1F30D} Visualization running at http://localhost:${PORT}`);
    yield open(`http://localhost:${PORT}`);
  }));
}
var app, PORT;
var init_server = __esm({
  "src/server.ts"() {
    "use strict";
    app = express();
    PORT = 3e3;
    app.use(express.static(path2.join(__dirname, "../public")));
    app.get("/data", (req, res) => {
      const dataPath = path2.join(process.cwd(), "accounts.json");
      if (fs2.existsSync(dataPath)) {
        res.sendFile(dataPath);
      } else {
        res.status(404).send({ error: "accounts.json not found" });
      }
    });
  }
});

// src/index.ts
var require_index = __commonJS({
  "src/index.ts"(exports) {
    init_scan();
    init_server();
    (() => __async(exports, null, function* () {
      yield processAllIdls();
      startServer();
    }))();
  }
});
export default require_index();
