import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import { listLaunchpadNftCollections, parseLaunchpadNftCollection } from "./launchpadNft"

const row = {
    id: "C1", grc721Id: "1", creator: "g1creator", name: "Founders", symbol: "FND",
    description: "", image: "", banner: "", website: "", mode: "soulbound",
    revocable: true, tradable: false, maxSupply: "100", minted: "2", totalSupply: "1",
    configVersion: "1", profileFrozen: false, metadataMode: "static_base",
    revealed: true, metadataFrozen: true, placeholderURI: "",
    baseURICommitment: "a".repeat(64), provenanceHash: "", baseURI: "ipfs://metadata/",
}

const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

describe("Launchpad NFT reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("decodes the ledger's exact large-integer JSON without losing precision", async () => {
        const answer = { ...row, maxSupply: "9007199254740993" }
        vi.spyOn(shared, "queryEval").mockResolvedValue(qeval([answer]))
        const result = await listLaunchpadNftCollections("https://rpc.example", 0, 20)
        expect(result).toHaveLength(1)
        expect(result[0].maxSupply).toBe(9007199254740993n)
        expect(result[0].mode).toBe("soulbound")
        expect(shared.queryEval).toHaveBeenCalledWith("https://rpc.example", LAUNCHPAD_NFT_PATH, "ListCollectionsJSON(0, 20)", true)
    })

    it("distinguishes a genuine empty list from RPC and schema failures", async () => {
        const read = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval([])).mockResolvedValueOnce(null).mockResolvedValueOnce(qeval({}))
        await expect(listLaunchpadNftCollections("rpc")).resolves.toEqual([])
        await expect(listLaunchpadNftCollections("rpc")).rejects.toThrow("Could not read")
        await expect(listLaunchpadNftCollections("rpc")).rejects.toThrow("Invalid collection list")
        expect(read).toHaveBeenCalledTimes(3)
    })

    it("rejects inconsistent SoulBound transfer rules and impossible supply", () => {
        expect(() => parseLaunchpadNftCollection({ ...row, tradable: true })).toThrow("Inconsistent collection mode")
        expect(() => parseLaunchpadNftCollection({ ...row, minted: "101" })).toThrow("Inconsistent collection supply")
        expect(() => parseLaunchpadNftCollection({ ...row, totalSupply: 1 })).toThrow("Invalid total supply")
        expect(parseLaunchpadNftCollection({ ...row, maxSupply: "0" }).maxSupply).toBe(0n)
    })

    it("keeps hidden metadata distinct from a verified provenance claim", () => {
        const hidden = { ...row, metadataMode: "reveal_base", revealed: false, metadataFrozen: false,
            placeholderURI: "ipfs://placeholder/placeholder.json", provenanceHash: "b".repeat(64), baseURI: "" }
        expect(parseLaunchpadNftCollection(hidden)).toMatchObject({ revealed: false, metadataFrozen: false, provenanceHash: "b".repeat(64) })
        expect(() => parseLaunchpadNftCollection({ ...hidden, metadataFrozen: true })).toThrow("Inconsistent collection metadata")
        expect(() => parseLaunchpadNftCollection({ ...hidden, baseURI: "ipfs://unrevealed/" })).toThrow("Inconsistent collection metadata")
        expect(() => parseLaunchpadNftCollection({ ...hidden, provenanceHash: "not-a-hash" })).toThrow("Inconsistent collection metadata")
        expect(parseLaunchpadNftCollection({ ...hidden, revealed: true, baseURI: "ipfs://revealed/" }).baseURI).toBe("ipfs://revealed/")
    })
})
