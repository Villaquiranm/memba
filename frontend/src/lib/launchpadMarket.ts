/** Strict reads for the unpublished Launchpad fixed-price NFT market. */
import { queryEval, parseQevalJSON } from "./dao/shared"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "./nftConfig"

const MAX_INT64 = 9223372036854775807n
const LISTING_KEYS = ["id", "collection", "number", "seller", "price", "currency", "expiresAt", "createdAt", "configVersion", "protocolFeeBPS", "royaltyBPS", "status"] as const
const QUOTE_KEYS = ["listing", "price", "currency", "sellerAmount", "protocolAmount", "royaltyTotal", "treasury", "currentConfigVersion", "executable", "royalties"] as const
const OFFER_KEYS = ["id", "collection", "number", "buyer", "price", "currency", "expiresAt", "createdAt", "configVersion", "protocolFeeBPS", "royaltyBPS", "status"] as const
const OFFER_QUOTE_KEYS = ["offer", "price", "currency", "sellerAmount", "protocolAmount", "royaltyTotal", "treasury", "currentConfigVersion", "executable", "royalties"] as const

export type LaunchpadMarketStatus = "active" | "replaced" | "cancelled" | "filled"

export interface LaunchpadMarketListing {
    id: string
    collection: string
    number: bigint
    seller: string
    price: bigint
    currency: string
    expiresAt: bigint
    createdAt: bigint
    configVersion: bigint
    protocolFeeBPS: bigint
    royaltyBPS: bigint
    status: LaunchpadMarketStatus
}

export interface LaunchpadMarketQuote {
    listing: string
    price: bigint
    currency: string
    sellerAmount: bigint
    protocolAmount: bigint
    royaltyTotal: bigint
    treasury: string
    currentConfigVersion: bigint
    executable: boolean
    royalties: { account: string; amount: bigint }[]
}

export type LaunchpadOfferStatus = "active" | "cancelled" | "expired" | "accepted"
export interface LaunchpadMarketOffer extends Omit<LaunchpadMarketListing, "seller" | "status"> {
    buyer: string
    status: LaunchpadOfferStatus
}
export interface LaunchpadOfferQuote extends Omit<LaunchpadMarketQuote, "listing"> { offer: string }

function row(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} response`)
    const result = value as Record<string, unknown>
    if (Object.keys(result).sort().join("|") !== [...keys].sort().join("|")) throw new Error(`Invalid ${label} fields`)
    return result
}

function text(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`)
    return value
}

