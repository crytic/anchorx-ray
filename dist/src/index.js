#!/usr/bin/env node
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_NAME = (_a = process.env.PROGRAM_NAME) === null || _a === void 0 ? void 0 : _a.trim();
const connection = new web3_js_1.Connection(RPC_URL);
if (!PROGRAM_NAME) {
    console.error("❌ ERROR: PROGRAM_NAME is missing from .env file!");
    process.exit(1);
}
function findIDL() {
    const idlPath = path_1.default.join(process.cwd(), "target", "idl", `${PROGRAM_NAME}.json`);
    if (!fs_1.default.existsSync(idlPath)) {
        console.error(`❌ ERROR: IDL file '${PROGRAM_NAME}.json' not found in 'target/idl/'.`);
        console.error(`   Run 'anchor build' in your project to generate the IDL.`);
        process.exit(1);
    }
    try {
        return JSON.parse(fs_1.default.readFileSync(idlPath, "utf8"));
    }
    catch (error) {
        console.error(`❌ ERROR: Failed to read IDL file!`);
        process.exit(1);
    }
}
function scanAccounts() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log(`🔍 Fetching accounts for program: ${PROGRAM_NAME}...`);
        const idl = findIDL();
        const PROGRAM_ID = new web3_js_1.PublicKey(idl === null || idl === void 0 ? void 0 : idl.address);
        const accounts = yield connection.getProgramAccounts(PROGRAM_ID);
        console.log(`✅ Found ${accounts.length} accounts.`);
        const coder = new anchor_1.BorshAccountsCoder(idl);
        const accountsData = accounts.map(({ pubkey, account }) => {
            return {
                address: pubkey.toBase58(),
                owner: account.owner.toBase58(),
                lamports: account.lamports,
                executable: account.executable,
                dataSize: account.data.length
            };
        });
        fs_1.default.writeFileSync("accounts.json", JSON.stringify({ accounts: accountsData }, null, 2));
        console.log(`💾 Saved ${accountsData.length} accounts to accounts.json`);
    });
}
scanAccounts();
