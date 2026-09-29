/** Reviewed direct NFT transfer, holder burn and Soulbound issuer revocation. */
import { isValidGnoAddressChecksum } from "./dao/address"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getLaunchpadNftCollection, getLaunchpadNftToken,
    type LaunchpadNftCollection, type LaunchpadNftToken } from "./launchpadNft"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

export const NFT_CONTROL_GAS_WANTED = 50_000_000
const STORAGE_CAP = 1_000_000
export type RevokeReason = "expired" | "fraud" | "eligibility_lost" | "issuer_error" | "other"
export type NftControlAction = { kind: "transfer"; recipient: string } | { kind: "burn" } |
    { kind: "revoke"; reason: RevokeReason }
export interface NftControlState { collection: LaunchpadNftCollection; token: LaunchpadNftToken }

export async function readNftControlState(rpcUrl: string, collectionID: string, number: bigint): Promise<NftControlState> {
    const [collection, token] = await Promise.all([
        getLaunchpadNftCollection(rpcUrl, collectionID), getLaunchpadNftToken(rpcUrl, collectionID, number),
    ])
    if (collection.id !== token.collection || token.number !== number ||
        token.soulbound !== (collection.mode === "soulbound") || token.number > collection.minted) {
        throw new Error("NFT token rights are inconsistent with its collection.")
    }
    return { collection, token }
}

function validateAction(state: NftControlState, caller: string, action: NftControlAction): void {
    const { collection, token } = state
    if (!isValidGnoAddressChecksum(caller) || token.status !== "active") throw new Error("This NFT is not active for a wallet action.")
    if (action.kind === "transfer") {
        if (collection.mode !== "open" || token.owner !== caller ||
            !isValidGnoAddressChecksum(action.recipient) || action.recipient === caller) {
            throw new Error("Only the owner can transfer an Open NFT to a different valid wallet.")
        }
    } else if (action.kind === "burn") {
        if (token.owner !== caller) throw new Error("Only the current NFT holder can burn this token.")
    } else if (action.kind === "revoke") {
        if (collection.mode !== "soulbound" || !collection.revocable || collection.creator !== caller ||
            !(["expired", "fraud", "eligibility_lost", "issuer_error", "other"] as string[]).includes(action.reason)) {
            throw new Error("Only the authorized Soulbound creator can revoke with a recorded reason.")
        }
    }
}

export function nftControlScope(chainId: string, state: NftControlState, caller: string,
    action: NftControlAction): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_NFT_PATH, caller,
        operation: `${action.kind}:${state.collection.id}:${state.token.number.toString()}` }
}

export function buildNftControlMsg(state: NftControlState, caller: string, action: NftControlAction): AminoMsg {
    validateAction(state, caller, action)
    const { collection, token } = state
    const func = action.kind === "transfer" ? "Transfer" : action.kind === "burn" ? "Burn" : "Revoke"
    const args = action.kind === "transfer" ? [collection.id, token.owner, action.recipient, token.number.toString()] :
        action.kind === "burn" ? [collection.id, token.number.toString()] :
            [collection.id, token.number.toString(), action.reason]
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_NFT_PATH,
        func, args, max_deposit: `${STORAGE_CAP}ugnot` } }
}

function sameState(a: NftControlState, b: NftControlState): boolean {
    return a.collection.id === b.collection.id && a.collection.creator === b.collection.creator &&
        a.collection.mode === b.collection.mode && a.collection.revocable === b.collection.revocable &&
        a.token.collection === b.token.collection && a.token.number === b.token.number &&
        a.token.owner === b.token.owner && a.token.status === b.token.status && a.token.soulbound === b.token.soulbound
}

export function nftControlRequest(input: { state: NftControlState; caller: string; action: NftControlAction;
    rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { state, caller, action, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const call = buildNftControlMsg(state, caller, action)
    const { collection, token } = state
    const receipt = nftControlScope(chainId, state, caller, action)
    const verb = action.kind === "transfer" ? "Transfer" : action.kind === "burn" ? "Burn" : "Revoke"
    return {
        title: `${verb} NFT`, summary: `${collection.name} #${token.number.toString()} · ${action.kind}`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Token", `#${token.number.toString()}`],
            ["Current holder", token.owner], ["Wallet signing", caller], ["Collection mode", collection.mode],
            ...(action.kind === "transfer" ? [["Recipient", action.recipient]] as [string, string][] : []),
            ...(action.kind === "revoke" ? [["Revocation reason", action.reason], ["Issuer", collection.creator]] as [string, string][] : []),
            ["Realm", LAUNCHPAD_NFT_PATH], ["Network", chainId], ["Gas limit", NFT_CONTROL_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: action.kind === "transfer" ? ["A direct transfer changes ownership without a marketplace sale. Creator royalties are not charged by this action; verify the recipient address carefully.",
            "Cancel any active market listing first. Otherwise it becomes unbuyable and the seller must cancel it separately."] :
            action.kind === "burn" ? ["Burn permanently retires this token. It cannot be recovered or transferred afterward.",
                "Cancel any active market listing first; burning makes it unbuyable but does not cancel the listing record."] :
                ["Revocation permanently retires this Soulbound credential. The reason is recorded publicly on chain; do not put personal information in it."],
        acks: [`I checked the token, ${action.kind === "transfer" ? "recipient" : action.kind === "revoke" ? "public reason" : "permanent burn"}, authority and network.`],
        label: () => `${verb} ${collection.id} #${token.number.toString()}`, receipt, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const fresh = await readNftControlState(rpcUrl, collection.id, token.number)
            if (!sameState(state, fresh)) throw new Error("NFT ownership or rights changed. Refresh before signing.")
            buildNftControlMsg(fresh, caller, action)
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `${verb} ${collection.id} #${token.number.toString()}`,
            { gasWanted: NFT_CONTROL_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await readNftControlState(rpcUrl, collection.id, token.number)
            if (action.kind === "transfer") return fresh.token.status === "active" && fresh.token.owner === action.recipient
            return fresh.token.status === (action.kind === "burn" ? "burned" : "revoked") && fresh.token.owner === ""
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(receipt) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}
