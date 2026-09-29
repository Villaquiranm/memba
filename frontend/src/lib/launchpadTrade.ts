/** Native OS signing plan for the unpublished Launchpad NFT market. */
import type { AminoMsg } from "./grc20"
import { doContractBroadcast } from "./grc20"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import {
    getLaunchpadMarketListing, getLaunchpadMarketQuote, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady,
    type LaunchpadMarketListing, type LaunchpadMarketQuote,
} from "./launchpadMarket"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
export const BUY_GAS_WANTED = 50_000_000
const BUY_STORAGE_CAP_UGNOT = 5_000_000
export const CANCEL_GAS_WANTED = 50_000_000
const CANCEL_STORAGE_CAP_UGNOT = 1_000_000

export function buyScope(chainId: string, caller: string, id: string): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller, operation: `buy:${id}` }
}

export function cancelListingScope(chainId: string, caller: string, id: string): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller, operation: `cancel-listing:${id}` }
}

export function buildLaunchpadCancelListingMsg(listing: LaunchpadMarketListing, caller: string): AminoMsg {
    if (!ADDRESS.test(caller) || !/^L[1-9]\d*$/.test(listing.id) ||
        listing.seller !== caller || listing.status !== "active") {
        throw new Error("Only the seller can cancel an active listing.")
    }
    return { type: "vm/MsgCall", value: {
        caller, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "Cancel", args: [listing.id], max_deposit: `${CANCEL_STORAGE_CAP_UGNOT}ugnot`,
    } }
}

