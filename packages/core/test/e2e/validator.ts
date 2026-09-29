import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection } from "@solana/web3.js";

export interface ProgramToLoad {
  id: string;
  so: string;
  upgradeAuthority: string;
}

export interface AccountToLoad {
  address: string;
  owner: string;
  lamports: number;
  data: Buffer;
}

export interface Validator {
  rpcUrl: string;
  connection: Connection;
  stop(): Promise<void>;
}

export function hasValidator(): boolean {
  return spawnSync("solana-test-validator", ["--version"]).status === 0;
}

function writeAccountFiles(dir: string, accounts: AccountToLoad[]): string[] {
  const args: string[] = [];
  for (const account of accounts) {
    const file = path.join(dir, `${account.address}.json`);
    const json = {
      pubkey: account.address,
      account: {
        lamports: account.lamports,
        data: [account.data.toString("base64"), "base64"],
        owner: account.owner,
        executable: false,
        rentEpoch: 0,
        space: account.data.length,
      },
    };
    fs.writeFileSync(file, JSON.stringify(json));
    args.push("--account", account.address, file);
  }
  return args;
}

async function waitForRpc(connection: Connection, child: ChildProcess, log: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited with ${child.exitCode}:\n${fs.readFileSync(log, "utf8")}`,
      );
    }
    try {
      await connection.getLatestBlockhash();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("solana-test-validator did not become ready within 90s");
}

/** Starts a throwaway solana-test-validator with the given programs and accounts preloaded. */
export async function startValidator(
  programs: ProgramToLoad[],
  accounts: AccountToLoad[],
  rpcPort = 18899,
): Promise<Validator> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchorx-ray-e2e-"));
  const log = path.join(dir, "validator.log");
  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    path.join(dir, "ledger"),
    "--rpc-port",
    String(rpcPort),
    "--faucet-port",
    String(rpcPort + 1001),
    ...programs.flatMap((p) => ["--upgradeable-program", p.id, p.so, p.upgradeAuthority]),
    ...writeAccountFiles(dir, accounts),
  ];
  const out = fs.openSync(log, "w");
  const child = spawn("solana-test-validator", args, { stdio: ["ignore", out, out] });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const connection = new Connection(rpcUrl, "confirmed");
  await waitForRpc(connection, child, log);
  return {
    rpcUrl,
    connection,
    stop: async () => {
      child.kill("SIGINT");
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
