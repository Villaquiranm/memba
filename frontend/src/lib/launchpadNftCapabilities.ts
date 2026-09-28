/** Strict, versioned collection rights read. A capability is not a live sale quote. */
import { z } from "zod"
import { parseQevalJSON, queryEval } from "./dao/shared"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { LaunchpadNftCollection } from "./launchpadNft"

const schema = z.strictObject({
    schema: z.literal("launchpad-nft-capabilities/v1"),
    collection: z.string().regex(/^C[1-9][0-9]*$/), assetKind: z.literal("grc721"),
    mode: z.enum(["open", "soulbound", "royalty_protected"]),
    transferable: z.boolean(), approvable: z.boolean(), nativeMarketModeEligible: z.boolean(),
    holderBurn: z.literal(true), issuerRevoke: z.boolean(), recipientClaimRequired: z.boolean(),
    maxSupply: z.string(), minted: z.string(), metadataMode: z.enum(["static_base", "reveal_base"]),
    canReveal: z.boolean(), metadataFrozen: z.boolean(), profileFrozen: z.boolean(),
    royaltyBPS: z.string(), royaltyScope: z.enum(["none", "native_market_only"]),
})

export type LaunchpadNftCapabilities = Omit<z.infer<typeof schema>, "maxSupply" | "minted" | "royaltyBPS"> & {
    maxSupply: bigint; minted: bigint; royaltyBPS: bigint
}

function decimal(value: string, label: string): bigint {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error(`Invalid capability ${label}`)
    return BigInt(value)
}

export function parseLaunchpadNftCapabilities(value: unknown): LaunchpadNftCapabilities {
    const row = schema.parse(value)
    const maxSupply = decimal(row.maxSupply, "max supply")
    const minted = decimal(row.minted, "minted count")
    const royaltyBPS = decimal(row.royaltyBPS, "royalty bps")
    const soulbound = row.mode === "soulbound"
    if (maxSupply > 0n && minted > maxSupply || royaltyBPS > 1000n ||
        row.transferable === soulbound || row.approvable === soulbound ||
        row.nativeMarketModeEligible !== (row.mode === "open") ||
        row.recipientClaimRequired !== soulbound || row.issuerRevoke && !soulbound ||
        row.metadataMode === "static_base" && (row.canReveal || !row.metadataFrozen) ||
        row.canReveal && row.metadataFrozen ||
        (royaltyBPS > 0n ? row.royaltyScope !== "native_market_only" : row.royaltyScope !== "none") ||
        soulbound && royaltyBPS !== 0n) throw new Error("Inconsistent NFT capability record")
    return { ...row, maxSupply, minted, royaltyBPS }
}

export async function getLaunchpadNftCapabilities(rpcUrl: string, collection: LaunchpadNftCollection): Promise<LaunchpadNftCapabilities> {
    if (!/^C[1-9][0-9]*$/.test(collection.id)) throw new Error("Invalid collection ID")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_NFT_PATH, `CapabilitiesJSON(${JSON.stringify(collection.id)})`, true)
    if (raw === null) throw new Error("Could not read NFT capabilities")
    const result = parseLaunchpadNftCapabilities(parseQevalJSON(raw))
    if (result.collection !== collection.id || result.mode !== collection.mode || result.issuerRevoke !== collection.revocable ||
        result.maxSupply !== collection.maxSupply || result.royaltyBPS !== collection.royaltyBPS || result.metadataMode !== collection.metadataMode) {
        throw new Error("NFT capability record does not match collection")
    }
    return result
}
