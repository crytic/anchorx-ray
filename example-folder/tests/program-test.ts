import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ProgramTest } from "../target/types/program_test";
import { assert } from "chai";
import {LAMPORTS_PER_SOL} from "@solana/web3.js";

describe("program-test", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.ProgramTest as Program<ProgramTest>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const user = provider.wallet as anchor.Wallet;

  let pdaAccount: anchor.web3.PublicKey;
  let normalAccount: anchor.web3.Keypair;

  before(async () => {
    normalAccount = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(user.publicKey, 
      10000 * LAMPORTS_PER_SOL);

    // Derive PDA address
    const [pda, _] = anchor.web3.PublicKey.findProgramAddressSync(
      [],
      program.programId
    );
    pdaAccount = pda;
  });

  it("Initializes the accounts", async () => {
    await program.methods
      .initialize()
      .accounts({
        user: user.publicKey,
        normalAccount: normalAccount.publicKey,
      })
      .signers([normalAccount])
      .rpc();

    const pdaData = await program.account.pdAaccountInfo.fetch(pdaAccount);
    assert.equal(pdaData.info1.toNumber(), 100);
    assert.equal(pdaData.info2.toNumber(), -50);
    assert.equal(pdaData.info3, true);
    assert.equal(pdaData.name, "InitialPDA");

    const normalData = await program.account.normalAccount.fetch(normalAccount.publicKey);
    assert.equal(normalData.bool1, false);
    assert.equal(normalData.bool2, true);
    assert.equal(normalData.bool3, false);
    assert.equal(normalData.counter, 0);
  });

  it("Updates PDA info", async () => {
    await program.methods
      .updatePdaInfo(new anchor.BN(200), new anchor.BN(-100), false, "UpdatedPDA")
      .accounts({
        pdaAccount: pdaAccount,
      })
      .rpc();

    const updatedPda = await program.account.pdAaccountInfo.fetch(pdaAccount);
    assert.equal(updatedPda.info1.toNumber(), 200);
    assert.equal(updatedPda.info2.toNumber(), -100);
    assert.equal(updatedPda.info3, false);
    assert.equal(updatedPda.name, "UpdatedPDA");
  });

  it("Toggles NormalAccount booleans", async () => {
    await program.methods
      .toggleNormalAccount()
      .accounts({
        normalAccount: normalAccount.publicKey,
      })
      .rpc();

    const toggledNormal = await program.account.normalAccount.fetch(normalAccount.publicKey);
    assert.equal(toggledNormal.bool1, true);
    assert.equal(toggledNormal.bool2, false);
    assert.equal(toggledNormal.bool3, true);
    assert.equal(toggledNormal.counter, 1);
  });

  it("Transfers lamports", async () => {
    const receiver = anchor.web3.Keypair.generate();
    const amount = new anchor.BN(1_000_000);

    // Airdrop funds to user before transfer
    await provider.connection.requestAirdrop(user.publicKey, 2_000_000_000);

    const initialBalance = await provider.connection.getBalance(receiver.publicKey);

    await program.methods
      .transferLamports(amount)
      .accounts({
        from: user.publicKey,
        to: receiver.publicKey,
      })
      .rpc();

    const finalBalance = await provider.connection.getBalance(receiver.publicKey);
    assert.equal(finalBalance, initialBalance + amount.toNumber());
  });
});
