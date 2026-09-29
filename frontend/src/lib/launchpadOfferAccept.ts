/** Reviewed seller acceptance of a funded Launchpad NFT offer. */
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getLaunchpadMarketOffer, getLaunchpadMarketTokenOwner, getLaunchpadOfferQuote,
    isLaunchpadMarketPolicyReady, type LaunchpadMarketOffer, type LaunchpadOfferQuote } from "./launchpadMarket"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
export const ACCEPT_OFFER_GAS_WANTED = 50_000_000
const ACCEPT_OFFER_STORAGE_CAP = 5_000_000

export function acceptOfferScope(chainId: string, seller: string, id: string): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller: seller, operation: `accept-offer:${id}` }
}

function offerReady(offer: LaunchpadMarketOffer, quote: LaunchpadOfferQuote, seller: string, now: number): void {
    if (!ADDRESS.test(seller) || seller === offer.buyer || !ADDRESS.test(offer.buyer) ||
        !/^O[1-9]\d*$/.test(offer.id) || offer.status !== "active" || offer.expiresAt <= BigInt(now) ||
        !quote.executable || quote.offer !== offer.id || quote.price !== offer.price || quote.currency !== offer.currency ||
        quote.currentConfigVersion < 1n || !ADDRESS.test(quote.treasury) ||
        quote.protocolAmount !== offer.price * offer.protocolFeeBPS / 10_000n ||
        quote.royaltyTotal > offer.price * offer.royaltyBPS / 10_000n ||
        quote.royalties.length > 10 || quote.royalties.some((receiver) => !ADDRESS.test(receiver.account) || receiver.amount < 0n) ||
        quote.royalties.reduce((sum, receiver) => sum + receiver.amount, 0n) !== quote.royaltyTotal ||
        quote.sellerAmount + quote.protocolAmount + quote.royaltyTotal !== offer.price) {
        throw new Error("This offer is not ready for seller acceptance. Refresh its terms.")
    }
}

export function buildAcceptOfferMsg(offer: LaunchpadMarketOffer, quote: LaunchpadOfferQuote, seller: string,
    now = Math.floor(Date.now() / 1000)): AminoMsg {
    offerReady(offer, quote, seller, now)
    return { type: "vm/MsgCall", value: { caller: seller, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "AcceptOffer", args: [offer.id, quote.currentConfigVersion.toString()],
        max_deposit: `${ACCEPT_OFFER_STORAGE_CAP}ugnot` } }
}

function sameOffer(a: LaunchpadMarketOffer, b: LaunchpadMarketOffer): boolean {
    return a.id === b.id && a.collection === b.collection && a.number === b.number && a.buyer === b.buyer &&
        a.price === b.price && a.currency === b.currency && a.expiresAt === b.expiresAt &&
        a.configVersion === b.configVersion && a.protocolFeeBPS === b.protocolFeeBPS &&
        a.royaltyBPS === b.royaltyBPS && a.status === b.status
}

function sameQuote(a: LaunchpadOfferQuote, b: LaunchpadOfferQuote): boolean {
    return a.offer === b.offer && a.price === b.price && a.currency === b.currency &&
        a.sellerAmount === b.sellerAmount && a.protocolAmount === b.protocolAmount &&
        a.royaltyTotal === b.royaltyTotal && a.treasury === b.treasury &&
        a.currentConfigVersion === b.currentConfigVersion && a.executable === b.executable &&
        a.royalties.length === b.royalties.length &&
        a.royalties.every((receiver, index) => receiver.account === b.royalties[index].account && receiver.amount === b.royalties[index].amount)
}

export function acceptOfferRequest(input: {
    offer: LaunchpadMarketOffer; quote: LaunchpadOfferQuote; seller: string; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { offer, quote, seller, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildAcceptOfferMsg(offer, quote, seller)
    const scope = acceptOfferScope(chainId, seller, offer.id)
    const label = `Accept offer ${offer.id}`
    return {
        title: "Accept funded offer", summary: `Transfer ${offer.collection} #${offer.number.toString()} to ${offer.buyer}`,
        sub: `Offer ${offer.id}`,
        lines: () => [["Token", `${offer.collection} #${offer.number.toString()}`],
            ["Buyer and new owner", offer.buyer], ["Escrow price", `${offer.price.toLocaleString()} ${offer.currency}`],
            ["You receive", `${quote.sellerAmount.toLocaleString()} ${offer.currency}`],
            ["DAO receives", `${quote.protocolAmount.toLocaleString()} ${offer.currency}`],
            ["Creator royalties", `${quote.royaltyTotal.toLocaleString()} ${offer.currency}`],
            ["DAO treasury", quote.treasury],
            ...quote.royalties.map((receiver, index): [string, string] => [`Royalty ${index + 1}`, `${receiver.amount.toLocaleString()} ${offer.currency} → ${receiver.account}`]),
            ["Seller wallet", seller], ["Expiry", new Date(Number(offer.expiresAt) * 1000).toISOString()],
            ["Realm", LAUNCHPAD_MARKET_PATH], ["Network", chainId],
            ["Gas limit", ACCEPT_OFFER_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${ACCEPT_OFFER_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Acceptance transfers your NFT to the buyer. The funded escrow is allocated to you, the DAO and creator royalty receivers; each recipient claims their credit separately."],
        acks: ["I checked the buyer, NFT, payout recipients and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await getLaunchpadMarketOffer(rpcUrl, offer.id)
            const [freshQuote, owner, policyReady] = await Promise.all([
                getLaunchpadOfferQuote(rpcUrl, fresh),
                getLaunchpadMarketTokenOwner(rpcUrl, fresh.collection, fresh.number),
                isLaunchpadMarketPolicyReady(rpcUrl, fresh.currency),
            ])
            if (!sameOffer(offer, fresh) || !sameQuote(quote, freshQuote) || owner !== seller || !policyReady) {
                throw new Error("Offer, ownership or payout terms changed. Refresh before signing.")
            }
            buildAcceptOfferMsg(fresh, freshQuote, seller)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: ACCEPT_OFFER_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadMarketOffer(rpcUrl, offer.id)
            if (fresh.status !== "accepted" || !sameOffer({ ...offer, status: "accepted" }, fresh)) return false
            return await getLaunchpadMarketTokenOwner(rpcUrl, offer.collection, offer.number) === offer.buyer
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
