/** Pause-safe refund actions for funded Launchpad market offers. */
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { getLaunchpadMarketOffer, type LaunchpadMarketOffer } from "./launchpadMarket"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
export const OFFER_REFUND_GAS_WANTED = 50_000_000
const OFFER_REFUND_STORAGE_CAP = 1_000_000
export type OfferExit = "cancel" | "expire"

export function offerExitScope(chainId: string, caller: string, id: string, action: OfferExit): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller, operation: `${action}-offer:${id}` }
}

function sameOffer(a: LaunchpadMarketOffer, b: LaunchpadMarketOffer): boolean {
    return a.id === b.id && a.collection === b.collection && a.number === b.number &&
        a.buyer === b.buyer && a.price === b.price && a.currency === b.currency &&
        a.expiresAt === b.expiresAt && a.createdAt === b.createdAt &&
        a.configVersion === b.configVersion && a.protocolFeeBPS === b.protocolFeeBPS &&
        a.royaltyBPS === b.royaltyBPS && a.status === b.status
}

export function buildOfferExitMsg(offer: LaunchpadMarketOffer, caller: string, action: OfferExit, now = Math.floor(Date.now() / 1000)): AminoMsg {
    if (!ADDRESS.test(caller) || !ADDRESS.test(offer.buyer) || !/^O[1-9]\d*$/.test(offer.id) || offer.status !== "active" ||
        (action === "cancel" && caller !== offer.buyer) || (action === "expire" && offer.expiresAt > BigInt(now))) {
        throw new Error("This offer is not ready for a refund. Refresh its status.")
    }
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: action === "cancel" ? "CancelOffer" : "ExpireOffer", args: [offer.id],
        max_deposit: `${OFFER_REFUND_STORAGE_CAP}ugnot` } }
}

export function offerExitRequest(input: {
    offer: LaunchpadMarketOffer; caller: string; action: OfferExit; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { offer, caller, action, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildOfferExitMsg(offer, caller, action)
    const scope = offerExitScope(chainId, caller, offer.id, action)
    const label = action === "cancel" ? `Cancel offer ${offer.id}` : `Refund expired offer ${offer.id}`
    return {
        title: action === "cancel" ? "Cancel funded offer" : "Refund expired offer",
        summary: `${offer.price.toLocaleString()} ${offer.currency} returns to ${offer.buyer}`,
        sub: `Offer ${offer.id}`,
        lines: () => [["Token", `${offer.collection} #${offer.number.toString()}`],
            ["Full refund", `${offer.price.toLocaleString()} ${offer.currency}`],
            ["Refund recipient", offer.buyer],
            ["Caller", caller], ["Realm", LAUNCHPAD_MARKET_PATH], ["Network", chainId],
            ["Gas limit", OFFER_REFUND_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${OFFER_REFUND_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: action === "expire" ? ["Anyone can trigger this refund, but the entire escrow returns to the original buyer. The caller pays gas."] :
            ["This cancels the funded offer and returns the entire escrow to your wallet. The caller pays gas."],
        acks: ["I checked the refund recipient, offer status and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await getLaunchpadMarketOffer(rpcUrl, offer.id)
            if (!sameOffer(offer, fresh)) throw new Error("Offer changed. Refresh before signing.")
            buildOfferExitMsg(fresh, caller, action)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label, { gasWanted: OFFER_REFUND_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadMarketOffer(rpcUrl, offer.id)
            return fresh.buyer === offer.buyer && fresh.price === offer.price && fresh.currency === offer.currency &&
                fresh.status === (action === "cancel" ? "cancelled" : "expired")
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
