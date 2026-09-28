/** Strict reads for the unpublished Launchpad NFT ledger. */
import { queryEval, parseQevalJSON } from "./dao/shared"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"

export type LaunchpadNftMode = "open" | "soulbound" | "royalty_protected"

export interface LaunchpadNftCollection {
    id: string
    grc721Id: string
    creator: string
    name: string
    symbol: string
    description: string
    image: string
    banner: string
    website: string
    mode: LaunchpadNftMode
    revocable: boolean
    tradable: boolean
    maxSupply: bigint
    minted: bigint
    totalSupply: bigint
    configVersion: bigint
    profileFrozen: boolean
    baseURI: string
}

const COLLECTION_KEYS = ["id", "grc721Id", "creator", "name", "symbol", "description", "image", "banner", "website", "mode", "revocable", "tradable", "maxSupply", "minted", "totalSupply", "configVersion", "profileFrozen", "baseURI"] as const

function record(value: unknown, what: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${what} response`)
    return value as Record<string, unknown>
}

function string(value: unknown, what: string): string {
    if (typeof value !== "string") throw new Error(`Invalid ${what} response`)
    return value
}

function decimal(value: unknown, what: string): bigint {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${what} response`)
    return BigInt(value)
}

function boolean(value: unknown, what: string): boolean {
    if (typeof value !== "boolean") throw new Error(`Invalid ${what} response`)
    return value
}

export function parseLaunchpadNftCollection(value: unknown): LaunchpadNftCollection {
    const row = record(value, "collection")
    if (Object.keys(row).sort().join("|") !== [...COLLECTION_KEYS].sort().join("|")) throw new Error("Invalid collection fields")
    const id = string(row.id, "collection ID")
    if (!/^C[1-9]\d*$/.test(id)) throw new Error("Invalid collection ID")
    const mode = string(row.mode, "collection mode")
    if (mode !== "open" && mode !== "soulbound" && mode !== "royalty_protected") throw new Error("Invalid collection mode")
    const revocable = boolean(row.revocable, "revocable")
    const tradable = boolean(row.tradable, "tradable")
    if (tradable !== (mode !== "soulbound") || (revocable && mode !== "soulbound")) throw new Error("Inconsistent collection mode")
    const maxSupply = decimal(row.maxSupply, "max supply")
    const minted = decimal(row.minted, "minted count")
    const totalSupply = decimal(row.totalSupply, "total supply")
    // Zero is the ledger's explicit uncapped open-edition sentinel.
    if ((maxSupply > 0n && minted > maxSupply) || totalSupply > minted) throw new Error("Inconsistent collection supply")
    return {
        id,
        grc721Id: string(row.grc721Id, "GRC721 ID"),
        creator: string(row.creator, "creator"),
        name: string(row.name, "name"),
        symbol: string(row.symbol, "symbol"),
        description: string(row.description, "description"),
        image: string(row.image, "image"),
        banner: string(row.banner, "banner"),
        website: string(row.website, "website"),
        mode,
        revocable,
        tradable,
        maxSupply,
        minted,
        totalSupply,
        configVersion: decimal(row.configVersion, "config version"),
        profileFrozen: boolean(row.profileFrozen, "profile frozen"),
        baseURI: string(row.baseURI, "base URI"),
    }
}

/** A missing or malformed RPC answer is an error, never an empty marketplace. */
export async function listLaunchpadNftCollections(rpcUrl: string, page = 0, size = 20): Promise<LaunchpadNftCollection[]> {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error("Invalid collection page")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_NFT_PATH, `ListCollectionsJSON(${page}, ${size})`, true)
    if (raw === null) throw new Error("Could not read Launchpad NFT collections")
    const payload = parseQevalJSON(raw)
    if (!Array.isArray(payload) || payload.length > size) throw new Error("Invalid collection list response")
    const collections = payload.map(parseLaunchpadNftCollection)
    if (new Set(collections.map((item) => item.id)).size !== collections.length) throw new Error("Duplicate collection ID")
    return collections
}