function amount(value: unknown, label: string): bigint {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`)
    const n = BigInt(value)
    if (n > MAX_INT64) throw new Error(`Invalid ${label}`)
    return n
}

function listingId(value: unknown): string {
    const id = text(value, "listing ID")
    if (!/^L[1-9]\d*$/.test(id)) throw new Error("Invalid listing ID")
    return id
}

function offerId(value: unknown): string {
    const id = text(value, "offer ID")
    if (!/^O[1-9]\d*$/.test(id)) throw new Error("Invalid offer ID")
    return id
}

export function parseLaunchpadMarketListing(value: unknown): LaunchpadMarketListing {
    const item = row(value, LISTING_KEYS, "listing")
    const collection = text(item.collection, "collection ID")
    if (!/^C[1-9]\d*$/.test(collection)) throw new Error("Invalid collection ID")
    const status = text(item.status, "listing status")
    if (status !== "active" && status !== "replaced" && status !== "cancelled" && status !== "filled") throw new Error("Invalid listing status")
    const number = amount(item.number, "token number")
    const price = amount(item.price, "listing price")
    const createdAt = amount(item.createdAt, "creation time")
    const expiresAt = amount(item.expiresAt, "expiry")
    const protocolFeeBPS = amount(item.protocolFeeBPS, "protocol fee")
    const royaltyBPS = amount(item.royaltyBPS, "royalty rate")
    if (number === 0n || price === 0n || createdAt === 0n || expiresAt <= createdAt ||
        protocolFeeBPS > 200n || royaltyBPS > 1000n) throw new Error("Inconsistent listing terms")
    return {
        id: listingId(item.id), collection, number,
        seller: text(item.seller, "seller"), price,
        currency: text(item.currency, "currency"), expiresAt, createdAt,
        configVersion: amount(item.configVersion, "config version"),
        protocolFeeBPS, royaltyBPS, status,
    }
}

export function parseLaunchpadMarketQuote(value: unknown, listing: LaunchpadMarketListing): LaunchpadMarketQuote {
    const quote = row(value, QUOTE_KEYS, "quote")
    const id = listingId(quote.listing)
    const price = amount(quote.price, "quoted price")
    const currency = text(quote.currency, "quoted currency")
    const sellerAmount = amount(quote.sellerAmount, "seller amount")
    const protocolAmount = amount(quote.protocolAmount, "protocol amount")
    const royaltyTotal = amount(quote.royaltyTotal, "royalty total")
    const currentConfigVersion = amount(quote.currentConfigVersion, "current config version")
    if (typeof quote.executable !== "boolean" || !Array.isArray(quote.royalties) || quote.royalties.length > 10) throw new Error("Invalid quote terms")
    const royalties = quote.royalties.map((value: unknown) => {
        const receiver = row(value, ["account", "amount"], "royalty payout")
        return { account: text(receiver.account, "royalty receiver"), amount: amount(receiver.amount, "royalty amount") }
    })
    if (id !== listing.id || price !== listing.price || currency !== listing.currency ||
        protocolAmount !== price * listing.protocolFeeBPS / 10000n ||
        royaltyTotal > price * listing.royaltyBPS / 10000n ||
        sellerAmount + protocolAmount + royaltyTotal !== price ||
        royalties.reduce((sum, receiver) => sum + receiver.amount, 0n) !== royaltyTotal ||
        (quote.executable && listing.status !== "active")) {
        throw new Error("Inconsistent market quote")
    }
    return { listing: id, price, currency, sellerAmount, protocolAmount, royaltyTotal,
        treasury: text(quote.treasury, "treasury"), currentConfigVersion,
        executable: quote.executable, royalties }
}

/** A missing or malformed RPC answer is an error, never an empty market. */
export async function listLaunchpadMarketListings(rpcUrl: string, page = 0, size = 20): Promise<LaunchpadMarketListing[]> {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error("Invalid listing page")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `ListListingsJSON(${page}, ${size})`, true)
    if (raw === null) throw new Error("Could not read Launchpad market")
    const payload = parseQevalJSON(raw)
    if (!Array.isArray(payload) || payload.length > size) throw new Error("Invalid listing list response")
    const listings = payload.map(parseLaunchpadMarketListing)
    if (new Set(listings.map((item) => item.id)).size !== listings.length) throw new Error("Duplicate listing ID")
    return listings
}

export async function getLaunchpadMarketQuote(rpcUrl: string, listing: LaunchpadMarketListing): Promise<LaunchpadMarketQuote> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `QuoteJSON(${JSON.stringify(listing.id)})`, true)
    if (raw === null) throw new Error("Could not read Launchpad market quote")
    return parseLaunchpadMarketQuote(parseQevalJSON(raw), listing)
}

/** Mirrors config.AssertNewAction's read-only pause, allowlist and term checks. */
export async function isLaunchpadMarketPolicyReady(rpcUrl: string, currency: string): Promise<boolean> {
    if (currency.length === 0 || currency.length > 200) throw new Error("Invalid market currency")
    const queries = [
        `IsPaused("nft_market")`,
        `IsCurrencyAllowed(${JSON.stringify(currency)})`,
        `IsLaneReady("nft_market", ${JSON.stringify(currency)})`,
    ]
    const values = await Promise.all(queries.map(async (expr) => {
        const raw = await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, expr, true)
        if (raw?.trim() === "(true bool)") return true
        if (raw?.trim() === "(false bool)") return false
        throw new Error("Could not verify Launchpad trading policy")
    }))
    return !values[0] && values[1] && values[2]
}

/** Read one record afresh before signing or reconciling a wallet outcome. */
export async function getLaunchpadMarketListing(rpcUrl: string, id: string): Promise<LaunchpadMarketListing> {
    const checkedId = listingId(id)
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `ListingJSON(${JSON.stringify(checkedId)})`, true)
    if (raw === null) throw new Error("Could not read Launchpad listing")
    const listing = parseLaunchpadMarketListing(parseQevalJSON(raw))
    if (listing.id !== checkedId) throw new Error("Listing identity changed")
    return listing
}

/** A filled listing alone does not prove which wallet bought the token. */
export async function getLaunchpadMarketTokenOwner(rpcUrl: string, collection: string, number: bigint): Promise<string | null> {
    if (!/^C[1-9]\d*$/.test(collection) || number < 1n || number > MAX_INT64) throw new Error("Invalid token identity")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_NFT_PATH, `TokenJSON(${JSON.stringify(collection)}, ${number.toString()})`, true)
    if (raw === null) throw new Error("Could not read Launchpad token")
    const token = row(parseQevalJSON(raw), ["collection", "number", "owner", "status", "uri", "soulbound"], "token")
    if (token.collection !== collection || amount(token.number, "token number") !== number ||
        token.soulbound !== false || typeof token.uri !== "string" || token.status !== "active") return null
    const owner = text(token.owner, "token owner")
    if (!/^g1[02-9ac-hj-np-z]{38}$/.test(owner)) throw new Error("Invalid token owner")
    return owner
}

export function parseLaunchpadMarketOffer(value: unknown): LaunchpadMarketOffer {
    const item = row(value, OFFER_KEYS, "offer")
    const collection = text(item.collection, "collection ID")
    if (!/^C[1-9]\d*$/.test(collection)) throw new Error("Invalid collection ID")
    const status = text(item.status, "offer status")
    if (status !== "active" && status !== "cancelled" && status !== "expired" && status !== "accepted") throw new Error("Invalid offer status")
    const number = amount(item.number, "token number")
    const price = amount(item.price, "offer price")
    const createdAt = amount(item.createdAt, "creation time")
    const expiresAt = amount(item.expiresAt, "expiry")
    const protocolFeeBPS = amount(item.protocolFeeBPS, "protocol fee")
    const royaltyBPS = amount(item.royaltyBPS, "royalty rate")
    if (number === 0n || price === 0n || createdAt === 0n || expiresAt <= createdAt ||
        protocolFeeBPS > 200n || royaltyBPS > 1000n) throw new Error("Inconsistent offer terms")
    return { id: offerId(item.id), collection, number, buyer: text(item.buyer, "buyer"),
        price, currency: text(item.currency, "currency"), expiresAt, createdAt,
        configVersion: amount(item.configVersion, "config version"), protocolFeeBPS, royaltyBPS, status }
}

export function parseLaunchpadOfferQuote(value: unknown, offer: LaunchpadMarketOffer): LaunchpadOfferQuote {
    const quote = row(value, OFFER_QUOTE_KEYS, "offer quote")
    const id = offerId(quote.offer)
    const price = amount(quote.price, "quoted price")
    const currency = text(quote.currency, "quoted currency")
    const sellerAmount = amount(quote.sellerAmount, "seller amount")
    const protocolAmount = amount(quote.protocolAmount, "protocol amount")
    const royaltyTotal = amount(quote.royaltyTotal, "royalty total")
    const currentConfigVersion = amount(quote.currentConfigVersion, "current config version")
    if (typeof quote.executable !== "boolean" || !Array.isArray(quote.royalties) || quote.royalties.length > 10) throw new Error("Invalid offer quote terms")
    const royalties = quote.royalties.map((value: unknown) => {
        const receiver = row(value, ["account", "amount"], "royalty payout")
        return { account: text(receiver.account, "royalty receiver"), amount: amount(receiver.amount, "royalty amount") }
    })
    if (id !== offer.id || price !== offer.price || currency !== offer.currency ||
        protocolAmount !== price * offer.protocolFeeBPS / 10000n ||
        royaltyTotal > price * offer.royaltyBPS / 10000n ||
        sellerAmount + protocolAmount + royaltyTotal !== price ||
        royalties.reduce((sum, receiver) => sum + receiver.amount, 0n) !== royaltyTotal ||
        (quote.executable && offer.status !== "active")) throw new Error("Inconsistent offer quote")
    return { offer: id, price, currency, sellerAmount, protocolAmount, royaltyTotal,
        treasury: text(quote.treasury, "treasury"), currentConfigVersion,
        executable: quote.executable, royalties }
}

export async function listLaunchpadMarketOffers(rpcUrl: string, page = 0, size = 20): Promise<LaunchpadMarketOffer[]> {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error("Invalid offer page")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `ListOffersJSON(${page}, ${size})`, true)
    if (raw === null) throw new Error("Could not read Launchpad offers")
    const payload = parseQevalJSON(raw)
    if (!Array.isArray(payload) || payload.length > size) throw new Error("Invalid offer list response")
    const offers = payload.map(parseLaunchpadMarketOffer)
    if (new Set(offers.map((item) => item.id)).size !== offers.length) throw new Error("Duplicate offer ID")
    return offers
}

export async function getLaunchpadOfferQuote(rpcUrl: string, offer: LaunchpadMarketOffer): Promise<LaunchpadOfferQuote> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, `OfferQuoteJSON(${JSON.stringify(offer.id)})`, true)
    if (raw === null) throw new Error("Could not read Launchpad offer quote")
    return parseLaunchpadOfferQuote(parseQevalJSON(raw), offer)
}
