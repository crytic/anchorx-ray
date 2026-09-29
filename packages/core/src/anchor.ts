// @anchor-lang/core is CommonJS with getter-based exports that Node's ESM loader
// cannot expose as named imports, so take them off the default export once here.
// oxlint-disable-next-line import/default -- CommonJS: the default import is module.exports.
import anchor from "@anchor-lang/core";
import type { BN as BNInstance } from "@anchor-lang/core";

// oxlint-disable-next-line import/no-named-as-default-member -- see above.
export const {
  BN,
  BorshAccountsCoder,
  BorshEventCoder,
  BorshInstructionCoder,
  LangErrorCode,
  LangErrorMessage,
  utils,
} = anchor;
export type BN = BNInstance;
