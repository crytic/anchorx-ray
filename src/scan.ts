#!/usr/bin/env node
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899"; // Local RPC
const connection = new Connection(RPC_URL);

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

const IDL_DIR = path.join(process.cwd(), "target", "idl");

if (!fs.existsSync(IDL_DIR)) {
    console.error("❌ ERROR: IDL directory not found! Ensure 'target/idl/' exists.");
    process.exit(1);
}

// ✅ Get all IDL files
const idlFiles = fs.readdirSync(IDL_DIR).filter(file => file.endsWith(".json"));

if (idlFiles.length === 0) {
    console.error("❌ ERROR: No IDL files found in 'target/idl/'. Run 'anchor build'.");
    process.exit(1);
}

// Function to check if an address is a PDA
function isPda(pubkey: PublicKey): boolean {
    if (PublicKey.isOnCurve(pubkey)){ return false }; // See if it is on curve (note: not 100% safe since a bad PDA can be created on the curve)
    return true; // If it is on curve, it's a PDA
}

function loadIDL(filePath: string): anchor.Idl | null {
    try {
        const rawIdl = fs.readFileSync(filePath, "utf8");
        return JSON.parse(rawIdl);
    } catch (error) {
        console.error(`❌ ERROR: Failed to read IDL file '${filePath}'`);
        return null;
    }
}

// ✅ Properly Identify Account Type
function identifyAccountType(
    pubkey: PublicKey,
    account: AccountInfo<Buffer>,
    programIds: PublicKey[]
): string {
    if (account.executable) return "Program Account";

    const owner = account.owner.toBase58();

    if (owner === SYSTEM_PROGRAM_ID.toBase58()) {
        return "Wallet"; // ✅ Keypair wallet
    }

    if (isPda(pubkey)) {
        return "PDA"; // ✅ Correct PDA detection
    }

    if (programIds.some(progId => owner === progId.toBase58())) {
        return "Data Account"; // ✅ Other program-owned accounts
    }

    return "Other";
}


async function scanAccounts(programId: PublicKey, idl: anchor.Idl, programIds: PublicKey[]) {
    try {
        const accounts = await connection.getProgramAccounts(programId);
        console.log(`✅ Found ${accounts.length} accounts for program ${programId.toBase58()}.`);

        const coder = new BorshAccountsCoder(idl);

        return accounts.map(({ pubkey, account }) => {
            let decodedData: any = null;
            let name: any = null;

            // Try decoding with available account types in IDL
            for (const accType of idl.accounts ?? []) {
                try {
                    decodedData = coder.decode(accType.name, account.data);
                    name = accType.name
                    break;
                } catch (e) {
                    continue;
                }
            }

            return {
                name: name,
                address: pubkey.toBase58(),
                owner: account.owner.toBase58(),
                lamports: account.lamports,
                executable: account.executable,
                dataSize: account.data.length,
                accountType: identifyAccountType(pubkey, account, programIds),
                decodedData, // Include decoded inxfo if possible
            };
        });
    } catch (error) {
        console.error(`❌ ERROR: Failed to fetch accounts for '${programId.toBase58()}':`, error);
        return [];
    }
}

// ✅ Iterate over all IDLs and collect accounts
export async function processAllIdls() {
    const allAccounts: any[] = [];
    const programIds: PublicKey[] = [];

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
        console.log(`📌 Processing program: ${programId.toBase58()} (${idl.metadata?.name ?? idlFile.replace(".json", "")})`);

        // Add the program itself
        allAccounts.push({
            name: idl.metadata?.name,
            address: programId.toBase58(),
            owner: "11111111111111111111111111111111",
            lamports: 0,
            executable: true,
            dataSize: 0,
            accountType: "Program",
            decodedData: null,
        });

        // Fetch all associated accounts
        const programAccounts = await scanAccounts(programId, idl, programIds);
        allAccounts.push(...programAccounts);
    }

    // Save all accounts to a single JSON file
    fs.writeFileSync("accounts.json", JSON.stringify(allAccounts, null, 2));
    console.log(`💾 Saved all accounts to accounts.json`);
}
