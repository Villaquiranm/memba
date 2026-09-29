/** Reviewed WUGNOT approval and fixed-price purchase on the unpublished NFT market. */
import { parseQevalJSON, queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { packageAddress } from "./dao/weightedApplications"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getLaunchpadMarketListing, getLaunchpadMarketQuote, getLaunchpadMarketTokenOwner,
    isLaunchpadMarketPolicyReady, type LaunchpadMarketListing, type LaunchpadMarketQuote } from "./launchpadMarket"
import { buyScope } from "./launchpadTrade"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
const MAX_INT64 = 9223372036854775807n
export const WUGNOT_REALM = "gno.land/r/gnoland/wugnot"
export const WUGNOT_KEY = `${WUGNOT_REALM}.wugnot`
export const MARKET_SPENDER = packageAddress(LAUNCHPAD_MARKET_PATH)
export const APPROVE_WUGNOT_GAS_WANTED = 50_000_000
export const BUY_WUGNOT_GAS_WANTED = 50_000_000
const APPROVE_STORAGE_CAP = 1_000_000
const BUY_STORAGE_CAP = 5_000_000

export interface WugnotSpend {
    currency: typeof WUGNOT_KEY
    owner: string
    spender: string
    name: string
    symbol: "wugnot"
    decimals: 0
    balance: bigint
    allowance: bigint
}

function amount(value: unknown): bigint {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid token spend amount")
    const n = BigInt(value)
    if (n > MAX_INT64) throw new Error("Invalid token spend amount")
    return n
}

export function parseWugnotSpend(value: unknown, owner: string): WugnotSpend {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid token spend read")
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join("|") !== "allowance|balance|currency|decimals|name|owner|spender|symbol" ||
        row.currency !== WUGNOT_KEY || row.owner !== owner || !ADDRESS.test(owner) ||
        row.spender !== MARKET_SPENDER || row.symbol !== "wugnot" || row.decimals !== "0" ||
        typeof row.name !== "string" || row.name.length < 1 || row.name.length > 80) throw new Error("Token spend identity changed")
    return { currency: WUGNOT_KEY, owner, spender: MARKET_SPENDER, name: row.name,
        symbol: "wugnot", decimals: 0, balance: amount(row.balance), allowance: amount(row.allowance) }
}

export async function readWugnotSpend(rpcUrl: string, owner: string): Promise<WugnotSpend> {
    if (!ADDRESS.test(owner)) throw new Error("Connect a valid buyer wallet")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH,
        `TokenSpendJSON(${JSON.stringify(WUGNOT_KEY)}, ${JSON.stringify(owner)})`, true)
    if (raw === null) throw new Error("Could not verify token balance and allowance")
    return parseWugnotSpend(parseQevalJSON(raw), owner)
}

export function approveWugnotScope(chainId: string, caller: string, listingID: string): GovernanceScope {
    return { chainId, realmPath: WUGNOT_REALM, caller, operation: `approve-market:${listingID}` }
}

export function buildApproveWugnotMsg(spend: WugnotSpend, price: bigint): AminoMsg {
    if (price < 1n || price > MAX_INT64 || spend.balance < price || spend.allowance >= price ||
        spend.currency !== WUGNOT_KEY || spend.symbol !== "wugnot" || spend.decimals !== 0 ||
        spend.spender !== MARKET_SPENDER || !ADDRESS.test(spend.owner)) throw new Error("Token approval is unavailable. Refresh the balance and listing.")
    return { type: "vm/MsgCall", value: { caller: spend.owner, send: "", pkg_path: WUGNOT_REALM,
        func: "Approve", args: [MARKET_SPENDER, price.toString()], max_deposit: `${APPROVE_STORAGE_CAP}ugnot` } }
}

