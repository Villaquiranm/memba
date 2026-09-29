/** Reviewed native or WUGNOT listing and exact-token approval for Launchpad NFTs. */
import { parseQevalJSON, queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { packageAddress } from "./dao/weightedApplications"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadMarketListing, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady } from "./launchpadMarket"
import { WUGNOT_KEY } from "./launchpadTokenTrade"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
const MAX_INT64 = 9223372036854775807n
const MAX_LISTING_AGE = 90n * 24n * 60n * 60n
export const LIST_GAS_WANTED = 50_000_000
export const APPROVE_GAS_WANTED = 50_000_000
const LIST_STORAGE_CAP = 5_000_000
const APPROVE_STORAGE_CAP = 1_000_000
export const MARKET_OPERATOR = packageAddress(LAUNCHPAD_MARKET_PATH)

function qString(raw: string | null): string {
    const match = /^\(("(?:[^"\\]|\\.)*") string\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify Launchpad chain data")
    const value: unknown = JSON.parse(match[1])
    if (typeof value !== "string") throw new Error("Could not verify Launchpad chain data")
    return value
}

function qInt(raw: string | null): bigint {
    const match = /^\((0|[1-9]\d*) int64\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify Launchpad chain data")
    return BigInt(match[1])
}

function tokenIdentity(collection: string, number: bigint): void {
    if (!/^C[1-9]\d*$/.test(collection) || number < 1n || number > MAX_INT64) throw new Error("Invalid token identity")
}

export function parseGnotPrice(text: string): bigint {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error("Enter a GNOT price with at most six decimals.")
    const [whole, fraction = ""] = text.split(".")
    const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0")
    if (amount < 1n || amount > MAX_INT64) throw new Error("Price is outside the supported range.")
    return amount
}

export function formatGnotPrice(ugnot: bigint): string {
    const whole = ugnot / 1_000_000n
    const fraction = (ugnot % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
    return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} GNOT`
}

export type ListingCurrency = "ugnot" | typeof WUGNOT_KEY

export function parseWugnotPrice(text: string): bigint {
    if (!/^[1-9]\d*$/.test(text)) throw new Error("Enter a whole-number WUGNOT price.")
    const amount = BigInt(text)
    if (amount > MAX_INT64) throw new Error("Price is outside the supported range.")
    return amount
}

function displayPrice(price: bigint, currency: ListingCurrency): string {
    return currency === "ugnot" ? formatGnotPrice(price) : `${price.toLocaleString()} WUGNOT`
}

export interface ListingReadiness {
    collection: LaunchpadNftCollection
    number: bigint
    owner: string
    approved: boolean
    approvalScope: "token" | "collection" | "none"
    currentListingID: string
    configVersion: bigint
    feeBPS: bigint
    policyReady: boolean
    currency: ListingCurrency
}

/** Reads every prerequisite from chain. A stale config read is rejected. */
export async function readListingReadiness(rpcUrl: string, collectionID: string, number: bigint, owner: string,
    currency: ListingCurrency = "ugnot"): Promise<ListingReadiness> {
    tokenIdentity(collectionID, number)
    if (!ADDRESS.test(owner)) throw new Error("Connect a valid seller wallet.")
    const version = qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true))
    if (version < 1n || version > MAX_INT64) throw new Error("Market policy is unavailable.")
    const [collection, tokenOwner, approvalRaw, currentListingID, feeBPS, policyReady] = await Promise.all([
        getLaunchpadNftCollection(rpcUrl, collectionID),
        getLaunchpadMarketTokenOwner(rpcUrl, collectionID, number),
        queryEval(rpcUrl, LAUNCHPAD_NFT_PATH, `MarketApprovalJSON(${JSON.stringify(collectionID)}, ${number.toString()})`, true),
        queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `CurrentListingID(${JSON.stringify(collectionID)}, ${number.toString()})`, true).then(qString),
        queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, `GetVersion(${version.toString()}).NFTSecondaryFeeBPS`, true).then(qInt),
        isLaunchpadMarketPolicyReady(rpcUrl, currency),
    ])
    if (qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true)) !== version) throw new Error("Market policy changed. Refresh before listing.")
    if (collection.mode !== "open" || !collection.tradable || tokenOwner !== owner) throw new Error("This Open NFT is not owned by the connected wallet.")
    if (collection.royalties.some((receiver) => !ADDRESS.test(receiver.account))) throw new Error("Invalid royalty receiver")
    if (approvalRaw === null) throw new Error("Could not verify token approval")
    const approval = parseQevalJSON(approvalRaw)
    if (approval === null || typeof approval !== "object" || Array.isArray(approval) ||
        Object.keys(approval).sort().join("|") !== "collection|collectionApproved|number|operator|owner|tokenApproved") throw new Error("Invalid token approval")
    const record = approval as Record<string, unknown>
    if (record.collection !== collectionID || record.number !== number.toString() || record.owner !== owner ||
        record.operator !== MARKET_OPERATOR || typeof record.tokenApproved !== "boolean" ||
        typeof record.collectionApproved !== "boolean") throw new Error("Token approval changed")
    if (currentListingID !== "" && !/^L[1-9]\d*$/.test(currentListingID)) throw new Error("Invalid current listing")
    if (feeBPS > 200n) throw new Error("Invalid market fee")
    const approvalScope = record.collectionApproved ? "collection" : record.tokenApproved ? "token" : "none"
    return { collection, number, owner, approved: approvalScope !== "none", approvalScope,
        currentListingID, configVersion: version, feeBPS, policyReady, currency }
}

function listingScope(chainId: string, caller: string, collection: string, number: bigint, operation: string): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller, operation: `${operation}:${collection}#${number.toString()}` }
}

export function approveListingScope(chainId: string, caller: string, collection: string, number: bigint): GovernanceScope {
    return listingScope(chainId, caller, collection, number, "approve-token")
}

export function createListingScope(chainId: string, caller: string, collection: string, number: bigint): GovernanceScope {
    return listingScope(chainId, caller, collection, number, "list-token")
}

export function buildApproveListingMsg(readiness: ListingReadiness): AminoMsg {
    if (readiness.approved || readiness.collection.mode !== "open" || !ADDRESS.test(readiness.owner)) throw new Error("Token approval is not needed or is unavailable.")
    return { type: "vm/MsgCall", value: { caller: readiness.owner, send: "", pkg_path: LAUNCHPAD_NFT_PATH,
        func: "Approve", args: [readiness.collection.id, MARKET_OPERATOR, readiness.number.toString()],
        max_deposit: `${APPROVE_STORAGE_CAP}ugnot` } }
}

function sameReadiness(a: ListingReadiness, b: ListingReadiness): boolean {
    return a.collection.id === b.collection.id && a.collection.mode === b.collection.mode &&
        a.collection.royaltyBPS === b.collection.royaltyBPS && a.number === b.number &&
        a.collection.royalties.length === b.collection.royalties.length &&
        a.collection.royalties.every((receiver, index) => receiver.account === b.collection.royalties[index].account && receiver.bps === b.collection.royalties[index].bps) &&
        a.owner === b.owner && a.configVersion === b.configVersion && a.feeBPS === b.feeBPS && a.currency === b.currency &&
        a.currentListingID === b.currentListingID && a.policyReady === b.policyReady
}

export function approveListingRequest(input: {
    readiness: ListingReadiness; rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { readiness, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildApproveListingMsg(readiness)
    const id = readiness.collection.id
    const scope = approveListingScope(chainId, readiness.owner, id, readiness.number)
    const label = `Approve ${id} #${readiness.number.toString()}`
    return {
        title: "Approve one NFT", summary: `Allow Market to transfer ${id} #${readiness.number.toString()} for a sale`,
        lines: () => [["Token", `${id} #${readiness.number.toString()}`], ["Operator", MARKET_OPERATOR],
            ["Approval scope", "This token only"], ["Network", chainId],
            ["Gas limit", APPROVE_GAS_WANTED.toLocaleString()], ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${APPROVE_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Approval permits the exact market realm to transfer this token. You still choose whether to list it."],
        acks: ["I checked the token, operator and chain before opening Adena."], label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readListingReadiness(rpcUrl, id, readiness.number, readiness.owner, readiness.currency)
            if (!sameReadiness(readiness, fresh) || fresh.approved) throw new Error("Token or market terms changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label, { gasWanted: APPROVE_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => (await readListingReadiness(rpcUrl, id, readiness.number, readiness.owner, readiness.currency)).approved,
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}

export function buildCreateListingMsg(readiness: ListingReadiness, price: bigint, expiresAt: bigint, now: bigint): AminoMsg {
    if (!readiness.approved || !readiness.policyReady || (readiness.currency !== "ugnot" && readiness.currency !== WUGNOT_KEY) ||
        price < 1n || price > MAX_INT64 || expiresAt <= now || expiresAt > now + MAX_LISTING_AGE ||
        readiness.feeBPS > 200n || readiness.configVersion < 1n) throw new Error("This token is not ready to list. Refresh its terms.")
    return { type: "vm/MsgCall", value: { caller: readiness.owner, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "List", args: [readiness.collection.id, readiness.number.toString(), price.toString(),
            expiresAt.toString(), readiness.currency, readiness.configVersion.toString()],
        max_deposit: `${LIST_STORAGE_CAP}ugnot` } }
}

export function createListingRequest(input: {
    readiness: ListingReadiness; price: bigint; expiresAt: bigint; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { readiness, price, expiresAt, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildCreateListingMsg(readiness, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
    const id = readiness.collection.id
    const number = readiness.number
    const scope = createListingScope(chainId, readiness.owner, id, number)
    const label = `List ${id} #${number.toString()}`
    const protocolAmount = price * readiness.feeBPS / 10_000n
    const royalties = readiness.collection.royalties.map((receiver) => ({ account: receiver.account, amount: price * receiver.bps / 10_000n }))
    const royaltyTotal = royalties.reduce((sum, receiver) => sum + receiver.amount, 0n)
    return {
        title: "List collectible", summary: `${label} for ${displayPrice(price, readiness.currency)}`,
        lines: () => [["Token", `${id} #${number.toString()}`], ["Buyer price", `${displayPrice(price, readiness.currency)} (${price.toLocaleString()} ${readiness.currency === "ugnot" ? "ugnot" : "wugnot"})`],
            ["Seller receives", `${(price - protocolAmount - royaltyTotal).toLocaleString()} ${readiness.currency === "ugnot" ? "ugnot" : "wugnot"}`],
            ["DAO fee", `${protocolAmount.toLocaleString()} ${readiness.currency === "ugnot" ? "ugnot" : "wugnot"} (${readiness.feeBPS.toString()} bps)`],
            ["Creator royalties", `${royaltyTotal.toLocaleString()} ${readiness.currency === "ugnot" ? "ugnot" : "wugnot"}`],
            ...royalties.map((r, i): [string, string] => [`Royalty ${i + 1}`, `${r.amount.toLocaleString()} ${readiness.currency === "ugnot" ? "ugnot" : "wugnot"} → ${r.account}`]),
            ["Expiry", new Date(Number(expiresAt) * 1000).toISOString()], ["Realm", LAUNCHPAD_MARKET_PATH],
            ["Network", chainId], ["Gas limit", LIST_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${LIST_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The approved market can transfer this NFT when a buyer pays. You can cancel while the listing remains active, including during a market pause.",
            ...(readiness.currentListingID ? [`This replaces existing listing ${readiness.currentListingID}.`] : [])],
        acks: ["I checked the price, payout terms, expiry and chain before opening Adena.",
            ...(readiness.currentListingID ? ["I understand this replaces the existing listing."] : [])],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readListingReadiness(rpcUrl, id, number, readiness.owner, readiness.currency)
            if (!sameReadiness(readiness, fresh) || !fresh.approved) throw new Error("Token or market terms changed. Refresh before signing.")
            buildCreateListingMsg(fresh, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label, { gasWanted: LIST_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `CurrentListingID(${JSON.stringify(id)}, ${number.toString()})`, true)
            const listingID = qString(raw)
            if (!/^L[1-9]\d*$/.test(listingID)) return false
            const listing = await getLaunchpadMarketListing(rpcUrl, listingID)
            return listing.status === "active" && listing.collection === id && listing.number === number &&
                listing.seller === readiness.owner && listing.price === price && listing.currency === readiness.currency &&
                listing.expiresAt === expiresAt && listing.configVersion === readiness.configVersion &&
                listing.protocolFeeBPS === readiness.feeBPS && listing.royaltyBPS === readiness.collection.royaltyBPS
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