export function cancelLaunchpadListingRequest(input: {
    listing: LaunchpadMarketListing
    caller: string
    rpcUrl: string
    chainId: string
    estimatedGasFeeUgnot: number
    onSettled?: () => void
}): SignRequest {
    const { listing, caller, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildLaunchpadCancelListingMsg(listing, caller)
    const scope = cancelListingScope(chainId, caller, listing.id)
    const label = `Cancel listing ${listing.id}`
    return {
        title: "Cancel listing",
        summary: `Withdraw ${listing.collection} #${listing.number.toString()} from sale`,
        sub: `Listing ${listing.id}`,
        lines: () => [
            ["Token", `${listing.collection} #${listing.number.toString()}`],
            ["Listed price", `${listing.price.toLocaleString()} ${listing.currency}`],
            ["Effect", "This listing stops accepting purchases. The NFT stays in your wallet."],
            ["Realm", LAUNCHPAD_MARKET_PATH],
            ["Network", chainId],
            ["Gas limit", CANCEL_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${CANCEL_STORAGE_CAP_UGNOT.toLocaleString()} ugnot`],
        ],
        warns: ["A purchase may settle before this cancellation reaches the chain. Check the result before another attempt."],
        acks: ["I checked the listing and chain before opening Adena."],
        label: () => label,
        receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            if (!sameListing(listing, fresh)) throw new Error("Listing changed. Refresh before signing.")
            buildLaunchpadCancelListingMsg(fresh, caller)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: CANCEL_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            return fresh.status === "cancelled" && fresh.seller === caller &&
                fresh.collection === listing.collection && fresh.number === listing.number
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") {
                try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ }
            }
            input.onSettled?.()
        },
    }
}

function saleReady(listing: LaunchpadMarketListing, quote: LaunchpadMarketQuote, caller: string, now: number): void {
    if (!ADDRESS.test(caller)) throw new Error("Connect a valid wallet before buying.")
    if (!/^L[1-9]\d*$/.test(listing.id) || !ADDRESS.test(listing.seller) ||
        listing.number < 1n || listing.price < 1n || listing.status !== "active" || listing.currency !== "ugnot" ||
        listing.seller === caller || listing.expiresAt <= BigInt(now) ||
        !quote.executable || quote.listing !== listing.id || quote.price !== listing.price ||
        quote.currency !== listing.currency || !ADDRESS.test(quote.treasury) ||
        quote.protocolAmount !== listing.price * listing.protocolFeeBPS / 10000n ||
        quote.royaltyTotal > listing.price * listing.royaltyBPS / 10000n ||
        quote.royalties.length > 10 || quote.royalties.some((r) => !ADDRESS.test(r.account) || r.amount < 0n) ||
        quote.royalties.reduce((sum, r) => sum + r.amount, 0n) !== quote.royaltyTotal ||
        quote.sellerAmount + quote.protocolAmount + quote.royaltyTotal !== listing.price) {
        throw new Error("This native listing is no longer ready to buy. Refresh its terms.")
    }
}

export function buildLaunchpadBuyNativeMsg(listing: LaunchpadMarketListing, quote: LaunchpadMarketQuote, caller: string, now = Math.floor(Date.now() / 1000)): AminoMsg {
    saleReady(listing, quote, caller, now)
    return { type: "vm/MsgCall", value: {
        caller, send: `${listing.price.toString()}ugnot`, pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "Buy", args: [listing.id, quote.currentConfigVersion.toString()],
        max_deposit: `${BUY_STORAGE_CAP_UGNOT}ugnot`,
    } }
}

function sameListing(a: LaunchpadMarketListing, b: LaunchpadMarketListing): boolean {
    return a.id === b.id && a.collection === b.collection && a.number === b.number &&
        a.seller === b.seller && a.price === b.price && a.currency === b.currency &&
        a.expiresAt === b.expiresAt && a.configVersion === b.configVersion &&
        a.protocolFeeBPS === b.protocolFeeBPS && a.royaltyBPS === b.royaltyBPS && a.status === b.status
}

function sameQuote(a: LaunchpadMarketQuote, b: LaunchpadMarketQuote): boolean {
    return a.listing === b.listing && a.price === b.price && a.currency === b.currency &&
        a.sellerAmount === b.sellerAmount && a.protocolAmount === b.protocolAmount &&
        a.royaltyTotal === b.royaltyTotal && a.treasury === b.treasury &&
        a.currentConfigVersion === b.currentConfigVersion && a.executable === b.executable &&
        a.royalties.length === b.royalties.length &&
        a.royalties.every((r, i) => r.account === b.royalties[i].account && r.amount === b.royalties[i].amount)
}

export function buyLaunchpadNativeRequest(input: {
    listing: LaunchpadMarketListing
    quote: LaunchpadMarketQuote
    caller: string
    rpcUrl: string
    chainId: string
    estimatedGasFeeUgnot: number
    onSettled?: () => void
}): SignRequest {
    const { listing, quote, caller, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const scope = buyScope(chainId, caller, listing.id)
    buildLaunchpadBuyNativeMsg(listing, quote, caller)
    const label = `Buy ${listing.collection} #${listing.number.toString()}`
    return {
        title: "Buy collectible",
        summary: `${label} for ${listing.price.toLocaleString()} ugnot`,
        sub: `Listing ${listing.id}`,
        lines: () => [
            ["Total price", `${listing.price.toLocaleString()} ugnot`],
            ["Seller", listing.seller],
            ["Seller receives", `${quote.sellerAmount.toLocaleString()} ugnot`],
            ["DAO receives", `${quote.protocolAmount.toLocaleString()} ugnot`],
            ["Royalties", `${quote.royaltyTotal.toLocaleString()} ugnot`],
            ["DAO treasury", quote.treasury],
            ...quote.royalties.map((r, i): [string, string] => [`Royalty ${i + 1}`, `${r.amount.toLocaleString()} ugnot → ${r.account}`]),
            ["Realm", LAUNCHPAD_MARKET_PATH],
            ["Network", chainId],
            ["Gas limit", BUY_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${BUY_STORAGE_CAP_UGNOT.toLocaleString()} ugnot`],
        ],
        warns: ["Gas and any storage deposit are additional to the price. The chain checks ownership, approval and policy again when this transaction runs."],
        acks: ["I checked the price, recipients and chain before opening Adena."],
        label: () => label,
        receipt: scope,
        prepare: () => ({ msgs: [buildLaunchpadBuyNativeMsg(listing, quote, caller)] }),
        recheck: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            const [freshQuote, ready] = await Promise.all([
                getLaunchpadMarketQuote(rpcUrl, fresh), isLaunchpadMarketPolicyReady(rpcUrl, fresh.currency),
            ])
            if (!sameListing(listing, fresh) || !sameQuote(quote, freshQuote)) throw new Error("Listing or payout terms changed. Refresh before signing.")
            if (!ready) throw new Error("Trading policy changed. Refresh before signing.")
            saleReady(fresh, freshQuote, caller, Math.floor(Date.now() / 1000))
        },
        send: (_choice, beforeSign) => doContractBroadcast(
            [buildLaunchpadBuyNativeMsg(listing, quote, caller)], label,
            { gasWanted: BUY_GAS_WANTED, retry: false, beforeSign },
        ),
        verify: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            if (fresh.status !== "filled") return false
            return await getLaunchpadMarketTokenOwner(rpcUrl, listing.collection, listing.number) === caller
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") {
                try { clearGovernanceReceipt(scope) } catch { /* keep the conservative lock */ }
            }
            input.onSettled?.()
        },
    }
}
