#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
var import_web3 = require("@solana/web3.js");
var import_anchor = require("@coral-xyz/anchor");
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_dotenv = __toESM(require("dotenv"));
import_dotenv.default.config();
var RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
var connection = new import_web3.Connection(RPC_URL);
var SYSTEM_PROGRAM_ID = new import_web3.PublicKey("11111111111111111111111111111111");
var IDL_DIR = import_path.default.join(process.cwd(), "target", "idl");
if (!import_fs.default.existsSync(IDL_DIR)) {
  console.error("\u274C ERROR: IDL directory not found! Ensure 'target/idl/' exists.");
  process.exit(1);
}
var idlFiles = import_fs.default.readdirSync(IDL_DIR).filter((file) => file.endsWith(".json"));
if (idlFiles.length === 0) {
  console.error("\u274C ERROR: No IDL files found in 'target/idl/'. Run 'anchor build'.");
  process.exit(1);
}
function isPda(pubkey) {
  if (import_web3.PublicKey.isOnCurve(pubkey)) {
    return false;
  }
  ;
  return true;
}
function loadIDL(filePath) {
  try {
    const rawIdl = import_fs.default.readFileSync(filePath, "utf8");
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
      const coder = new import_anchor.BorshAccountsCoder(idl);
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
      const filePath = import_path.default.join(IDL_DIR, idlFile);
      const idl = loadIDL(filePath);
      if (!idl) continue;
      const programId = new import_web3.PublicKey(idl.address);
      programIds.push(programId);
    }
    for (const idlFile of idlFiles) {
      const filePath = import_path.default.join(IDL_DIR, idlFile);
      const idl = loadIDL(filePath);
      if (!idl) continue;
      const programId = new import_web3.PublicKey(idl.address);
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
    import_fs.default.writeFileSync("accounts.json", JSON.stringify(allAccounts, null, 2));
    console.log(`\u{1F4BE} Saved all accounts to accounts.json`);
  });
}

// src/server.ts
var import_express = __toESM(require("express"));
var import_fs2 = __toESM(require("fs"));
var import_path2 = __toESM(require("path"));
var import_open = __toESM(require("open"));
var app = (0, import_express.default)();
var PORT = 3e3;
app.use(import_express.default.static(import_path2.default.join(__dirname, "../public")));
app.get("/data", (req, res) => {
  const dataPath = import_path2.default.join(process.cwd(), "accounts.json");
  if (import_fs2.default.existsSync(dataPath)) {
    res.sendFile(dataPath);
  } else {
    res.status(404).send({ error: "accounts.json not found" });
  }
});
function startServer() {
  app.listen(PORT, () => __async(this, null, function* () {
    console.log(`\u{1F30D} Visualization running at http://localhost:${PORT}`);
    yield (0, import_open.default)(`http://localhost:${PORT}`);
  }));
}

// src/index.ts
(() => __async(exports, null, function* () {
  yield processAllIdls();
  startServer();
}))();