export function approveWugnotRequest(input: {
    listing: LaunchpadMarketListing; spend: WugnotSpend; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { listing, spend, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    if (listing.currency !== WUGNOT_KEY || listing.status !== "active" ||
        listing.expiresAt <= BigInt(Math.floor(Date.now() / 1000)) || listing.seller === spend.owner) throw new Error("Not an available WUGNOT listing")
    const msg = buildApproveWugnotMsg(spend, listing.price)
    const scope = approveWugnotScope(chainId, spend.owner, listing.id)
    const label = `Approve ${listing.price.toLocaleString()} wugnot for ${listing.id}`
    return {
        title: "Approve exact WUGNOT amount", summary: `Allow Market to collect ${listing.price.toLocaleString()} wugnot from ${spend.owner}`,
        lines: () => [["Listing", `${listing.collection} #${listing.number.toString()} · ${listing.id}`],
            ["Exact allowance", `${listing.price.toLocaleString()} wugnot`], ["Current balance", `${spend.balance.toLocaleString()} wugnot`],
            ["Market spender", MARKET_SPENDER], ["Token realm", WUGNOT_REALM], ["Network", chainId],
            ["Gas limit", APPROVE_WUGNOT_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${APPROVE_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Approval does not buy the NFT. It lets the named market collect up to this exact amount when you sign a later purchase or offer."],
        acks: ["I checked the token, exact allowance, spender and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const [freshListing, freshSpend, ready] = await Promise.all([
                getLaunchpadMarketListing(rpcUrl, listing.id), readWugnotSpend(rpcUrl, spend.owner),
                isLaunchpadMarketPolicyReady(rpcUrl, WUGNOT_KEY),
            ])
            if (!sameListing(listing, freshListing) || !ready) throw new Error("Listing or trading policy changed. Refresh before approval.")
            buildApproveWugnotMsg(freshSpend, listing.price)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: APPROVE_WUGNOT_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => (await readWugnotSpend(rpcUrl, spend.owner)).allowance === listing.price,
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}

function sameListing(a: LaunchpadMarketListing, b: LaunchpadMarketListing): boolean {
    return a.id === b.id && a.collection === b.collection && a.number === b.number && a.seller === b.seller &&
        a.price === b.price && a.currency === b.currency && a.expiresAt === b.expiresAt && a.createdAt === b.createdAt &&
        a.configVersion === b.configVersion && a.protocolFeeBPS === b.protocolFeeBPS && a.royaltyBPS === b.royaltyBPS && a.status === b.status
}

function sameQuote(a: LaunchpadMarketQuote, b: LaunchpadMarketQuote): boolean {
    return a.listing === b.listing && a.price === b.price && a.currency === b.currency &&
        a.sellerAmount === b.sellerAmount && a.protocolAmount === b.protocolAmount &&
        a.royaltyTotal === b.royaltyTotal && a.treasury === b.treasury &&
        a.currentConfigVersion === b.currentConfigVersion && a.executable === b.executable &&
        a.royalties.length === b.royalties.length &&
        a.royalties.every((receiver, index) => receiver.account === b.royalties[index].account && receiver.amount === b.royalties[index].amount)
}

export function buildBuyWugnotMsg(listing: LaunchpadMarketListing, quote: LaunchpadMarketQuote,
    spend: WugnotSpend, now = Math.floor(Date.now() / 1000)): AminoMsg {
    const price = listing.price
    if (listing.currency !== WUGNOT_KEY || spend.currency !== WUGNOT_KEY || spend.spender !== MARKET_SPENDER ||
        !ADDRESS.test(spend.owner) || listing.status !== "active" || listing.expiresAt <= BigInt(now) ||
        listing.seller === spend.owner || !ADDRESS.test(listing.seller) || spend.balance < price || spend.allowance < price ||
        !quote.executable || quote.listing !== listing.id || quote.price !== price || quote.currency !== WUGNOT_KEY ||
        quote.currentConfigVersion < 1n || !ADDRESS.test(quote.treasury) ||
        quote.protocolAmount !== price * listing.protocolFeeBPS / 10_000n ||
        quote.royaltyTotal > price * listing.royaltyBPS / 10_000n ||
        quote.royalties.length > 10 || quote.royalties.some((receiver) => !ADDRESS.test(receiver.account) || receiver.amount < 0n) ||
        quote.royalties.reduce((sum, receiver) => sum + receiver.amount, 0n) !== quote.royaltyTotal ||
        quote.sellerAmount + quote.protocolAmount + quote.royaltyTotal !== price) throw new Error("WUGNOT purchase is not ready. Refresh its terms.")
    return { type: "vm/MsgCall", value: { caller: spend.owner, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "Buy", args: [listing.id, quote.currentConfigVersion.toString()], max_deposit: `${BUY_STORAGE_CAP}ugnot` } }
}

export function buyWugnotRequest(input: {
    listing: LaunchpadMarketListing; quote: LaunchpadMarketQuote; spend: WugnotSpend; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { listing, quote, spend, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildBuyWugnotMsg(listing, quote, spend)
    const scope = buyScope(chainId, spend.owner, listing.id)
    const label = `Buy ${listing.collection} #${listing.number.toString()} with wugnot`
    return {
        title: "Buy with WUGNOT", summary: `${listing.price.toLocaleString()} wugnot transfers from ${spend.owner}`,
        lines: () => [["NFT", `${listing.collection} #${listing.number.toString()}`],
            ["Total token price", `${listing.price.toLocaleString()} wugnot`], ["Seller", listing.seller],
            ["Seller receives", `${quote.sellerAmount.toLocaleString()} wugnot`],
            ["DAO receives", `${quote.protocolAmount.toLocaleString()} wugnot`],
            ["Creator royalties", `${quote.royaltyTotal.toLocaleString()} wugnot`],
            ["DAO treasury", quote.treasury],
            ...quote.royalties.map((receiver, index): [string, string] => [`Royalty ${index + 1}`, `${receiver.amount.toLocaleString()} wugnot → ${receiver.account}`]),
            ["Token balance", `${spend.balance.toLocaleString()} wugnot`],
            ["Market allowance", `${spend.allowance.toLocaleString()} wugnot`],
            ["Realm", LAUNCHPAD_MARKET_PATH], ["Network", chainId],
            ["Gas limit", BUY_WUGNOT_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${BUY_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["This call sends no native payment. The market pulls the exact WUGNOT price under your existing allowance and settles seller, DAO and creator credits atomically."],
        acks: ["I checked the price, token, NFT, recipients and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            const [freshQuote, freshSpend, ready] = await Promise.all([
                getLaunchpadMarketQuote(rpcUrl, fresh), readWugnotSpend(rpcUrl, spend.owner),
                isLaunchpadMarketPolicyReady(rpcUrl, WUGNOT_KEY),
            ])
            if (!sameListing(listing, fresh) || !sameQuote(quote, freshQuote) || !ready) throw new Error("Listing or payout terms changed. Refresh before signing.")
            buildBuyWugnotMsg(fresh, freshQuote, freshSpend)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: BUY_WUGNOT_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadMarketListing(rpcUrl, listing.id)
            return fresh.status === "filled" && sameListing({ ...listing, status: "filled" }, fresh) &&
                await getLaunchpadMarketTokenOwner(rpcUrl, listing.collection, listing.number) === spend.owner
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
