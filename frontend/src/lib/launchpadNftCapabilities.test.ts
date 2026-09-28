import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { LaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadNftCapabilities, parseLaunchpadNftCapabilities } from "./launchpadNftCapabilities"

const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`
const open = {
    schema: "launchpad-nft-capabilities/v1", collection: "C1", assetKind: "grc721", mode: "open",
    transferable: true, approvable: true, nativeMarketModeEligible: true,
    holderBurn: true, issuerRevoke: false, recipientClaimRequired: false,
    maxSupply: "10", minted: "2", metadataMode: "static_base", canReveal: false,
    metadataFrozen: true, profileFrozen: false, royaltyBPS: "500", royaltyScope: "native_market_only",
}
const collection = { id: "C1", mode: "open", revocable: false, maxSupply: 10n, royaltyBPS: 500n, metadataMode: "static_base" } as LaunchpadNftCollection

describe("versioned NFT capability reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("parses discoverable Open and Soulbound rights without implying a live sale", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValue(qeval(open))
        const result = await getLaunchpadNftCapabilities("rpc", collection)
        expect(result.royaltyBPS).toBe(500n)
        expect(result.nativeMarketModeEligible).toBe(true)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_NFT_PATH, 'CapabilitiesJSON("C1")', true)
        const soulbound = parseLaunchpadNftCapabilities({ ...open, mode: "soulbound", transferable: false, approvable: false, nativeMarketModeEligible: false, issuerRevoke: true, recipientClaimRequired: true, royaltyBPS: "0", royaltyScope: "none" })
        expect(soulbound.issuerRevoke).toBe(true)
        expect(soulbound.transferable).toBe(false)
    })

    it("rejects inconsistent mode rights, royalty scope and unknown schema fields", () => {
        expect(() => parseLaunchpadNftCapabilities({ ...open, transferable: false })).toThrow("Inconsistent")
        expect(() => parseLaunchpadNftCapabilities({ ...open, royaltyScope: "none" })).toThrow("Inconsistent")
        expect(() => parseLaunchpadNftCapabilities({ ...open, schema: "launchpad-nft-capabilities/v2" })).toThrow()
        expect(() => parseLaunchpadNftCapabilities({ ...open, arbitraryCall: true })).toThrow()
        expect(() => parseLaunchpadNftCapabilities({ ...open, minted: "1); Transfer(7" })).toThrow("Invalid capability")
        expect(() => parseLaunchpadNftCapabilities({ ...open, minted: "9999999999999999999" })).toThrow("Invalid capability")
    })

    it("binds capability facts to the selected collection and fails closed on missing RPC data", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval({ ...open, collection: "C2" })).mockResolvedValueOnce(null)
        await expect(getLaunchpadNftCapabilities("rpc", collection)).rejects.toThrow("does not match")
        await expect(getLaunchpadNftCapabilities("rpc", collection)).rejects.toThrow("Could not read")
        expect(query).toHaveBeenCalledTimes(2)
    })
})
