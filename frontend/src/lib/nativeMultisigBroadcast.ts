import { ENABLE_NATIVE_GNO_MULTISIG, GNO_CHAIN_ID } from "./config"
import { broadcastSignedTx, CheckTxError, OutcomeUnknownError, RealmError } from "./signedTxBroadcast"

export function assertNativeAction(chain: string): void {
    if (!ENABLE_NATIVE_GNO_MULTISIG) throw new Error("Native multisig activation is on hold")
    if (chain !== GNO_CHAIN_ID) throw new Error("Stored transaction chain does not match the selected network")
}

// One transport for native bytes (see signedTxBroadcast); keeps the flag gate
// and this flow's own error messages.
export async function broadcastNativeTransaction(chain: string, bytes: Uint8Array): Promise<string> {
    assertNativeAction(chain)
    if (!bytes.length) throw new Error("Native aggregate is not ready for broadcast")
    try {
        return (await broadcastSignedTx(chain, bytes)).hash
    } catch (e) {
        if (e instanceof CheckTxError || e instanceof RealmError) throw new Error("Native CheckTx or DeliverTx failed; transaction was not marked complete")
        if (e instanceof OutcomeUnknownError && e.detail === "RPC rejected the transaction") throw new Error("Native RPC rejected the transaction")
        if (e instanceof OutcomeUnknownError && e.detail) throw new Error(e.detail)
        if (e instanceof OutcomeUnknownError) throw new Error(`Native broadcast outcome unknown. Expected transaction hash ${e.expectedHash}. Check it on-chain before retrying.`)
        throw e
    }
}
